/** 币安 U 本位永续：区分原生数字货币与 TradFi（与 scripts/ts12-binance-futures.js 逻辑一致） */

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

const CRYPTO_COMPOSITE_BASES = new Set(["DEFI", "BTCDOM"]);

export function isTradableUsdtPerpetual(item) {
  if (!item?.symbol || item?.status !== "TRADING") return false;
  const ct = String(item.contractType || "");
  const perpetualLike =
    ct === "PERPETUAL" || ct === "TRADFI_PERPETUAL" || ct.endsWith("_PERPETUAL");
  if (!perpetualLike) return false;
  const quote = String(item.quoteAsset || "").toUpperCase();
  if (quote) return quote === "USDT";
  return String(item.symbol).toUpperCase().endsWith("USDT");
}

export function isTradFiPerpetual(item) {
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

  if (ut && ut !== "COIN") return true;

  return false;
}

export function isCryptoUsdtPerpetual(item) {
  return isTradableUsdtPerpetual(item) && !isTradFiPerpetual(item);
}

export function listCryptoUsdtPerpetualSymbols(exchangeInfo) {
  return (exchangeInfo?.symbols || [])
    .filter(isCryptoUsdtPerpetual)
    .map((item) => String(item.symbol).toUpperCase())
    .filter((sym) => sym.endsWith("USDT"))
    .sort((a, b) => a.localeCompare(b));
}
