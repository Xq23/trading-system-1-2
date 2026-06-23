/**
 * K 线实体宽度随成交量变化（ECharts custom series）
 */
(function (global) {
  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((sortedAsc.length - 1) * p)));
    return sortedAsc[idx];
  }

  function computeVolumeWidthRatios(volumes, opts = {}) {
    const minRatio = Number.isFinite(Number(opts.minRatio)) ? Number(opts.minRatio) : 0.16;
    const maxRatio = Number.isFinite(Number(opts.maxRatio)) ? Number(opts.maxRatio) : 3.4;
    const gamma = Number.isFinite(Number(opts.gamma)) ? Number(opts.gamma) : 0.32;
    const mode = opts.mode || "rank";
    const list = Array.isArray(volumes) ? volumes : [];

    if (mode === "rank") {
      const positive = [];
      list.forEach((raw, i) => {
        const v = Number(raw);
        if (Number.isFinite(v) && v > 0) positive.push({ i, v });
      });
      if (!positive.length) return list.map(() => minRatio);

      positive.sort((a, b) => a.v - b.v);
      const n = positive.length;
      const rankMap = new Map();
      positive.forEach((entry, rank) => {
        const pct = n <= 1 ? 1 : rank / (n - 1);
        rankMap.set(entry.i, pct);
      });

      return list.map((raw, i) => {
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) return minRatio;
        const pct = rankMap.get(i) ?? 0;
        const eased = Math.pow(pct, gamma);
        return minRatio + (maxRatio - minRatio) * eased;
      });
    }

    const positive = list.map(Number).filter((v) => Number.isFinite(v) && v > 0);
    if (!positive.length) return list.map(() => minRatio);

    const sorted = [...positive].sort((a, b) => a - b);
    const refMax = percentile(sorted, 0.88) || sorted[sorted.length - 1];
    const refMin = percentile(sorted, 0.08) || sorted[0];
    const span = refMax - refMin;

    return list.map((raw) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) return minRatio;
      const linear = span > 0 ? Math.min(1, Math.max(0, (v - refMin) / span)) : 1;
      const eased = Math.pow(linear, gamma);
      return minRatio + (maxRatio - minRatio) * eased;
    });
  }

  function normalizeCandleInput(item, idx, widthRatio) {
    if (!item || item === "-") {
      return { value: [idx, NaN, NaN, NaN, NaN, widthRatio] };
    }
    if (Array.isArray(item)) {
      const [open, close, low, high] = item.map(Number);
      if (![open, close, low, high].every(Number.isFinite)) {
        return { value: [idx, NaN, NaN, NaN, NaN, widthRatio] };
      }
      return {
        value: [idx, open, close, low, high, widthRatio],
      };
    }
    const open = Number(item.open ?? item.value?.[0]);
    const close = Number(item.close ?? item.value?.[1]);
    const low = Number(item.low ?? item.value?.[2]);
    const high = Number(item.high ?? item.value?.[3]);
    if (![open, close, low, high].every(Number.isFinite)) {
      return { value: [idx, NaN, NaN, NaN, NaN, widthRatio] };
    }
    const row = {
      value: [idx, open, close, low, high, widthRatio],
    };
    if (item.itemStyle) row.itemStyle = item.itemStyle;
    return row;
  }

  function renderVolumeCandleItem(params, api) {
    const open = api.value(1);
    const close = api.value(2);
    const low = api.value(3);
    const high = api.value(4);
    const widthRatio = api.value(5);
    if (![open, close, low, high, widthRatio].every(Number.isFinite)) return;

    const xIdx = api.value(0);
    const xCenter = api.coord([xIdx, close])[0];
    const yOpen = api.coord([xIdx, open])[1];
    const yClose = api.coord([xIdx, close])[1];
    const yLow = api.coord([xIdx, low])[1];
    const yHigh = api.coord([xIdx, high])[1];

    const band = api.size([1, 0])[0];
    const bodyW = Math.max(0.9, band * widthRatio);
    const wickW = Math.max(1, Math.min(5, 0.75 + bodyW * 0.05));

    const bullish = close >= open;
    const style = params.data?.itemStyle || {};
    const upFill = style.color || "#17c964";
    const downFill = style.color0 || style.color || "#f31260";
    const fill = bullish ? upFill : downFill;
    const stroke = bullish
      ? style.borderColor || fill
      : style.borderColor0 || style.borderColor || fill;

    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));

    return {
      type: "group",
      children: [
        {
          type: "line",
          shape: { x1: xCenter, y1: yHigh, x2: xCenter, y2: yLow },
          style: { stroke, lineWidth: wickW },
        },
        {
          type: "rect",
          shape: { x: xCenter - bodyW / 2, y: bodyTop, width: bodyW, height: bodyH },
          style: {
            fill,
            shadowBlur: style.shadowBlur || 0,
            shadowColor: style.shadowColor || "transparent",
          },
        },
      ],
    };
  }

  function createSeries(options = {}) {
    const {
      candles = [],
      volumes = [],
      z = 18,
      silent = false,
      name = "K线",
      progressive = 1000,
      progressiveThreshold = 1500,
      markPoint,
      minRatio,
      maxRatio,
      gamma,
      mode,
    } = options;
    const ratios = computeVolumeWidthRatios(volumes, { minRatio, maxRatio, gamma, mode });
    const data = [];
    for (let i = 0; i < candles.length; i += 1) {
      data.push(normalizeCandleInput(candles[i], i, ratios[i] ?? minRatio ?? 0.16));
    }
    const series = {
      name,
      type: "custom",
      z,
      silent,
      progressive,
      progressiveThreshold,
      clip: true,
      data,
      renderItem: renderVolumeCandleItem,
    };
    if (markPoint) series.markPoint = markPoint;
    return series;
  }

  global.Ts12CandleVolume = {
    computeVolumeWidthRatios,
    createSeries,
  };
})(typeof window !== "undefined" ? window : globalThis);
