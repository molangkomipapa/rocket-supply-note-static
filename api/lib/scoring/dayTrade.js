import { getGrade, makeScore } from "./common.js";

export function scoreDayTrade(m) {
  const risk =
    m.upperWickRatio > 0.45 ||
    (m.volRelToday20 >= 5 && m.price < m.open) ||
    m.longBearCandle ||
    m.price < m.open * 0.995;
  const checks = [
    {
      label: gradeLabel("거래량 폭증", volumePoint(m)),
      points: volumePoint(m)
    },
    {
      label: gradeLabel("시가 유지/회복", openPoint(m)),
      points: openPoint(m)
    },
    {
      label: gradeLabel("장중 회복력", reboundPoint(m)),
      points: reboundPoint(m)
    },
    {
      label: gradeLabel("체결강도/수급", strengthPoint(m)),
      points: strengthPoint(m)
    },
    {
      label: gradeLabel("고점 대비 밀림 작음", m.pullbackFromTodayHigh <= 3 ? 10 : 0),
      points: m.pullbackFromTodayHigh <= 3 ? 10 : 0
    },
    {
      label: gradeLabel("섹터 동반 상승", m.price > m.ma20 && m.ma20 >= m.ma60 * 0.98 ? 5 : 0),
      points: m.price > m.ma20 && m.ma20 >= m.ma60 * 0.98 ? 5 : 0
    }
  ];
  const score = makeScore("당일급등", "dayTrade", checks, [
    "당일 단타 핵심",
    "단타 관심",
    "관찰",
    "제외"
  ]);

  if (risk) {
    score.score = Math.max(0, score.score - 25);
    score.failed.push("위험 제외 조건");
    score.checks.push({
      label: "윗꼬리/시가 이탈/장대음봉 위험",
      ok: false,
      points: -25
    });
    score.status = getGrade(score.score, [
      "당일 단타 핵심",
      "단타 관심",
      "관찰",
      "제외"
    ]);
  }

  return score;
}

function volumePoint(m) {
  if (m.volRelToday20 >= 3 && m.volRelToday20 <= 5) return 30;
  if (m.volRelToday20 >= 2 && m.volRelToday20 < 3) return 22;
  if (m.volRelToday20 >= 1.5 && m.volRelToday20 < 2) return 12;
  return 0;
}

function openPoint(m) {
  if (m.price >= m.open * 1.005) return 20;
  if (m.low < m.open && m.price >= m.open) return 12;
  if (m.price >= m.open * 0.995) return 5;
  return 0;
}

function reboundPoint(m) {
  if (m.intradayRebound >= 3) return 20;
  if (m.intradayRebound >= 1.5) return 14;
  if (m.intradayRebound >= 0.5) return 7;
  return 0;
}

function strengthPoint(m) {
  if (m.price >= m.open && m.todayVolume > m.prevVolume) return 15;
  if (m.price >= m.prevClose && m.volRelToday20 >= 1.5) return 9;
  if (m.price >= m.prevClose) return 5;
  return 0;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
