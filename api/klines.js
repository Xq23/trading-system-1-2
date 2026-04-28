const HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function validateKlines(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("empty klines");
  }
  return raw;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "public, max-age=3, s-maxage=3");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const symbol = String(req.query.symbol || "").toUpperCase();
  const interval = String(req.query.interval || "");
  const limit = Number(req.query.limit || 500);
  if (!symbol || !interval || !Number.isFinite(limit)) {
    res.status(400).json({ error: "invalid_params" });
    return;
  }

  const queryStr =
    "symbol=" +
    encodeURIComponent(symbol) +
    "&interval=" +
    encodeURIComponent(interval) +
    "&limit=" +
    encodeURIComponent(Math.max(1, Math.min(1500, Math.floor(limit))));

  let lastError = null;
  for (const host of HOSTS) {
    const url = host + "/fapi/v1/klines?" + queryStr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const raw = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
        const data = validateKlines(raw);
        res.status(200).json(data);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
        }
      }
    }
  }

  res.status(502).json({ error: "upstream_failed", detail: String(lastError?.message || "unknown") });
};
