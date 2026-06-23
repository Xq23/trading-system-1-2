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
    const minRatio = Number(opts.minRatio) || 0.08;
    const maxRatio = Number(opts.maxRatio) || 1;
    const gamma = Number(opts.gamma) || 0.45;
    const list = Array.isArray(volumes) ? volumes : [];
    const positive = list.map(Number).filter((v) => Number.isFinite(v) && v > 0);
    if (!positive.length) return list.map(() => minRatio);

    const sorted = [...positive].sort((a, b) => a - b);
    const refMax = percentile(sorted, 0.92) || sorted[sorted.length - 1];
    const ref = refMax > 0 ? refMax : sorted[sorted.length - 1];

    return list.map((raw) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) return minRatio;
      const linear = Math.min(1, Math.max(0, v / ref));
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
    const bodyW = Math.max(1.5, band * widthRatio * 0.96);
    const wickW = Math.max(1, Math.min(4, 1 + bodyW * 0.08));

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
    } = options;
    const ratios = computeVolumeWidthRatios(volumes, { minRatio, maxRatio, gamma });
    const data = [];
    for (let i = 0; i < candles.length; i += 1) {
      data.push(normalizeCandleInput(candles[i], i, ratios[i] ?? minRatio ?? 0.08));
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
