/**
 * 4h 成交量异常预警：展示 + 浏览器端扫描（上传至服务端）
 */
(function (global) {
  const BASELINE_BARS = 30;
  const SINGLE_RATIO = 10;
  const DOUBLE_RATIO = 5;
  const FOUR_H_MS = 4 * 60 * 60 * 1000;
  const KLINE_LIMIT = 80;
  const SCAN_CONCURRENCY = 5;
  const SYMBOL_GAP_MS = 50;
  const REQUEST_TIMEOUT_MS = 15000;

  function makeSymbolKey(exchangeSymbol) {
    return String(exchangeSymbol || "").trim().toUpperCase();
  }

  function formatExchangePair(exchangeSymbol) {
    const s = makeSymbolKey(exchangeSymbol);
    for (const quote of ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"]) {
      if (s.endsWith(quote)) return `${s.slice(0, -quote.length)}/${quote}`;
    }
    return s;
  }

  function formatSymbolDisplay(exchangeSymbol) {
    const s = makeSymbolKey(exchangeSymbol);
    for (const quote of ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"]) {
      if (s.endsWith(quote)) return s.slice(0, -quote.length);
    }
    return s;
  }

  function formatConditionType(type) {
    if (type === "single10x") return "单根≥10×";
    if (type === "double5x") return "连续2根≥5×";
    return type;
  }

  function formatRatio(ratio) {
    const n = Number(ratio);
    if (!Number.isFinite(n)) return "--";
    return `${n.toFixed(1)}×`;
  }

  /** 同一批次内按币种聚合（双条件合并为一行） */
  function aggregateAlertsBySymbol(alerts) {
    const map = new Map();
    for (const alert of alerts || []) {
      const key = makeSymbolKey(alert.exchangeSymbol);
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, {
          exchangeSymbol: key,
          conditions: [],
          volume: Number(alert.volume) || 0,
          maxRatio: 0,
          candleCloseTime: alert.candleCloseTime,
          triggerCandleOpenTime: alert.triggerCandleOpenTime,
        });
      }
      const row = map.get(key);
      row.conditions.push({
        conditionType: alert.conditionType,
        ratio: alert.ratio,
        avgVolume: alert.avgVolume,
      });
      row.maxRatio = Math.max(row.maxRatio, Number(alert.ratio) || 0);
      row.volume = Math.max(row.volume, Number(alert.volume) || 0);
      row.candleCloseTime = alert.candleCloseTime ?? row.candleCloseTime;
    }
    return [...map.values()].sort((a, b) => b.maxRatio - a.maxRatio);
  }

  function formatAggregatedConditions(aggregated) {
    return (aggregated?.conditions || [])
      .map((c) => formatConditionType(c.conditionType))
      .join(" · ");
  }

  function formatAggregatedRatios(aggregated) {
    return (aggregated?.conditions || []).map((c) => formatRatio(c.ratio)).join(" · ");
  }

  function formatAggregatedAvgVolumes(aggregated, formatVolume) {
    const fmt = formatVolume || ((v) => String(v));
    return (aggregated?.conditions || []).map((c) => fmt(c.avgVolume)).join(" · ");
  }

  function formatAggregatedChipText(aggregated) {
    return (aggregated?.conditions || [])
      .map((c) => `${formatConditionType(c.conditionType)} ${formatRatio(c.ratio)}`)
      .join(" · ");
  }

  function formatAlertTime(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}`;
  }

  function getLatestClosed4hOpenTime(now = Date.now()) {
    const closedBoundary = Math.floor(now / FOUR_H_MS) * FOUR_H_MS;
    return closedBoundary - FOUR_H_MS;
  }

  function getNext4hCloseMs(now = Date.now()) {
    return Math.ceil(now / FOUR_H_MS) * FOUR_H_MS;
  }

  function dateKeyInTimeZone(ms, timeZone = "Asia/Shanghai") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }

  function listTodayClosedTriggers(timeZone = "Asia/Shanghai", now = Date.now()) {
    const latest = getLatestClosed4hOpenTime(now);
    const todayKey = dateKeyInTimeZone(now, timeZone);
    const triggers = [];
    for (let t = latest; t >= latest - 6 * FOUR_H_MS; t -= FOUR_H_MS) {
      const closeMs = t + FOUR_H_MS - 1;
      if (dateKeyInTimeZone(closeMs, timeZone) === todayKey) {
        triggers.push(t);
      }
    }
    return triggers.sort((a, b) => a - b);
  }

  function averageVolume(bars) {
    if (!bars.length) return 0;
    return bars.reduce((acc, k) => acc + Number(k[5] || 0), 0) / bars.length;
  }

  function evaluateVolumeAlertsForTrigger(exchangeSymbol, klines, triggerOpenTime) {
    const ex = makeSymbolKey(exchangeSymbol);
    const trigger = Number(triggerOpenTime);
    if (!Array.isArray(klines) || !Number.isFinite(trigger)) return [];

    const idx = klines.findIndex((k) => Number(k[0]) === trigger);
    if (idx < BASELINE_BARS) return [];

    const closed = klines.slice(0, idx + 1);
    const latest = closed[closed.length - 1];
    const latestVol = Number(latest[5]);
    const baseline = closed.slice(closed.length - BASELINE_BARS - 1, closed.length - 1);
    const avgVol = averageVolume(baseline);
    if (!(avgVol > 0) || !Number.isFinite(latestVol)) return [];

    const alerts = [];
    const latestOpen = Number(latest[0]);
    const latestClose = Number(latest[6]);

    if (latestVol >= SINGLE_RATIO * avgVol) {
      alerts.push({
        exchangeSymbol: ex,
        conditionType: "single10x",
        volume: latestVol,
        avgVolume: avgVol,
        ratio: latestVol / avgVol,
        candleOpenTime: latestOpen,
        candleCloseTime: latestClose,
        triggerCandleOpenTime: trigger,
      });
    }

    if (closed.length >= BASELINE_BARS + 2) {
      const prev = closed[closed.length - 2];
      const baseline2 = closed.slice(closed.length - BASELINE_BARS - 2, closed.length - 2);
      const avg2 = averageVolume(baseline2);
      const volPrev = Number(prev[5]);
      if (avg2 > 0 && volPrev >= DOUBLE_RATIO * avg2 && latestVol >= DOUBLE_RATIO * avg2) {
        alerts.push({
          exchangeSymbol: ex,
          conditionType: "double5x",
          volume: latestVol,
          avgVolume: avg2,
          ratio: Math.min(volPrev / avg2, latestVol / avg2),
          candleOpenTime: Number(prev[0]),
          candleCloseTime: latestClose,
          triggerCandleOpenTime: trigger,
        });
      }
    }

    return alerts;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetch4hKlines(exchangeSymbol) {
    const symbol = makeSymbolKey(exchangeSymbol);
    const url =
      "https://fapi.binance.com/fapi/v1/klines?" +
      `symbol=${encodeURIComponent(symbol)}&interval=4h&limit=${KLINE_LIMIT}`;
    const raw = await fetchJsonWithTimeout(url);
    if (!Array.isArray(raw) || raw.length < BASELINE_BARS + 1) throw new Error("空数据");
    return raw;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runPool(items, worker, concurrency) {
    let index = 0;
    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (index < items.length) {
        const i = index;
        index += 1;
        try {
          await worker(items[i], i);
        } catch (err) {
          console.warn(`[volume-alert] ${items[i]} 扫描失败`, err?.message || err);
        }
      }
    });
    await Promise.all(runners);
  }

  async function scanTriggerBatchInBrowser(triggerOpenTime, symbols, onProgress) {
    const found = [];
    let done = 0;
    await runPool(
      symbols,
      async (exchangeSymbol) => {
        await sleep(SYMBOL_GAP_MS);
        const klines = await fetch4hKlines(exchangeSymbol);
        found.push(...evaluateVolumeAlertsForTrigger(exchangeSymbol, klines, triggerOpenTime));
        done += 1;
        if (onProgress) {
          onProgress({
            phase: "scanning_symbols",
            triggerOpenTime,
            symbolIndex: done,
            symbolTotal: symbols.length,
          });
        }
      },
      SCAN_CONCURRENCY
    );
    return found;
  }

  /** 相对已扫描批次，找出最近 7 根内尚未入库的 4h 批次 */
  function listMissingClosedTriggers(scannedOpenTimes, now = Date.now()) {
    const scanned = new Set(
      (Array.isArray(scannedOpenTimes) ? scannedOpenTimes : [])
        .map(Number)
        .filter(Number.isFinite)
    );
    const latest = getLatestClosed4hOpenTime(now);
    const missing = [];
    for (let t = latest; t >= latest - 6 * FOUR_H_MS; t -= FOUR_H_MS) {
      if (!scanned.has(t)) missing.push(t);
    }
    return missing.sort((a, b) => a - b);
  }

  async function listMissingClosedTriggersFromApi() {
    if (!global.Ts12Api?.getVolumeAlertHistory) return listMissingClosedTriggers([]);
    const res = await global.Ts12Api.getVolumeAlertHistory({ limit: 100, offset: 0 });
    const scanned = (res?.batches || []).map((b) => b.triggerCandleOpenTime);
    return listMissingClosedTriggers(scanned);
  }

  async function runTriggersScanInBrowser(triggers, { onProgress } = {}) {
    if (!global.Ts12Api?.isEnabled?.()) throw new Error("云端 API 未启用");
    if (!global.Ts12BinanceFutures?.fetchExchangeInfo) {
      throw new Error("缺少币安合约模块");
    }
    const list = [...triggers].filter(Number.isFinite).sort((a, b) => a - b);
    if (!list.length) throw new Error("没有需要补扫的批次");

    if (onProgress) onProgress({ phase: "fetching_symbols" });
    const info = await global.Ts12BinanceFutures.fetchExchangeInfo(fetchJsonWithTimeout, REQUEST_TIMEOUT_MS);
    const map = global.Ts12BinanceFutures.buildMapFromExchangeInfo(info);
    const symbols = global.Ts12BinanceFutures.listUsdtPerpetualSymbols(map, "all");
    if (!symbols.length) throw new Error("无可用 USDT 永续列表");

    const results = [];
    for (let i = 0; i < list.length; i += 1) {
      const triggerOpenTime = list[i];
      if (onProgress) {
        onProgress({
          phase: "scanning_batch",
          triggerIndex: i + 1,
          triggerTotal: list.length,
          triggerOpenTime,
          symbolIndex: 0,
          symbolTotal: symbols.length,
        });
      }
      const alerts = await scanTriggerBatchInBrowser(triggerOpenTime, symbols, (p) => {
        if (onProgress) {
          onProgress({
            phase: "scanning_symbols",
            triggerIndex: i + 1,
            triggerTotal: list.length,
            triggerOpenTime,
            symbolIndex: p.symbolIndex,
            symbolTotal: p.symbolTotal,
          });
        }
      });
      const payload = {
        triggerCandleOpenTime: triggerOpenTime,
        symbolCount: symbols.length,
        alerts,
      };
      if (global.Ts12Api.postVolumeAlertScanComplete) {
        await global.Ts12Api.postVolumeAlertScanComplete(payload);
      } else {
        await global.Ts12Api.postVolumeAlertsBatch(alerts);
      }
      results.push({ triggerOpenTime, alertCount: alerts.length });
    }

    return { triggers: list, symbolCount: symbols.length, results };
  }

  /** 在浏览器扫描今天所有已收线批次，并上传至服务端（含 0 条批次） */
  async function runTodayScanInBrowser({ clearFirst = false, onProgress } = {}) {
    const triggers = listTodayClosedTriggers();
    if (!triggers.length) throw new Error("今天暂无已收线的 4h K 线");

    if (clearFirst) {
      if (onProgress) onProgress({ phase: "clearing" });
      await global.Ts12Api.clearVolumeAlerts();
    }

    return runTriggersScanInBrowser(triggers, { onProgress });
  }

  /** 补扫历史里缺失的 4h 批次（不清空已有记录） */
  async function runMissingScanInBrowser({ onProgress } = {}) {
    const triggers = await listMissingClosedTriggersFromApi();
    if (!triggers.length) throw new Error("没有遗漏批次，已是最新");
    return runTriggersScanInBrowser(triggers, { onProgress });
  }

  async function loadLatestBatch() {
    if (global.Ts12Api?.isEnabled?.()) {
      try {
        return await global.Ts12Api.getVolumeAlertsLatest();
      } catch (err) {
        console.warn("加载最新成交量预警批次失败", err);
        throw err;
      }
    }
    return { scan: null, alerts: [] };
  }

  global.Ts12VolumeAlerts = {
    FOUR_H_MS,
    BASELINE_BARS,
    makeSymbolKey,
    formatExchangePair,
    formatSymbolDisplay,
    formatConditionType,
    formatRatio,
    aggregateAlertsBySymbol,
    formatAggregatedConditions,
    formatAggregatedRatios,
    formatAggregatedAvgVolumes,
    formatAggregatedChipText,
    formatAlertTime,
    getLatestClosed4hOpenTime,
    getNext4hCloseMs,
    listTodayClosedTriggers,
    listMissingClosedTriggersFromApi,
    evaluateVolumeAlertsForTrigger,
    runTodayScanInBrowser,
    runMissingScanInBrowser,
    loadLatestBatch,
  };
})(typeof window !== "undefined" ? window : globalThis);
