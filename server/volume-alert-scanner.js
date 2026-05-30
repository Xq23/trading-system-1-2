import {
  BASELINE_BARS,
  FOUR_H_MS,
  SCAN_AFTER_CLOSE_MS,
  evaluateVolumeAlertsForTrigger,
  getLatestClosed4hOpenTime,
  getNext4hCloseMs,
  listPendingTriggerTimes,
  listTodayClosedTriggers,
  makeSymbolKey,
} from "./volume-alert-engine.js";
import {
  clearAllVolumeAlerts,
  getSystemMeta,
  insertVolumeAlerts,
  isVolumeAlertScanDone,
  logVolumeAlertScan,
  setSystemMeta,
} from "./db.js";

const KLINE_LIMIT = 80;
const SCAN_CONCURRENCY = 5;
const SYMBOL_GAP_MS = 50;
const CHECK_INTERVAL_MS = 60_000;
const MAX_BACKFILL_TRIGGERS = 42;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 2;
const EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";

let scanning = false;
let checkTimer = null;
let symbolCache = { symbols: [], fetchedAt: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isTradableUsdtPerpetual(item) {
  if (!item?.symbol || item?.status !== "TRADING") return false;
  const ct = String(item.contractType || "");
  const perpetualLike =
    ct === "PERPETUAL" || ct === "TRADFI_PERPETUAL" || ct.endsWith("_PERPETUAL");
  if (!perpetualLike) return false;
  const quote = String(item.quoteAsset || "").toUpperCase();
  if (quote) return quote === "USDT";
  return String(item.symbol).toUpperCase().endsWith("USDT");
}

async function listUsdtPerpetualSymbols() {
  const now = Date.now();
  if (symbolCache.symbols.length && now - symbolCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return symbolCache.symbols;
  }
  const info = await fetchJson(EXCHANGE_INFO_URL);
  const symbols = (info?.symbols || [])
    .filter(isTradableUsdtPerpetual)
    .map((item) => String(item.symbol).toUpperCase())
    .filter((sym) => sym.endsWith("USDT"))
    .sort((a, b) => a.localeCompare(b));
  symbolCache = { symbols, fetchedAt: now };
  return symbols;
}

async function fetch4hKlines(exchangeSymbol) {
  const symbol = makeSymbolKey(exchangeSymbol);
  const url =
    "https://fapi.binance.com/fapi/v1/klines?" +
    `symbol=${encodeURIComponent(symbol)}&interval=4h&limit=${KLINE_LIMIT}`;
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const raw = await fetchJson(url);
      if (!Array.isArray(raw) || raw.length < BASELINE_BARS + 1) throw new Error("空数据");
      return raw;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError || new Error("K线请求失败");
}

async function runPool(items, worker, concurrency) {
  let index = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      try {
        await worker(items[i]);
      } catch (err) {
        console.warn(`[volume-alert] ${items[i]} 扫描失败`, err?.message || err);
      }
    }
  });
  await Promise.all(runners);
}

async function scanTriggerBatch(triggerOpenTime, symbols) {
  const found = [];
  await runPool(
    symbols,
    async (exchangeSymbol) => {
      await sleep(SYMBOL_GAP_MS);
      const klines = await fetch4hKlines(exchangeSymbol);
      const alerts = evaluateVolumeAlertsForTrigger(exchangeSymbol, klines, triggerOpenTime);
      found.push(...alerts);
    },
    SCAN_CONCURRENCY
  );
  const scannedAt = Date.now();
  const inserted = insertVolumeAlerts(found, scannedAt);
  logVolumeAlertScan({
    triggerCandleOpenTime: triggerOpenTime,
    scannedAt,
    symbolCount: symbols.length,
    alertCount: found.length,
    inserted,
  });
  setSystemMeta("volume_alert_last_trigger", String(triggerOpenTime));
  console.log(
    `[volume-alert] 完成 ${new Date(triggerOpenTime).toISOString()} · 扫描 ${symbols.length} · 触发 ${found.length} · 新增 ${inserted}`
  );
  return { triggerOpenTime, alertCount: found.length, inserted };
}

async function runPendingScans() {
  if (scanning) return;
  const now = Date.now();
  const closeBoundary = Math.floor(now / FOUR_H_MS) * FOUR_H_MS;
  if (now - closeBoundary < SCAN_AFTER_CLOSE_MS) return;

  scanning = true;
  try {
    const latestClosed = getLatestClosed4hOpenTime(now);
    const lastRaw = getSystemMeta("volume_alert_last_trigger");
    const lastProcessed = lastRaw != null ? Number(lastRaw) : null;
    let pending = listPendingTriggerTimes(lastProcessed, now);
    pending = pending.filter((t) => !isVolumeAlertScanDone(t));
    if (pending.length > MAX_BACKFILL_TRIGGERS) {
      pending = pending.slice(-MAX_BACKFILL_TRIGGERS);
    }
    if (!pending.length) return;

    const symbols = await listUsdtPerpetualSymbols();
    if (!symbols.length) {
      console.warn("[volume-alert] 无可用 USDT 永续列表");
      return;
    }

    for (const triggerOpenTime of pending) {
      if (triggerOpenTime > latestClosed) continue;
      await scanTriggerBatch(triggerOpenTime, symbols);
    }
  } catch (err) {
    console.error("[volume-alert] 扫描失败", err);
  } finally {
    scanning = false;
  }
}

export function startVolumeAlertScheduler() {
  if (checkTimer) return;
  console.log("[volume-alert] 服务端定时检测已启动（每 4h 收线 + 遗漏补扫）");
  checkTimer = setInterval(() => {
    void runPendingScans();
  }, CHECK_INTERVAL_MS);
  void runPendingScans();
}

export function stopVolumeAlertScheduler() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

export function isVolumeAlertScanning() {
  return scanning;
}

export async function runVolumeAlertScanNow() {
  await runPendingScans();
}

/** 指定 4h 批次（开盘 UTC 毫秒时间戳）检测 */
export async function runVolumeAlertScanTriggers(triggerOpenTimes, { force = false } = {}) {
  const triggers = [...new Set((Array.isArray(triggerOpenTimes) ? triggerOpenTimes : [triggerOpenTimes])
    .map(Number)
    .filter(Number.isFinite))].sort((a, b) => a - b);
  if (!triggers.length) throw new Error("triggerOpenTime 无效");

  while (scanning) await sleep(1000);
  scanning = true;
  try {
    const symbols = await listUsdtPerpetualSymbols();
    if (!symbols.length) throw new Error("无可用 USDT 永续列表");

    const results = [];
    for (const triggerOpenTime of triggers) {
      if (!force && isVolumeAlertScanDone(triggerOpenTime)) {
        results.push({
          triggerOpenTime,
          triggerAt: new Date(triggerOpenTime).toISOString(),
          skipped: true,
          reason: "已检测过",
        });
        continue;
      }
      console.log(`[volume-alert] 指定批次 ${new Date(triggerOpenTime).toISOString()} …`);
      const batch = await scanTriggerBatch(triggerOpenTime, symbols);
      results.push({
        ...batch,
        triggerAt: new Date(triggerOpenTime).toISOString(),
        skipped: false,
      });
    }
    return {
      triggers,
      symbolCount: symbols.length,
      results,
      totalAlerts: results.reduce((n, r) => n + (r.alertCount || 0), 0),
      totalInserted: results.reduce((n, r) => n + (r.inserted || 0), 0),
    };
  } finally {
    scanning = false;
  }
}

/** 回测最近 N 根已收盘 4h K 线（按真实币安数据检测并写入数据库） */
export async function runVolumeAlertBacktest({ periods = 2, force = false } = {}) {
  const count = Math.min(Math.max(Number(periods) || 2, 1), 7);
  while (scanning) await sleep(1000);
  scanning = true;
  try {
    const latest = getLatestClosed4hOpenTime();
    const triggers = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      triggers.push(latest - i * FOUR_H_MS);
    }

    const symbols = await listUsdtPerpetualSymbols();
    if (!symbols.length) throw new Error("无可用 USDT 永续列表");

    const results = [];
    for (const triggerOpenTime of triggers) {
      if (!force && isVolumeAlertScanDone(triggerOpenTime)) {
        results.push({
          triggerOpenTime,
          triggerAt: new Date(triggerOpenTime).toISOString(),
          skipped: true,
          reason: "已检测过",
        });
        continue;
      }
      console.log(`[volume-alert] 回测 ${new Date(triggerOpenTime).toISOString()} …`);
      const batch = await scanTriggerBatch(triggerOpenTime, symbols);
      results.push({
        ...batch,
        triggerAt: new Date(triggerOpenTime).toISOString(),
        skipped: false,
      });
    }

    return {
      periods: count,
      symbolCount: symbols.length,
      results,
      totalAlerts: results.reduce((n, r) => n + (r.alertCount || 0), 0),
      totalInserted: results.reduce((n, r) => n + (r.inserted || 0), 0),
    };
  } finally {
    scanning = false;
  }
}

/** 回测指定时区「今天」所有已收线 4h 批次 */
export async function runVolumeAlertBacktestToday({ force = true, timeZone = "Asia/Shanghai" } = {}) {
  const triggers = listTodayClosedTriggers(timeZone);
  if (!triggers.length) throw new Error("今天暂无已收线的 4h K 线");
  return runVolumeAlertScanTriggers(triggers, { force });
}
