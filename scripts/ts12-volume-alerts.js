/**
 * 4h 成交量异常预警：检测逻辑、扫描调度、本地缓存
 */
(function (global) {
  const INTERVAL_4H = "4h";
  const BASELINE_BARS = 30;
  const SINGLE_RATIO = 10;
  const DOUBLE_RATIO = 5;
  const KLINE_LIMIT = 35;
  const FOUR_H_MS = 4 * 60 * 60 * 1000;
  const SCAN_AFTER_CLOSE_MS = 45000;
  const LOCAL_CACHE_KEY = "ts12-volume-alerts-cache-v1";
  const LAST_CANDLE_KEY = "ts12-volume-alert-last-candle-v1";
  const REQUEST_TIMEOUT_MS = 8000;
  const MAX_RETRIES = 2;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  function formatAlertTime(ms) {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${m}-${day} ${h}:${min}`;
  }

  function getClosedKlines(klines, now = Date.now()) {
    if (!Array.isArray(klines)) return [];
    return klines.filter((k) => Number(k?.[6]) <= now);
  }

  function averageVolume(bars) {
    if (!bars.length) return 0;
    const sum = bars.reduce((acc, k) => acc + Number(k[5] || 0), 0);
    return sum / bars.length;
  }

  /** 检测单币种 4h K 线是否触发预警（仅评估最新已收盘 K 线） */
  function evaluateVolumeAlerts(exchangeSymbol, klines, now = Date.now()) {
    const ex = makeSymbolKey(exchangeSymbol);
    const closed = getClosedKlines(klines, now);
    if (closed.length < BASELINE_BARS + 1) return [];

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
        triggerCandleOpenTime: latestOpen,
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
          triggerCandleOpenTime: latestOpen,
        });
      }
    }

    return alerts;
  }

  function getLatestClosed4hOpenTime(now = Date.now()) {
    const closedBoundary = Math.floor(now / FOUR_H_MS) * FOUR_H_MS;
    return closedBoundary - FOUR_H_MS;
  }

  function getNext4hCloseMs(now = Date.now()) {
    return Math.ceil(now / FOUR_H_MS) * FOUR_H_MS;
  }

  function readLastProcessedCandleOpen() {
    try {
      const n = Number(localStorage.getItem(LAST_CANDLE_KEY));
      return Number.isFinite(n) ? n : null;
    } catch (_) {
      return null;
    }
  }

  function writeLastProcessedCandleOpen(openTime) {
    try {
      localStorage.setItem(LAST_CANDLE_KEY, String(openTime));
    } catch (_) {}
  }

  function readLocalAlerts() {
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function writeLocalAlerts(alerts) {
    try {
      localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(alerts.slice(0, 500)));
    } catch (_) {}
  }

  function mergeAlerts(existing, incoming) {
    const map = new Map();
    for (const a of [...existing, ...incoming]) {
      const key = `${a.exchangeSymbol}|${a.candleOpenTime}|${a.conditionType}`;
      if (!map.has(key)) map.set(key, a);
    }
    return Array.from(map.values()).sort(
      (a, b) => (b.createdAt || b.candleCloseTime || 0) - (a.createdAt || a.candleCloseTime || 0)
    );
  }

  async function fetchJsonWithTimeout(url, timeoutMs) {
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
      `symbol=${encodeURIComponent(symbol)}&interval=${INTERVAL_4H}&limit=${KLINE_LIMIT}`;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const raw = await fetchJsonWithTimeout(url, REQUEST_TIMEOUT_MS);
        if (!Array.isArray(raw) || !raw.length) throw new Error("空数据");
        return raw;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) await sleep(400 * 2 ** attempt);
      }
    }
    throw lastError || new Error("K线请求失败");
  }

  async function runPool(items, worker, concurrency, onProgress) {
    let index = 0;
    let done = 0;
    const total = items.length;
    const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (index < total) {
        const i = index;
        index += 1;
        try {
          await worker(items[i], i);
        } catch (_) {}
        done += 1;
        if (onProgress) onProgress(done, total);
      }
    });
    await Promise.all(runners);
  }

  async function scanSymbolsForVolumeAlerts(symbols, { concurrency = 4, gapMs = 80, onProgress } = {}) {
    const found = [];
    const now = Date.now();
    const targetOpen = getLatestClosed4hOpenTime(now);
    await runPool(
      symbols,
      async (exchangeSymbol) => {
        await sleep(gapMs);
        const klines = await fetch4hKlines(exchangeSymbol);
        const alerts = evaluateVolumeAlerts(exchangeSymbol, klines, now).filter(
          (a) => a.triggerCandleOpenTime === targetOpen
        );
        for (const a of alerts) {
          found.push({ ...a, createdAt: now });
        }
      },
      concurrency,
      onProgress
    );
    return { alerts: found, candleOpenTime: targetOpen };
  }

  async function persistAlerts(alerts) {
    if (!alerts.length) return { inserted: 0, merged: readLocalAlerts() };
    let inserted = 0;
    if (global.Ts12Api?.isEnabled?.()) {
      try {
        const res = await global.Ts12Api.postVolumeAlertsBatch(alerts);
        inserted = Number(res?.inserted) || 0;
      } catch (err) {
        console.warn("云端保存成交量预警失败", err);
      }
    }
    const merged = mergeAlerts(readLocalAlerts(), alerts.map((a) => ({ ...a, createdAt: a.createdAt || Date.now() })));
    writeLocalAlerts(merged);
    return { inserted, merged };
  }

  async function loadRecentAlerts(limit = 20) {
    if (global.Ts12Api?.isEnabled?.()) {
      try {
        const res = await global.Ts12Api.getVolumeAlerts({ limit, offset: 0 });
        if (Array.isArray(res?.alerts) && res.alerts.length) {
          writeLocalAlerts(mergeAlerts(readLocalAlerts(), res.alerts));
          return res.alerts;
        }
      } catch (err) {
        console.warn("加载云端成交量预警失败", err);
      }
    }
    return readLocalAlerts().slice(0, limit);
  }

  function shouldRunCatchUpScan(now = Date.now()) {
    const latestClosedOpen = getLatestClosed4hOpenTime(now);
    const last = readLastProcessedCandleOpen();
    return last == null || latestClosedOpen > last;
  }

  function markCandleProcessed(openTime) {
    writeLastProcessedCandleOpen(openTime);
  }

  function schedule4hScan(callback) {
    let timer = null;
    let cancelled = false;

    function scheduleNext() {
      const nextClose = getNext4hCloseMs();
      const delay = Math.max(1000, nextClose - Date.now() + SCAN_AFTER_CLOSE_MS);
      timer = setTimeout(async () => {
        if (cancelled) return;
        try {
          await callback();
        } catch (err) {
          console.warn("4h 成交量预警检测失败", err);
        } finally {
          if (!cancelled) scheduleNext();
        }
      }, delay);
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
    };
  }

  global.Ts12VolumeAlerts = {
    INTERVAL_4H,
    BASELINE_BARS,
    SINGLE_RATIO,
    DOUBLE_RATIO,
    FOUR_H_MS,
    SCAN_AFTER_CLOSE_MS,
    makeSymbolKey,
    formatExchangePair,
    formatSymbolDisplay,
    formatConditionType,
    formatRatio,
    formatAlertTime,
    evaluateVolumeAlerts,
    getLatestClosed4hOpenTime,
    getNext4hCloseMs,
    fetch4hKlines,
    scanSymbolsForVolumeAlerts,
    persistAlerts,
    loadRecentAlerts,
    shouldRunCatchUpScan,
    markCandleProcessed,
    readLastProcessedCandleOpen,
    schedule4hScan,
    mergeAlerts,
    readLocalAlerts,
  };
})(typeof window !== "undefined" ? window : globalThis);
