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
const SCAN_CONCURRENCY = 8;
const SYMBOL_GAP_MS = 30;
const CHECK_INTERVAL_MS = 60_000;
const MAX_BACKFILL_TRIGGERS = 42;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const DEFAULT_FAPI_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];
const SYMBOL_CACHE_META = "volume_alert_symbol_cache";
const LAST_ERROR_META = "volume_alert_last_error";

let scanning = false;
let checkTimer = null;
let symbolCache = { symbols: [], fetchedAt: 0 };
let scanProgress = {
  phase: null,
  triggerOpenTime: null,
  triggerIndex: 0,
  triggerTotal: 0,
  symbolIndex: 0,
  symbolTotal: 0,
  startedAt: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFapiBases() {
  const raw = String(process.env.BINANCE_FAPI_BASE || process.env.BINANCE_FAPI_BASES || "").trim();
  if (raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_FAPI_BASES;
}

function setScanError(err) {
  const message = String(err?.message || err || "未知错误");
  scanProgress.lastError = message;
  setSystemMeta(LAST_ERROR_META, message);
}

function clearScanError() {
  scanProgress.lastError = null;
  setSystemMeta(LAST_ERROR_META, "");
}

function loadPersistedSymbolCache() {
  try {
    const raw = getSystemMeta(SYMBOL_CACHE_META);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed?.symbols) &&
      parsed.symbols.length &&
      Date.now() - Number(parsed.fetchedAt || 0) < 7 * 24 * 60 * 60 * 1000
    ) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function persistSymbolCache(cache) {
  setSystemMeta(SYMBOL_CACHE_META, JSON.stringify(cache));
}

async function fetchFromFapi(path) {
  const bases = getFapiBases();
  let lastError = null;
  for (const base of bases) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await fetchJson(`${base}${path}`);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) await sleep(400 * 2 ** attempt);
      }
    }
  }
  throw lastError || new Error("币安 API 请求失败");
}

  async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "ts12-volume-alert/1.0" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!text.trim()) throw new Error("币安返回空响应");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("币安返回无效 JSON");
    }
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
  try {
    scanProgress.phase = "fetching_symbols";
    const info = await fetchFromFapi("/fapi/v1/exchangeInfo");
    const symbols = (info?.symbols || [])
      .filter(isTradableUsdtPerpetual)
      .map((item) => String(item.symbol).toUpperCase())
      .filter((sym) => sym.endsWith("USDT"))
      .sort((a, b) => a.localeCompare(b));
    symbolCache = { symbols, fetchedAt: now };
    persistSymbolCache(symbolCache);
    clearScanError();
    return symbols;
  } catch (err) {
    const persisted = loadPersistedSymbolCache();
    if (persisted?.symbols?.length) {
      console.warn(`[volume-alert] 币安合约列表拉取失败，使用缓存 ${persisted.symbols.length} 个`);
      symbolCache = persisted;
      return persisted.symbols;
    }
    throw err;
  }
}

async function fetch4hKlines(exchangeSymbol) {
  const symbol = makeSymbolKey(exchangeSymbol);
  const path =
    `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=4h&limit=${KLINE_LIMIT}`;
  const raw = await fetchFromFapi(path);
  if (!Array.isArray(raw) || raw.length < BASELINE_BARS + 1) throw new Error("空数据");
  return raw;
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

async function scanTriggerBatch(triggerOpenTime, symbols, progress = null) {
  const found = [];
  let symbolIndex = 0;
  await runPool(
    symbols,
    async (exchangeSymbol) => {
      symbolIndex += 1;
      if (progress) {
        progress.symbolIndex = symbolIndex;
        progress.symbolTotal = symbols.length;
        progress.triggerOpenTime = triggerOpenTime;
        progress.phase = "scanning_symbols";
      }
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
    setScanError(err);
  } finally {
    scanning = false;
    scanProgress.phase = "idle";
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

export function getVolumeAlertScanStatus() {
  const lastErrorRaw = getSystemMeta(LAST_ERROR_META);
  return {
    scanning,
    ...scanProgress,
    symbolCacheCount: symbolCache.symbols.length,
    symbolCacheAgeMs: symbolCache.fetchedAt ? Date.now() - symbolCache.fetchedAt : null,
    lastError: lastErrorRaw || scanProgress.lastError || null,
  };
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
  if (scanning) throw new Error("扫描任务进行中");

  scanning = true;
  scanProgress = {
    phase: "starting",
    triggerOpenTime: null,
    triggerIndex: 0,
    triggerTotal: triggers.length,
    symbolIndex: 0,
    symbolTotal: 0,
    startedAt: Date.now(),
    lastError: null,
  };
  try {
    const symbols = await listUsdtPerpetualSymbols();
    if (!symbols.length) throw new Error("无可用 USDT 永续列表");

    const results = [];
    for (let i = 0; i < triggers.length; i += 1) {
      const triggerOpenTime = triggers[i];
      scanProgress.triggerIndex = i + 1;
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
      const batch = await scanTriggerBatch(triggerOpenTime, symbols, scanProgress);
      results.push({
        ...batch,
        triggerAt: new Date(triggerOpenTime).toISOString(),
        skipped: false,
      });
    }
    clearScanError();
    return {
      triggers,
      symbolCount: symbols.length,
      results,
      totalAlerts: results.reduce((n, r) => n + (r.alertCount || 0), 0),
      totalInserted: results.reduce((n, r) => n + (r.inserted || 0), 0),
    };
  } catch (err) {
    setScanError(err);
    throw err;
  } finally {
    scanning = false;
    scanProgress.phase = "idle";
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
