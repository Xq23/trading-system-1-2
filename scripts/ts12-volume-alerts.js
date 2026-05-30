/**
 * 4h 成交量异常预警：前端展示工具（检测由服务端定时执行）
 */
(function (global) {
  const FOUR_H_MS = 4 * 60 * 60 * 1000;

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
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}`;
  }

  function getNext4hCloseMs(now = Date.now()) {
    return Math.ceil(now / FOUR_H_MS) * FOUR_H_MS;
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
    makeSymbolKey,
    formatExchangePair,
    formatSymbolDisplay,
    formatConditionType,
    formatRatio,
    formatAlertTime,
    getNext4hCloseMs,
    loadLatestBatch,
  };
})(typeof window !== "undefined" ? window : globalThis);
