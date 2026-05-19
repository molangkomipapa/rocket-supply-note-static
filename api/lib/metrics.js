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

export function buildMetrics(priceData, daily, programRows) {
  const today = daily[0];
  const recent3 = daily.slice(0, 3);
  const recent5 = daily.slice(0, 5);
  const recent10 = daily.slice(0, 10);
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
  const candleRange = (d) =>
    d.close > 0 ? ((d.high - d.low) / d.close) * 100 : 0;
  const bodyRate = price > 0 ? ((price - open) / price) * 100 : 0;

  return {
    price,
    open,
    high,
    low,
    todayVolume,
    prevVolume,
    prevClose,
    changeRate: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    threeDayChange:
      daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0,
    ma5,
    ma20,
    ma60,
    ma20Slope: ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0,
    low20,
    high20,
    recentLow10: recent10.length > 1
      ? Math.min(...recent10.slice(1).map((d) => d.low))
      : low20,
    range5: low5 > 0 ? ((high5 - low5) / low5) * 100 : 999,
    range10: low10 > 0 ? ((high10 - low10) / low10) * 100 : 999,
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
    ma20Position: m.price >= m.ma20 ? "20일선 위" : "20일선 아래",
    trend: m.ma20 > m.ma60 ? "20일선 > 60일선" : "20일선 <= 60일선",
    program: m.programFlow.label,
    programDetail: m.programFlow.detail
  };
}

function analyzeProgramContinuity(rows) {
  const recent = (rows || []).slice(0, 30);
  const values = recent.map(getProgramNetValue);
  const recent3 = values.slice(0, 3);
  const recent5 = values.slice(0, 5);
  const recent10 = values.slice(0, 10);
  const positiveDays = recent5.filter((v) => v > 0).length;
  const positiveDays3 = recent3.filter((v) => v > 0).length;
  const positiveDays10 = recent10.filter((v) => v > 0).length;
  const positiveDays30 = values.filter((v) => v > 0).length;
  const threeDayPositive =
    recent3.length === 3 && recent3.every((v) => v > 0);
  const totalNet = values.reduce((sum, value) => sum + value, 0);

  return {
    available: recent.length > 0,
    positiveDays,
    positiveDays3,
    positiveDays10,
    positiveDays30,
    threeDayPositive,
    totalNet,
    label: threeDayPositive
      ? "프로그램 순매수 지속"
      : positiveDays >= 3
      ? "프로그램 순매수 우위"
      : positiveDays > 0
      ? "프로그램 단발 유입"
      : "프로그램 확인 대기",
    detail: recent.length
      ? `최근 ${recent.length}일 중 ${positiveDays}일 순매수`
      : "외국인/기관 직접 수급 API 연결 전"
  };
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
