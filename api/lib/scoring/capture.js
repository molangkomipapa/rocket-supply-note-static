import { makeScore } from "./common.js";

const CAPTURE_LABELS = [
  "최우선 포착",
  "매수후보",
  "분할관심",
  "관찰후보",
  "제외"
];

export function scoreCapture(m) {
  const lowMaintained = m.price >= m.recentLow10 * 0.995;
  const ma20Support = m.price >= m.ma20 * 0.98;
  const volatile =
    m.avgRange3 > m.avgRange5 * 1.15 || m.range5 > m.range10 * 1.05;
  const hardChaseRisk =
    m.changeRate >= 6 ||
    m.threeDayChange >= 15 ||
    m.volRelToday20 >= 3 ||
    m.longBearCandle;

  const lowScore = lowPoint(lowMaintained, ma20Support, volatile);
  const compressionScore = compressionPoint(m);
  const pullbackScore = pullbackPoint(m);
  const volumeScore = volumeStabilityPoint(m);
  const trendScore = trendPoint(m);
  const restartScore = earlyRestartPoint(m);

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
      label: gradeLabel("추세 유지", trendScore),
      points: trendScore
    },
    {
      label: gradeLabel("초기 재출발 신호", restartScore),
      points: restartScore
    }
  ];

  const score = makeScore("포착", "capture", checks, CAPTURE_LABELS);
  score.status = getCaptureGrade(score.score);

  const heatPenalty = heatRiskPenalty(m);
  if (heatPenalty > 0) {
    score.score = Math.max(0, score.score - heatPenalty);
    score.failed.push("포착 과열 감점");
    score.checks.push({
      label: `포착 과열 감점 -${heatPenalty}`,
      ok: false,
      points: -heatPenalty
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

function lowPoint(lowMaintained, ma20Support, volatile) {
  if (lowMaintained && ma20Support) return 35;
  if (lowMaintained && !ma20Support && !volatile) return 25;
  if (lowMaintained) return 15;
  return 0;
}

function compressionPoint(m) {
  const candleCompressed = m.avgRange3 <= m.avgRange5 * 0.9;
  const rangeCompressed = m.range5 <= m.range10 * 0.85;
  const sideways = m.range5 <= m.range10 && m.avgRange3 <= m.avgRange5 * 1.05;

  if (candleCompressed && rangeCompressed) return 25;
  if (rangeCompressed) return 18;
  if (sideways) return 10;
  return 0;
}

function pullbackPoint(m) {
  if (m.pullbackFromHigh20 >= 5 && m.pullbackFromHigh20 <= 15) return 20;
  if (
    (m.pullbackFromHigh20 >= 3 && m.pullbackFromHigh20 < 5) ||
    (m.pullbackFromHigh20 > 15 && m.pullbackFromHigh20 <= 20)
  ) {
    return 14;
  }
  if (m.pullbackFromHigh20 < 3) return 7;
  return 0;
}

function volumeStabilityPoint(m) {
  if (m.volRelToday20 >= 0.6 && m.volRelToday20 <= 1.5) return 10;
  if (
    (m.volRelToday20 >= 0.4 && m.volRelToday20 < 0.6) ||
    (m.volRelToday20 > 1.5 && m.volRelToday20 <= 2.2)
  ) {
    return 7;
  }
  if (m.volRelToday20 < 0.4) return 3;
  return 0;
}

function trendPoint(m) {
  if (m.ma20 > m.ma60 || m.price > m.ma60) return 5;
  if (m.price >= m.ma60 * 0.98) return 3;
  return 0;
}

function earlyRestartPoint(m) {
  if (m.price >= m.open || m.price >= m.ma5 || m.intradayRebound >= 1) return 5;
  if (m.intradayRebound >= 0.5 || m.price >= m.prevClose * 0.995) return 3;
  return 0;
}

function heatRiskPenalty(m) {
  let penalty = 0;
  if (m.changeRate >= 6) penalty += 25;
  else if (m.changeRate >= 4) penalty += 15;
  else if (m.changeRate > 2.5) penalty += 7;

  if (m.volRelToday20 >= 3) penalty += 20;
  else if (m.volRelToday20 > 2.2) penalty += 10;

  if (m.threeDayChange >= 15) penalty += 15;
  if (m.longBearCandle) penalty += 20;

  return Math.min(penalty, 45);
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
