/**
 * K 线实体宽度随成交量变化（ECharts custom series）
 */
(function (global) {
  function computeVolumeWidthRatios(volumes, opts = {}) {
    const lookback = Math.max(2, Number(opts.lookback) || 34);
    const minRatio = Number(opts.minRatio) || 0.26;
    const maxRatio = Number(opts.maxRatio) || 1;
    const list = Array.isArray(volumes) ? volumes : [];
    const ratios = new Array(list.length);
    for (let i = 0; i < list.length; i += 1) {
      const v = Number(list[i]);
      if (!Number.isFinite(v) || v <= 0) {
        ratios[i] = minRatio;
        continue;
      }
      const start = Math.max(0, i - lookback + 1);
      let maxV = 0;
      for (let j = start; j <= i; j += 1) {
        const vv = Number(list[j]);
        if (Number.isFinite(vv) && vv > maxV) maxV = vv;
      }
      const ref = maxV > 0 ? maxV : v;
      const linear = Math.min(1, Math.max(0, v / ref));
      const eased = Math.sqrt(linear);
      ratios[i] = minRatio + (maxRatio - minRatio) * eased;
    }
    return ratios;
  }

  function normalizeCandleInput(item, idx, widthRatio) {
    if (!item || item === "-") {
      return { value: [idx, NaN, NaN, NaN, NaN, widthRatio] };
    }
    if (Array.isArray(item)) {
      const [open, close, low, high] = item.map(Number);
      if (![open, close, low, high].every(Number.isFinite)) return null;
      return {
        value: [idx, open, close, low, high, widthRatio],
      };
    }
    const open = Number(item.open ?? item.value?.[0]);
    const close = Number(item.close ?? item.value?.[1]);
    const low = Number(item.low ?? item.value?.[2]);
    const high = Number(item.high ?? item.value?.[3]);
    if (![open, close, low, high].every(Number.isFinite)) return null;
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
    const bodyW = Math.max(2, band * widthRatio * 0.88);
    const wickW = Math.max(1, Math.min(3, bodyW * 0.16));

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
      lookback = 34,
      z = 18,
      silent = false,
      name = "K线",
      progressive = 1000,
      progressiveThreshold = 1500,
      markPoint,
    } = options;
    const ratios = computeVolumeWidthRatios(volumes, { lookback });
    const data = [];
    for (let i = 0; i < candles.length; i += 1) {
      data.push(normalizeCandleInput(candles[i], i, ratios[i] ?? 0.26));
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
