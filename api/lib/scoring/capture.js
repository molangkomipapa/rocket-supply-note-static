import { makeScore } from "./common.js";

const CAPTURE_LABELS = [
  "최우선 포착",
  "매수후보",
  "분할관심",
  "관찰후보",
  "제외"
];

export function scoreCapture(m) {
  const rested = isRested(m);
  const lowMaintained = m.price >= m.recentLow10 * 0.995;
  const ma20Support = m.price >= m.ma20 * 0.98;
  const shortMaSupport = m.price >= Math.min(m.ma5, m.ma20) * 0.985;
  const volatile =
    m.avgRange3 > m.avgRange5 * 1.15 || m.range5 > m.range10 * 1.05;
  const hardChaseRisk =
    m.changeRate >= 5 ||
    m.threeDayChange >= 15 ||
    m.fiveDayChange >= 18 ||
    m.tenDayChange >= 25 ||
    m.volRelToday20 >= 3 ||
    m.longBearCandle ||
    (m.recentBigBullCandle && m.pullbackFromHigh20 < 5);

  const lowScore = lowPoint(lowMaintained, ma20Support, shortMaSupport, volatile);
  const compressionScore = compressionPoint(m);
  const pullbackScore = pullbackPoint(m);
  const volumeScore = volumeStabilityPoint(m);
  const restartScore = earlyRestartPoint(m);
  const trendScore = trendPoint(m);

  const checks = [
    {
      label: gradeLabel("저점 유지", lowScore),
      points: lowScore
    },
    {
      label: gradeLabel("압축 구조", compressionScore),
      points: compressionScore
    },
    {
      label: gradeLabel("눌림 위치", pullbackScore),
      points: pullbackScore
    },
    {
      label: gradeLabel("거래량 안정성", volumeScore),
      points: volumeScore
    },
    {
      label: gradeLabel("초기 재출발 신호", restartScore),
      points: restartScore
    },
    {
      label: gradeLabel("추세 유지", trendScore),
      points: trendScore
    }
  ];

  const score = makeScore("포착", "capture", checks, CAPTURE_LABELS);
  score.status = getCaptureGrade(score.score);

  const heatPenalty = heatRiskPenalty(m, rested);
  if (heatPenalty > 0 || !rested) {
    const restPenalty = rested ? 0 : 10;
    const totalPenalty = heatPenalty + restPenalty;
    score.score = Math.max(0, score.score - totalPenalty);
    score.failed.push(rested ? "포착 과열 감점" : "충분한 휴식 부족");
    score.checks.push({
      label: `포착 위치 감점 -${totalPenalty}`,
      ok: false,
      points: -totalPenalty
    });
    score.status = getCaptureGrade(score.score);
  }

  if (hardChaseRisk) {
    score.failed.push("당일급등 탭 우선 확인");
  }

  return score;
}

export function getCaptureGrade(score) {
  if (score >= 85) return "최우선 포착";
  if (score >= 75) return "매수후보";
  if (score >= 65) return "분할관심";
  if (score >= 55) return "관찰후보";
  return "제외";
}

function lowPoint(lowMaintained, ma20Support, shortMaSupport, volatile) {
  if (lowMaintained && ma20Support) return 30;
  if (lowMaintained && shortMaSupport && !volatile) return 24;
  if (lowMaintained) return 15;
  return 0;
}

function compressionPoint(m) {
  const candleCompressed = m.avgRange3 <= m.avgRange5 * 0.9;
  const rangeCompressed = m.range5 <= m.range10 * 0.85;
  const maCompressed = m.ma5Ma20Gap <= 3;
  const maTight = m.ma5Ma20Gap <= 5;
  const restedBox = m.range15 <= 18 || m.range10 <= 14;
  const sideways = restedBox && m.avgRange3 <= m.avgRange5 * 1.05;

  if (candleCompressed && rangeCompressed && maCompressed) return 25;
  if ((rangeCompressed && maTight) || (candleCompressed && maCompressed)) return 18;
  if (sideways) return 10;
  return 0;
}

function pullbackPoint(m) {
  const ma20Distance = m.ma20 > 0 ? ((m.price - m.ma20) / m.ma20) * 100 : 999;

  if (
    m.pullbackFromHigh20 >= 5 &&
    m.pullbackFromHigh20 <= 15 &&
    ma20Distance <= 5
  ) {
    return 20;
  }
  if (
    (m.pullbackFromHigh20 >= 3 && m.pullbackFromHigh20 < 5) ||
    (m.pullbackFromHigh20 > 15 && m.pullbackFromHigh20 <= 20) ||
    (m.pullbackFromHigh20 >= 5 && m.pullbackFromHigh20 <= 15)
  ) {
    return 14;
  }
  if (m.pullbackFromHigh20 < 3) return 7;
  return 0;
}

function volumeStabilityPoint(m) {
  if (
    m.volRelToday20 >= 0.6 &&
    m.volRelToday20 <= 1.5 &&
    m.volRel5_20 >= 0.5 &&
    m.volRel5_20 <= 1.2
  ) {
    return 15;
  }
  if (
    (m.volRelToday20 >= 0.4 && m.volRelToday20 < 0.6) ||
    (m.volRelToday20 > 1.5 && m.volRelToday20 <= 2.2) ||
    (m.volRel5_20 > 1.2 && m.volRel5_20 <= 1.6)
  ) {
    return 10;
  }
  if (m.volRelToday20 < 0.4) return 5;
  return 0;
}

function trendPoint(m) {
  if (m.ma20 > m.ma60 || m.price > m.ma60) return 5;
  if (m.price >= m.ma60 * 0.98) return 3;
  return 0;
}

function earlyRestartPoint(m) {
  const gentleMove = m.changeRate <= 3 && m.volRelToday20 < 2.2;
  const signalCount = [
    m.price >= m.open,
    m.price >= m.ma5,
    m.intradayRebound >= 0.8
  ].filter(Boolean).length;
  if (gentleMove && signalCount >= 2) return 5;
  if (gentleMove && signalCount >= 1) return 3;
  return 0;
}

function heatRiskPenalty(m, rested) {
  let penalty = 0;
  if (m.changeRate >= 6) penalty += 35;
  else if (m.changeRate >= 5) penalty += 25;
  else if (m.changeRate >= 4) penalty += 15;
  else if (m.changeRate > 2.5) penalty += 7;

  if (m.volRelToday20 >= 3) penalty += 30;
  else if (m.volRelToday20 > 2.2) penalty += 12;

  if (m.threeDayChange >= 15) penalty += 20;
  if (m.fiveDayChange >= 18) penalty += 20;
  if (m.tenDayChange >= 25) penalty += 20;
  if (m.price > m.ma20 * 1.08) penalty += 15;
  if (m.recentBigBullCandle && m.pullbackFromHigh20 < 5) penalty += 20;
  if (m.longBearCandle) penalty += 25;
  if (!rested && (m.threeDayChange > 8 || m.fiveDayChange > 12)) penalty += 10;

  return Math.min(penalty, 65);
}

function isRested(m) {
  const notShortSurge = m.threeDayChange < 8 && m.fiveDayChange < 12;
  const tenDayNotHot = m.tenDayChange < 18;
  const rangeSettled = m.range10 <= 18 || m.range15 <= 22;
  const notExtended = m.price <= m.ma20 * 1.08;
  return notShortSurge && tenDayNotHot && rangeSettled && notExtended;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
