export const INTERVAL_4H = "4h";
export const BASELINE_BARS = 30;
export const SINGLE_RATIO = 10;
export const DOUBLE_RATIO = 5;
export const FOUR_H_MS = 4 * 60 * 60 * 1000;
export const SCAN_AFTER_CLOSE_MS = 45000;

export function makeSymbolKey(exchangeSymbol) {
  return String(exchangeSymbol || "").trim().toUpperCase();
}

function averageVolume(bars) {
  if (!bars.length) return 0;
  return bars.reduce((acc, k) => acc + Number(k[5] || 0), 0) / bars.length;
}

/** 针对指定 4h 收线批次（triggerOpenTime）评估单币种是否触发预警 */
export function evaluateVolumeAlertsForTrigger(exchangeSymbol, klines, triggerOpenTime) {
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

export function getLatestClosed4hOpenTime(now = Date.now()) {
  const closedBoundary = Math.floor(now / FOUR_H_MS) * FOUR_H_MS;
  return closedBoundary - FOUR_H_MS;
}

export function getNext4hCloseMs(now = Date.now()) {
  return Math.ceil(now / FOUR_H_MS) * FOUR_H_MS;
}

/** 自 lastProcessed 之后、且已收线的 4h 批次 */
export function listPendingTriggerTimes(lastProcessed, now = Date.now()) {
  const latest = getLatestClosed4hOpenTime(now);
  if (lastProcessed == null || !Number.isFinite(Number(lastProcessed))) {
    return [latest];
  }
  const times = [];
  let t = Number(lastProcessed) + FOUR_H_MS;
  while (t <= latest) {
    times.push(t);
    t += FOUR_H_MS;
  }
  return times;
}

function dateKeyInTimeZone(ms, timeZone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** 指定时区「今天」已收线的 4h 批次（按开盘 UTC 时间升序） */
export function listTodayClosedTriggers(timeZone = "Asia/Shanghai", now = Date.now()) {
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
