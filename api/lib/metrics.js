export const MIN_DAILY_COUNT = 60;

export function normalizeDaily(raw) {
  return (raw || [])
    .map((d) => ({
      close: toNumber(d.stck_clpr),
      open: toNumber(d.stck_oprc),
      high: toNumber(d.stck_hgpr),
      low: toNumber(d.stck_lwpr),
      volume: toNumber(d.acml_vol)
    }))
    .filter((d) => d.close > 0)
    .slice(0, 80);
}

export function buildMetrics(priceData, daily, programRows, item = {}) {
  const today = daily[0];
  const recent3 = daily.slice(0, 3);
  const recent5 = daily.slice(0, 5);
  const recent10 = daily.slice(0, 10);
  const recent15 = daily.slice(0, 15);
  const recent20 = daily.slice(0, 20);
  const recent60 = daily.slice(0, 60);
  const price = toNumber(priceData.stck_prpr) || today.close;
  const open = toNumber(priceData.stck_oprc) || today.open;
  const high = toNumber(priceData.stck_hgpr) || today.high;
  const low = toNumber(priceData.stck_lwpr) || today.low;
  const todayVolume = toNumber(priceData.acml_vol) || today.volume;
  const prevClose = daily[1]?.close || 0;
  const prevVolume = daily[1]?.volume || 0;
  const ma5 = avg(recent5.map((d) => d.close));
  const ma20 = avg(recent20.map((d) => d.close));
  const ma60 = avg(recent60.map((d) => d.close));
  const ma20Prev5 = avg(daily.slice(5, 25).map((d) => d.close));
  const avgVol5 = avg(recent5.map((d) => d.volume));
  const avgVol20 = avg(recent20.map((d) => d.volume));
  const high20 = Math.max(...recent20.map((d) => d.high));
  const low20 = Math.min(...recent20.map((d) => d.low));
  const high5 = Math.max(...recent5.map((d) => d.high));
  const low5 = Math.min(...recent5.map((d) => d.low));
  const high10 = Math.max(...recent10.map((d) => d.high));
  const low10 = Math.min(...recent10.map((d) => d.low));
  const high15 = Math.max(...recent15.map((d) => d.high));
  const low15 = Math.min(...recent15.map((d) => d.low));
  const candleRange = (d) =>
    d.close > 0 ? ((d.high - d.low) / d.close) * 100 : 0;
  const bodyRate = price > 0 ? ((price - open) / price) * 100 : 0;
  const recentBigBullCandle = recent10.some((d) => {
    const body = d.close > 0 ? ((d.close - d.open) / d.close) * 100 : 0;
    return body >= 5 && avgVol20 > 0 && d.volume >= avgVol20 * 1.5;
  });

  return {
    price,
    open,
    high,
    low,
    todayVolume,
    tradeValue: price * todayVolume,
    marketCap: Number(item.marketCap || 0),
    prevVolume,
    prevClose,
    changeRate: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    threeDayChange:
      daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0,
    fiveDayChange:
      daily[4]?.close > 0 ? ((price - daily[4].close) / daily[4].close) * 100 : 0,
    tenDayChange:
      daily[9]?.close > 0 ? ((price - daily[9].close) / daily[9].close) * 100 : 0,
    fifteenDayChange:
      daily[14]?.close > 0 ? ((price - daily[14].close) / daily[14].close) * 100 : 0,
    ma5,
    ma20,
    ma60,
    ma5Ma20Gap: ma20 > 0 ? (Math.abs(ma5 - ma20) / ma20) * 100 : 999,
    ma20Slope: ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0,
    low20,
    high20,
    recentLow10: recent10.length > 1
      ? Math.min(...recent10.slice(1).map((d) => d.low))
      : low20,
    range5: low5 > 0 ? ((high5 - low5) / low5) * 100 : 999,
    range10: low10 > 0 ? ((high10 - low10) / low10) * 100 : 999,
    range15: low15 > 0 ? ((high15 - low15) / low15) * 100 : 999,
    avgRange3: avg(recent3.map(candleRange)),
    avgRange5: avg(recent5.map(candleRange)),
    volRel5_20: avgVol20 > 0 ? avgVol5 / avgVol20 : 1,
    volRelToday20: avgVol20 > 0 ? todayVolume / avgVol20 : 1,
    volumeRecoveryDays: recent5.filter((d) => avgVol20 > 0 && d.volume >= avgVol20).length,
    volBuild3:
      recent3.length === 3 &&
      recent3[0].volume >= recent3[1].volume &&
      recent3[1].volume >= recent3[2].volume,
    intradayRebound: low > 0 ? ((price - low) / low) * 100 : 0,
    pullbackFromHigh20: high20 > 0 ? ((high20 - price) / high20) * 100 : 0,
    pullbackFromTodayHigh: high > 0 ? ((high - price) / high) * 100 : 0,
    upperWickRatio: getUpperWickRatio({ open, high, low, close: price }),
    recentUpperWickCount: recent5.filter((d) => getUpperWickRatio(d) >= 0.4).length,
    bodyRate,
    recentBigBullCandle,
    longBearCandle:
      bodyRate <= -4 && todayVolume >= avgVol20 * 1.2 && price <= low * 1.03,
    programFlow: analyzeProgramContinuity(programRows)
  };
}

export function makeMetricSummary(m) {
  return {
    price: m.price,
    changeRate: Number(m.changeRate.toFixed(2)),
    pullbackFromHigh20: Number(m.pullbackFromHigh20.toFixed(1)),
    pullbackFromTodayHigh: Number(m.pullbackFromTodayHigh.toFixed(1)),
    volRelToday20: Number(m.volRelToday20.toFixed(2)),
    volRel5_20: Number(m.volRel5_20.toFixed(2)),
    tradeValueEok: Number((m.tradeValue / 100000000).toFixed(1)),
    marketCapEok: Number((m.marketCap / 100000000).toFixed(1)),
    ma5Ma20Gap: Number(m.ma5Ma20Gap.toFixed(1)),
    tenDayChange: Number(m.tenDayChange.toFixed(1)),
    ma20Position: m.price >= m.ma20 ? "20일선 위" : "20일선 아래",
    trend: m.ma20 > m.ma60 ? "20일선 > 60일선" : "20일선 <= 60일선",
    program: m.programFlow.label,
    programDetail: m.programFlow.detail,
    programBuyDays5: m.programFlow.buyDays5,
    programBuyMomentum: Number(m.programFlow.buyMomentum.toFixed(2))
  };
}

function analyzeProgramContinuity(rows) {
  const recent = (rows || []).slice(0, 30);
  const values = recent.map(getProgramNetValue);
  const buyValues = recent.map(getProgramBuyValue);
  const sellValues = recent.map(getProgramSellValue);
  const recent3 = values.slice(0, 3);
  const recent5 = values.slice(0, 5);
  const recent10 = values.slice(0, 10);
  const buyRecent3 = buyValues.slice(0, 3);
  const buyRecent5 = buyValues.slice(0, 5);
  const buyRecent10 = buyValues.slice(0, 10);
  const buyRecent20 = buyValues.slice(0, 20);
  const positiveDays = recent5.filter((v) => v > 0).length;
  const positiveDays3 = recent3.filter((v) => v > 0).length;
  const positiveDays10 = recent10.filter((v) => v > 0).length;
  const positiveDays30 = values.filter((v) => v > 0).length;
  const buyDays3 = buyRecent3.filter((v) => v > 0).length;
  const buyDays5 = buyRecent5.filter((v) => v > 0).length;
  const buyDays10 = buyRecent10.filter((v) => v > 0).length;
  const buyDays30 = buyValues.filter((v) => v > 0).length;
  const threeDayPositive =
    recent3.length === 3 && recent3.every((v) => v > 0);
  const totalNet = values.reduce((sum, value) => sum + value, 0);
  const totalBuy = buyValues.reduce((sum, value) => sum + value, 0);
  const totalSell = sellValues.reduce((sum, value) => sum + value, 0);
  const buyTotal5 = buyRecent5.reduce((sum, value) => sum + value, 0);
  const buyTotal20 = buyRecent20.reduce((sum, value) => sum + value, 0);
  const avgBuy5 = avg(buyRecent5);
  const avgBuy20 = avg(buyRecent20);
  const buyMomentum = avgBuy20 > 0 ? avgBuy5 / avgBuy20 : 0;

  return {
    available: recent.length > 0,
    positiveDays,
    positiveDays3,
    positiveDays10,
    positiveDays30,
    buyDays3,
    buyDays5,
    buyDays10,
    buyDays30,
    threeDayPositive,
    totalNet,
    totalBuy,
    totalSell,
    buyTotal5,
    buyTotal20,
    buyMomentum,
    buyDominant: totalBuy > 0 && totalBuy >= totalSell,
    label: threeDayPositive
      ? "프로그램 순매수 지속"
      : positiveDays >= 3
      ? "프로그램 순매수 우위"
      : positiveDays > 0
      ? "프로그램 단발 유입"
      : "프로그램 확인 대기",
    detail: recent.length
      ? `최근 ${recent.length}일 중 ${positiveDays}일 순매수 · 매수 ${buyDays5}일`
      : "외국인/기관 직접 수급 API 연결 전"
  };
}

function getProgramBuyValue(row) {
  const direct = pickNumber(row, [
    "shnu_tr_pbmn",
    "SHNU_TR_PBMN",
    "prgm_buy_tr_pbmn",
    "buy_tr_pbmn",
    "shnu_cnqn",
    "SHNU_CNQN",
    "buy_cnqn"
  ]);
  if (direct) return direct;

  const net = getProgramNetValue(row);
  return net > 0 ? net : 0;
}

function getProgramSellValue(row) {
  const direct = pickNumber(row, [
    "seln_tr_pbmn",
    "SELN_TR_PBMN",
    "prgm_sell_tr_pbmn",
    "sell_tr_pbmn",
    "seln_cnqn",
    "SELN_CNQN",
    "sell_cnqn"
  ]);
  if (direct) return direct;

  const net = getProgramNetValue(row);
  return net < 0 ? Math.abs(net) : 0;
}

function getProgramNetValue(row) {
  const direct = pickNumber(row, [
    "prgm_ntby_tr_pbmn",
    "prgm_ntby_pbmn",
    "ntby_tr_pbmn",
    "NTBY_TR_PBMN",
    "whol_ntby_tr_pbmn",
    "acml_ntby_tr_pbmn"
  ]);
  if (direct) return direct;

  const buy = pickNumber(row, [
    "shnu_tr_pbmn",
    "SHNU_TR_PBMN",
    "prgm_buy_tr_pbmn",
    "buy_tr_pbmn"
  ]);
  const sell = pickNumber(row, [
    "seln_tr_pbmn",
    "SELN_TR_PBMN",
    "prgm_sell_tr_pbmn",
    "sell_tr_pbmn"
  ]);
  if (buy || sell) return buy - sell;

  return pickNumber(row, [
    "prgm_ntby_qty",
    "ntby_cnqn",
    "NTBY_CNQN",
    "whol_ntby_qty",
    "acml_ntby_qty"
  ]);
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") {
      const number = toNumber(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return 0;
}

function getUpperWickRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return (candle.high - Math.max(candle.close, candle.open)) / range;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toNumber(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}
