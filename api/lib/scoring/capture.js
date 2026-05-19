import { getGrade, makeScore } from "./common.js";

export function scoreCapture(m) {
  const trendOk = m.ma20 > m.ma60 || m.price > m.ma60;
  const pullbackOk = m.pullbackFromHigh20 >= 3 && m.pullbackFromHigh20 <= 15;
  const lowMaintained = m.price >= m.recentLow10 * 0.995;
  const ma20Support = m.price >= m.ma20 * 0.98;
  const volatile =
    m.avgRange3 > m.avgRange5 * 1.15 || m.range5 > m.range10 * 1.05;
  const bullish = m.price > m.open;
  const openRecovered = m.price >= m.open;
  const ma5Recovered = m.price >= m.ma5;
  const restartCount = [bullish, openRecovered, ma5Recovered].filter(Boolean)
    .length;
  const chaseRisk =
    m.changeRate >= 8 ||
    m.threeDayChange >= 15 ||
    m.volRelToday20 >= 4 ||
    m.longBearCandle;

  const checks = [
    {
      label: gradeLabel("저점 유지", lowPoint(lowMaintained, ma20Support, volatile)),
      points: lowPoint(lowMaintained, ma20Support, volatile)
    },
    {
      label: gradeLabel("거래량 재증가", volumePoint(m)),
      points: volumePoint(m)
    },
    {
      label: gradeLabel("재출발 신호", restartPoint(restartCount, m)),
      points: restartPoint(restartCount, m)
    },
    {
      label: gradeLabel("압축 구조", compressionPoint(m)),
      points: compressionPoint(m)
    },
    {
      label: gradeLabel("눌림 위치", pullbackOk ? 10 : 0),
      points: pullbackOk ? 10 : 0
    },
    {
      label: gradeLabel("추세 유지", trendOk ? 10 : 0),
      points: trendOk ? 10 : 0
    }
  ];

  const score = makeScore("포착", "capture", checks, [
    "매수후보",
    "분할관심",
    "관찰후보",
    "제외"
  ]);

  if (chaseRisk) {
    score.score = Math.max(0, score.score - 35);
    score.failed.push("추격 제외 조건");
    score.checks.push({
      label: "추격 위험 감점",
      ok: false,
      points: -35
    });
    score.status = getGrade(score.score, [
      "매수후보",
      "분할관심",
      "관찰후보",
      "제외"
    ]);
  }

  return score;
}

function lowPoint(lowMaintained, ma20Support, volatile) {
  if (lowMaintained && ma20Support) return 25;
  if (lowMaintained && !ma20Support && !volatile) return 15;
  if (lowMaintained) return 7;
  return 0;
}

function volumePoint(m) {
  if (m.todayVolume > m.prevVolume && m.volRelToday20 >= 0.8 && m.volRelToday20 <= 2.5) {
    return 20;
  }
  if (m.todayVolume > m.prevVolume) return 12;
  if (m.volRel5_20 >= 0.9) return 6;
  return 0;
}

function restartPoint(count, m) {
  if (count === 3) return 20;
  if (count >= 2) return 14;
  if (m.intradayRebound >= 1) return 7;
  return 0;
}

function compressionPoint(m) {
  const rangeCompressed =
    m.avgRange3 <= m.avgRange5 * 0.9 || m.range5 <= m.range10 * 0.85;
  const volumeCompressed = m.volRel5_20 >= 0.5 && m.volRel5_20 <= 1.2;
  if (rangeCompressed && volumeCompressed) return 15;
  if (rangeCompressed || volumeCompressed) return 8;
  return 0;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 12) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
