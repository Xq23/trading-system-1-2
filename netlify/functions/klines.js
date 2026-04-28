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
    if (!response.ok) throw new Error("HTTP " + response.status);
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "method_not_allowed" }),
    };
  }

  const params = event.queryStringParameters || {};
  const symbol = String(params.symbol || "").toUpperCase();
  const interval = String(params.interval || "");
  const limit = Number(params.limit || 500);
  if (!symbol || !interval || !Number.isFinite(limit)) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "invalid_params" }),
    };
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
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3, s-maxage=3",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify(data),
        };
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
        }
      }
    }
  }

  return {
    statusCode: 502,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "upstream_failed", detail: String(lastError?.message || "unknown") }),
  };
};
