import { getGrade, makeScore } from "./common.js";

export function scoreDayTrade(m) {
  const distributionRisk =
    m.price < m.open ||
    m.pullbackFromTodayHigh >= 6 ||
    m.upperWickRatio > 0.45 ||
    m.longBearCandle ||
    (m.volRelToday20 >= 4 && m.changeRate < 1);
  const checks = [
    {
      label: gradeLabel("거래대금 집중도", tradeValuePoint(m)),
      points: tradeValuePoint(m)
    },
    {
      label: gradeLabel("대량 매수체결 우위", buyPressurePoint(m)),
      points: buyPressurePoint(m)
    },
    {
      label: gradeLabel("거래대금 방향성", moneyDirectionPoint(m)),
      points: moneyDirectionPoint(m)
    },
    {
      label: gradeLabel("시가 유지력", openPoint(m)),
      points: openPoint(m)
    },
    {
      label: gradeLabel("장중 회복력", reboundPoint(m)),
      points: reboundPoint(m)
    },
    {
      label: gradeLabel("섹터 쏠림", sectorPoint(m)),
      points: sectorPoint(m)
    }
  ];
  const score = makeScore("당일급등", "dayTrade", checks, [
    "당일 단타 핵심",
    "단타 관심",
    "관찰",
    "제외"
  ]);

  const penalty = riskPenalty(m, distributionRisk);
  if (penalty > 0) {
    score.score = Math.max(0, score.score - penalty);
    score.failed.push("매도 우위/분배 위험 감점");
    score.checks.push({
      label: `고점 밀림/윗꼬리/시가 이탈 -${penalty}`,
      ok: false,
      points: -penalty
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

function tradeValuePoint(m) {
  const eok = m.tradeValue / 100000000;
  if (eok >= 1000) return 30;
  if (eok >= 500) return 24;
  if (eok >= 200) return 16;
  if (eok >= 100) return 8;
  return 0;
}

function buyPressurePoint(m) {
  const programBuy = m.programFlow.totalNet > 0;
  const strongBody = m.price > m.open && m.price > m.prevClose;
  const highHold = m.pullbackFromTodayHigh <= 3;
  const notTooExtended = m.changeRate > 0 && m.changeRate <= 12;

  if (programBuy && strongBody && highHold && notTooExtended) return 25;
  if ((programBuy && highHold) || (strongBody && highHold && m.volRelToday20 >= 1.5)) {
    return 17;
  }
  if (m.price >= m.prevClose && m.pullbackFromTodayHigh <= 5) return 8;
  return 0;
}

function moneyDirectionPoint(m) {
  const eok = m.tradeValue / 100000000;
  if (eok >= 300 && m.changeRate > 0 && m.price >= m.open && m.pullbackFromTodayHigh <= 3) {
    return 20;
  }
  if (eok >= 100 && m.changeRate > 0 && m.pullbackFromTodayHigh <= 5) return 14;
  if (eok >= 50 && m.changeRate >= 0) return 6;
  return 0;
}

function openPoint(m) {
  if (m.price >= m.open * 1.005) return 10;
  if (m.low < m.open && m.price >= m.open) return 7;
  if (m.price >= m.open * 0.995) return 3;
  return 0;
}

function reboundPoint(m) {
  if (m.intradayRebound >= 3 && m.pullbackFromTodayHigh <= 3) return 10;
  if (m.intradayRebound >= 1.5) return 7;
  if (m.intradayRebound >= 0.5) return 3;
  return 0;
}

function sectorPoint(m) {
  if (m.price > m.ma20 && m.ma20 >= m.ma60 * 0.98 && m.changeRate > 0) return 5;
  if (m.price > m.ma20 && m.changeRate > 0) return 3;
  return 0;
}

function riskPenalty(m, distributionRisk) {
  let penalty = 0;
  if (distributionRisk) penalty += 20;
  if (m.marketCap > 0 && m.marketCap < 300000000000) penalty += 8;
  if (m.pullbackFromTodayHigh >= 10) penalty += 15;
  else if (m.pullbackFromTodayHigh >= 6) penalty += 8;
  if (m.changeRate < 0 && m.volRelToday20 >= 2) penalty += 15;
  if (m.programFlow.totalNet < 0) penalty += 10;
  return Math.min(penalty, 45);
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
