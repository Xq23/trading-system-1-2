const DEFAULT_FAPI_BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

const VALID_INTERVALS = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"]);

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

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "ts12-market-proxy/1.0" },
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

export async function fetchFromFapi(path) {
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

export function normalizeMarketSymbol(raw) {
  const symbol = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!symbol || symbol.length > 32) return { error: "无效交易对" };
  return { symbol };
}

export function normalizeMarketInterval(raw) {
  const interval = String(raw || "").trim();
  if (!VALID_INTERVALS.has(interval)) return { error: "无效 K 线周期" };
  return { interval };
}

export async function getMarketKlines({ symbol, interval, limit = 500, endTime } = {}) {
  const sym = normalizeMarketSymbol(symbol);
  if (sym.error) return sym;
  const iv = normalizeMarketInterval(interval);
  if (iv.error) return iv;
  const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1500);
  let path =
    `/fapi/v1/klines?symbol=${encodeURIComponent(sym.symbol)}` +
    `&interval=${encodeURIComponent(iv.interval)}` +
    `&limit=${encodeURIComponent(String(safeLimit))}`;
  if (endTime != null && endTime !== "") {
    const end = Number(endTime);
    if (!Number.isFinite(end) || end <= 0) return { error: "无效 endTime" };
    path += `&endTime=${encodeURIComponent(String(Math.floor(end)))}`;
  }
  const klines = await fetchFromFapi(path);
  if (!Array.isArray(klines)) return { error: "币安返回格式异常" };
  return { klines, source: "binance" };
}

let exchangeInfoCache = { data: null, fetchedAt: 0 };

export async function getMarketExchangeInfo({ maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (exchangeInfoCache.data && now - exchangeInfoCache.fetchedAt < maxAgeMs) {
    return { exchangeInfo: exchangeInfoCache.data, cached: true, source: "binance" };
  }
  const exchangeInfo = await fetchFromFapi("/fapi/v1/exchangeInfo");
  if (!exchangeInfo || typeof exchangeInfo !== "object") return { error: "币安返回格式异常" };
  exchangeInfoCache = { data: exchangeInfo, fetchedAt: now };
  return { exchangeInfo, cached: false, source: "binance" };
}
