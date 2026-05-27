#!/usr/bin/env node
/**
 * 与 index.html 中指标计算一致的可执行脚本（币安 U 本位永续 K 线）。
 *
 * 用法:
 *   node scripts/binance-indicators.mjs
 *   node scripts/binance-indicators.mjs --symbol ETHUSDT --interval 4h --minBars 800
 *   node scripts/binance-indicators.mjs --json
 *
 * 需要 Node 18+（内置 fetch）。
 */

const INTERVAL_MINUTES = {
  "30m": 30,
  "4h": 240,
  "12h": 720,
  "1d": 1440,
};

const REQUEST_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function normalizeKlinesResponse(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("接口返回空数据");
  return raw;
}

async function requestKlines(symbol, interval, limit, endTimeMs) {
  const q =
    "symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    encodeURIComponent(limit) +
    (endTimeMs != null ? "&endTime=" + encodeURIComponent(String(endTimeMs)) : "");
  const url = "https://fapi.binance.com/fapi/v1/klines?" + q;
  return normalizeKlinesResponse(await fetchJsonWithTimeout(url, REQUEST_TIMEOUT_MS));
}

async function requestKlinesHistory(symbol, interval, minBars) {
  const MAX = 1500;
  let merged = [];
  let endTime = undefined;
  while (merged.length < minBars) {
    const need = minBars - merged.length;
    const lim = Math.min(MAX, need);
    const raw = await requestKlines(symbol, interval, lim, endTime);
    if (!raw.length) break;
    merged = raw.concat(merged);
    endTime = Number(raw[0][0]) - 1;
    if (raw.length < lim) break;
  }
  return merged;
}

function barsForCalendarDays(interval, days) {
  const m = INTERVAL_MINUTES[interval];
  if (!m) return Math.max(1, days);
  return Math.max(1, Math.ceil((days * 24 * 60) / m));
}

function calcRollingSmaClose(raw, window) {
  const n = raw.length;
  const out = new Array(n).fill(null);
  if (window <= 0 || n < window) return out;
  let sum = 0;
  for (let i = 0; i < window; i += 1) sum += Number(raw[i][4]);
  out[window - 1] = sum / window;
  for (let i = window; i < n; i += 1) {
    sum += Number(raw[i][4]);
    sum -= Number(raw[i - window][4]);
    out[i] = sum / window;
  }
  return out;
}

function computeVpStats(window) {
  let sumVol = 0;
  let weightedPrice = 0;
  for (const k of window) {
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const volume = Number(k[5]);
    const typicalPrice = (high + low + close) / 3;
    sumVol += volume;
    weightedPrice += typicalPrice * volume;
  }
  const fallbackClose = Number(window[window.length - 1][4]);
  const poc = sumVol > 0 ? weightedPrice / sumVol : fallbackClose;
  let varianceWeighted = 0;
  for (const k of window) {
    const high = Number(k[2]);
    const low = Number(k[3]);
    const close = Number(k[4]);
    const volume = Number(k[5]);
    const typicalPrice = (high + low + close) / 3;
    const diff = typicalPrice - poc;
    varianceWeighted += diff * diff * volume;
  }
  const sigma = sumVol > 0 ? Math.sqrt(varianceWeighted / sumVol) : 0;
  return { poc, vah: poc + sigma, val: poc - sigma };
}

function getWeekKey(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const deltaToMonday = (day + 6) % 7;
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - deltaToMonday);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}
function getMonthKeyUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}
function getQuarterKeyUTC(ms) {
  const d = new Date(ms);
  const q0 = Math.floor(d.getUTCMonth() / 3) * 3;
  return Date.UTC(d.getUTCFullYear(), q0, 1, 0, 0, 0, 0);
}
function getYearKeyUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
}
function getPeriodKey(ms, interval) {
  if (interval === "30m") return getWeekKey(ms);
  if (interval === "4h") return getMonthKeyUTC(ms);
  if (interval === "12h") return getQuarterKeyUTC(ms);
  if (interval === "1d") return getYearKeyUTC(ms);
  return 0;
}

function calcVpBands(raw, interval) {
  const result = {
    poc: new Array(raw.length).fill(null),
    vah: new Array(raw.length).fill(null),
    val: new Array(raw.length).fill(null),
    currentPeriodStartIdx: 0,
  };
  const periods = new Map();
  for (let i = 0; i < raw.length; i += 1) {
    const key = getPeriodKey(Number(raw[i][0]), interval);
    if (!periods.has(key)) periods.set(key, []);
    periods.get(key).push(i);
  }
  const keys = Array.from(periods.keys()).sort((a, b) => a - b);
  if (keys.length === 0) return result;
  const currentKey = keys[keys.length - 1];
  const currentIdxs = periods.get(currentKey) || [];
  result.currentPeriodStartIdx = currentIdxs.length > 0 ? currentIdxs[0] : 0;
  for (const key of keys) {
    const idxs = periods.get(key);
    if (!idxs || idxs.length === 0) continue;
    if (key !== currentKey) {
      const stats = computeVpStats(idxs.map((idx) => raw[idx]));
      for (const idx of idxs) {
        result.poc[idx] = stats.poc;
        result.vah[idx] = stats.vah;
        result.val[idx] = stats.val;
      }
      continue;
    }
    let smoothPoc = null;
    let smoothVah = null;
    let smoothVal = null;
    const alpha = 0.35;
    for (let j = 0; j < idxs.length; j += 1) {
      const idx = idxs[j];
      const stats = computeVpStats(raw.slice(idxs[0], idx + 1));
      if (smoothPoc == null) {
        smoothPoc = stats.poc;
        smoothVah = stats.vah;
        smoothVal = stats.val;
      } else {
        smoothPoc = alpha * stats.poc + (1 - alpha) * smoothPoc;
        smoothVah = alpha * stats.vah + (1 - alpha) * smoothVah;
        smoothVal = alpha * stats.val + (1 - alpha) * smoothVal;
      }
      result.poc[idx] = smoothPoc;
      result.vah[idx] = smoothVah;
      result.val[idx] = smoothVal;
    }
  }
  return result;
}

function computePrevPeriodExtendVp(raw, interval, vpBands) {
  const n = raw.length;
  const nil = () => new Array(n).fill(null);
  const periods = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = getPeriodKey(Number(raw[i][0]), interval);
    if (!periods.has(key)) periods.set(key, []);
    periods.get(key).push(i);
  }
  const keys = Array.from(periods.keys()).sort((a, b) => a - b);
  if (keys.length < 2) {
    return { prevExtendVah: nil(), prevExtendPoc: nil(), prevExtendVal: nil() };
  }
  const prevIdxs = periods.get(keys[keys.length - 2]);
  const lastPrevIdx = prevIdxs[prevIdxs.length - 1];
  const pvah = vpBands.vah[lastPrevIdx];
  const ppoc = vpBands.poc[lastPrevIdx];
  const pval = vpBands.val[lastPrevIdx];
  const start = vpBands.currentPeriodStartIdx;
  const prevExtendVah = nil();
  const prevExtendPoc = nil();
  const prevExtendVal = nil();
  for (let i = start; i < n; i += 1) {
    prevExtendVah[i] = pvah;
    prevExtendPoc[i] = ppoc;
    prevExtendVal[i] = pval;
  }
  return { prevExtendVah, prevExtendPoc, prevExtendVal };
}

function calcVolumeSignals(raw, lookback = 34, multiplier = 3.0) {
  const isSpike = new Array(raw.length).fill(false);
  const npoc = new Array(raw.length).fill(null);
  const npocPoints = [];
  let lastNpoc = null;
  for (let i = 0; i < raw.length; i += 1) {
    const start = Math.max(0, i - lookback + 1);
    let sum = 0;
    for (let j = start; j <= i; j += 1) sum += Number(raw[j][5]);
    const avgVol = sum / (i - start + 1);
    const curVol = Number(raw[i][5]);
    const spike = curVol > avgVol * multiplier;
    if (spike) {
      const high = Number(raw[i][2]);
      const low = Number(raw[i][3]);
      const close = Number(raw[i][4]);
      lastNpoc = (high + low + close) / 3;
      isSpike[i] = true;
      npocPoints.push([i, lastNpoc]);
    }
    npoc[i] = lastNpoc;
  }
  return { isSpike, npoc, npocPoints };
}

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

function parseArgs(argv) {
  const out = { symbol: "BTCUSDT", interval: "30m", minBars: 750, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--symbol" && argv[i + 1]) {
      out.symbol = String(argv[++i]).toUpperCase();
    } else if (a === "--interval" && argv[i + 1]) {
      out.interval = argv[++i];
    } else if (a === "--minBars" && argv[i + 1]) {
      out.minBars = Math.max(50, parseInt(argv[++i], 10) || 750);
    }
  }
  if (!INTERVAL_MINUTES[out.interval]) {
    throw new Error(`不支持的 interval，请使用: ${Object.keys(INTERVAL_MINUTES).join(", ")}`);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  let Wmax = 0;
  if (opts.interval === "30m") Wmax = Math.max(Wmax, barsForCalendarDays(opts.interval, 7));
  if (opts.interval === "1d") {
    Wmax = Math.max(Wmax, barsForCalendarDays(opts.interval, 90));
    Wmax = Math.max(Wmax, barsForCalendarDays(opts.interval, 365));
  }
  const historyNeed = Wmax > 0 ? opts.minBars + Wmax - 1 : opts.minBars;
  const mergedHistory = await requestKlinesHistory(opts.symbol, opts.interval, historyNeed);
  const raw = mergedHistory.slice(-opts.minBars);

  const vpBands = calcVpBands(raw, opts.interval);
  const prev = computePrevPeriodExtendVp(raw, opts.interval, vpBands);
  const volSig = calcVolumeSignals(raw, 34, 3.0);

  let roll7 = null;
  let roll90 = null;
  let roll365 = null;
  if (opts.interval === "30m") {
    const W7 = barsForCalendarDays(opts.interval, 7);
    roll7 = calcRollingSmaClose(mergedHistory, W7).slice(-raw.length);
  }
  if (opts.interval === "1d") {
    const W90 = barsForCalendarDays(opts.interval, 90);
    const W365 = barsForCalendarDays(opts.interval, 365);
    roll90 = calcRollingSmaClose(mergedHistory, W90).slice(-raw.length);
    roll365 = calcRollingSmaClose(mergedHistory, W365).slice(-raw.length);
  }

  const li = raw.length - 1;
  const t = new Date(Number(raw[li][0])).toISOString();
  const close = Number(raw[li][4]);

  const payload = {
    symbol: opts.symbol,
    interval: opts.interval,
    barTimeUtc: t,
    close: fmt(close),
    vp: {
      poc: fmt(vpBands.poc[li]),
      vah: fmt(vpBands.vah[li]),
      val: fmt(vpBands.val[li]),
    },
    prevExtend: {
      vah: prev.prevExtendVah[li] != null ? fmt(prev.prevExtendVah[li]) : null,
      poc: prev.prevExtendPoc[li] != null ? fmt(prev.prevExtendPoc[li]) : null,
      val: prev.prevExtendVal[li] != null ? fmt(prev.prevExtendVal[li]) : null,
    },
    volume: {
      isSpike: Boolean(volSig.isSpike[li]),
      npoc: volSig.npoc[li] != null ? fmt(volSig.npoc[li]) : null,
    },
    rolling: {
      d7: roll7 && roll7[li] != null ? fmt(roll7[li]) : null,
      d90: roll90 && roll90[li] != null ? fmt(roll90[li]) : null,
      d365: roll365 && roll365[li] != null ? fmt(roll365[li]) : null,
    },
    meta: { bars: raw.length, historyFetched: mergedHistory.length },
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`标的 ${opts.symbol}  周期 ${opts.interval}  最后一根 UTC ${t}`);
  console.log(`收盘 ${fmt(close)}`);
  console.log(`VP: POC ${payload.vp.poc}  VAH ${payload.vp.vah}  VAL ${payload.vp.val}`);
  console.log(
    `上周期延长(当前段): VAH ${payload.prevExtend.vah ?? "—"}  POC ${payload.prevExtend.poc ?? "—"}  VAL ${payload.prevExtend.val ?? "—"}`
  );
  console.log(`放量(>34均量×3): ${payload.volume.isSpike ? "是" : "否"}  NPOC ${payload.volume.npoc ?? "—"}`);
  console.log(
    `Rolling 收盘均线: 7d ${payload.rolling.d7 ?? "—"}  90d ${payload.rolling.d90 ?? "—"}  365d ${payload.rolling.d365 ?? "—"}`
  );
  console.log(`（与详情页 index.html 同源算法；不构成投资建议）`);
}

main().catch((e) => {
  console.error(e?.stack || e?.message || e);
  process.exit(1);
});
