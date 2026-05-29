/**
 * 币安 U 本位永续合约列表与解析（含 TradFi 贵金属如 XAUUSDT）
 */
(function (global) {
  const EXCHANGE_INFO_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
  const QUOTE_SUFFIXES = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"];

  /** 币安部分 TradFi 永续 contractType 仍为 PERPETUAL，需结合 underlyingType / baseAsset */
  const KNOWN_TRADFI_BASES = new Set([
    "XAU",
    "XAG",
    "CL",
    "BZ",
    "NATGAS",
    "TSLA",
    "INTC",
    "CRCL",
    "AAPL",
    "AMZN",
    "GOOG",
    "GOOGL",
    "META",
    "MSFT",
    "NVDA",
    "MSTR",
    "EWY",
    "EWJ",
    "CBRS",
  ]);

  /** 加密综合指数合约（underlyingType 可能非 COIN，但属于币圈指数） */
  const CRYPTO_COMPOSITE_BASES = new Set(["DEFI", "BTCDOM"]);

  function isTradableUsdtPerpetual(item) {
    if (!item?.symbol || item?.status !== "TRADING") return false;
    const ct = String(item.contractType || "");
    const perpetualLike =
      ct === "PERPETUAL" || ct === "TRADFI_PERPETUAL" || ct.endsWith("_PERPETUAL");
    if (!perpetualLike) return false;
    const quote = String(item.quoteAsset || "").toUpperCase();
    if (quote) return QUOTE_SUFFIXES.includes(quote);
    const sym = String(item.symbol).toUpperCase();
    return QUOTE_SUFFIXES.some((q) => sym.endsWith(q));
  }

  function isTradFiPerpetual(item) {
    if (!item) return false;
    const ct = String(item.contractType || "").toUpperCase();
    if (ct === "TRADFI_PERPETUAL" || ct.includes("TRADFI")) return true;

    const base = String(item.baseAsset || "").toUpperCase();
    if (CRYPTO_COMPOSITE_BASES.has(base)) return false;
    if (KNOWN_TRADFI_BASES.has(base)) return true;

    const ut = String(item.underlyingType || "").toUpperCase();
    if (ut === "COIN") return false;

    const subs = Array.isArray(item.underlyingSubType)
      ? item.underlyingSubType.map((s) => String(s).toUpperCase())
      : [];
    if (subs.some((s) => /COMMODIT|METAL|PRECIOUS|ENERGY|EQUITY|STOCK|TRADFI/.test(s))) {
      return true;
    }

    // 非 COIN 的 USDT 永续多为 TradFi（黄金/原油/股票等），contractType 常为 PERPETUAL
    if (ut && ut !== "COIN") return true;

    return false;
  }

  function isCryptoPerpetual(item) {
    return isTradableUsdtPerpetual(item) && !isTradFiPerpetual(item);
  }

  function getSymbolMarketType(item) {
    return isTradFiPerpetual(item) ? "tradfi" : "crypto";
  }

  function listUsdtPerpetualSymbols(map, marketFilter) {
    const f = String(marketFilter || "all").toLowerCase();
    const symbols = [];
    for (const [sym, item] of map) {
      if (!String(sym).endsWith("USDT")) continue;
      const type = getSymbolMarketType(item);
      if (f === "crypto" && type !== "crypto") continue;
      if (f === "tradfi" && type !== "tradfi") continue;
      symbols.push(sym);
    }
    symbols.sort((a, b) => a.localeCompare(b));
    return symbols;
  }

  function marketFilterLabel(marketFilter) {
    const f = String(marketFilter || "all").toLowerCase();
    if (f === "crypto") return "原生数字货币";
    if (f === "tradfi") return "TradFi";
    return "全部 USDT 永续";
  }

  function buildMapFromExchangeInfo(info) {
    const map = new Map();
    for (const item of info?.symbols || []) {
      if (!isTradableUsdtPerpetual(item)) continue;
      map.set(String(item.symbol).toUpperCase(), item);
    }
    return map;
  }

  function candidateSymbolsForInput(clean) {
    const candidates = [clean];
    if (!QUOTE_SUFFIXES.some((q) => clean.endsWith(q))) {
      for (const q of QUOTE_SUFFIXES) candidates.push(`${clean}${q}`);
    }
    return candidates;
  }

  function resolveFromMap(input, map) {
    const clean = String(input || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!clean) throw new Error("请输入交易对");
    for (const candidate of candidateSymbolsForInput(clean)) {
      if (map.has(candidate)) return candidate;
    }
    const hasQuoteSuffix = QUOTE_SUFFIXES.some((q) => clean.endsWith(q));
    if (!hasQuoteSuffix) {
      for (const [sym, item] of map) {
        if (String(item.baseAsset || "").toUpperCase() === clean) return sym;
      }
    }
    throw new Error(
      "未在币安 U 本位永续中找到该交易对。贵金属请试 XAU、XAG 或 XAUUSDT；需为合约而非现货"
    );
  }

  async function fetchExchangeInfo(fetchJsonWithTimeout, timeoutMs) {
    try {
      return await fetchJsonWithTimeout(EXCHANGE_INFO_URL, timeoutMs);
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("连接币安超时，请检查网络或代理后重试");
      }
      if (err?.message && !/^HTTP /.test(err.message)) throw err;
      throw new Error("无法访问币安合约 API（fapi.binance.com），请检查网络");
    }
  }

  global.Ts12BinanceFutures = {
    EXCHANGE_INFO_URL,
    QUOTE_SUFFIXES,
    isTradableUsdtPerpetual,
    isTradFiPerpetual,
    isCryptoPerpetual,
    getSymbolMarketType,
    listUsdtPerpetualSymbols,
    marketFilterLabel,
    buildMapFromExchangeInfo,
    resolveFromMap,
    fetchExchangeInfo,
  };
})(typeof window !== "undefined" ? window : globalThis);
