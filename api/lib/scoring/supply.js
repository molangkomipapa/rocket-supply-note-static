import { getGrade, makeScore } from "./common.js";

export function scoreSupply(m) {
  const distributionRisk =
    (m.changeRate < -3 && m.volRelToday20 >= 2) ||
    (m.volRelToday20 >= 4 && m.upperWickRatio > 0.35) ||
    m.longBearCandle ||
    (m.programFlow.totalNet > 0 && m.changeRate <= -5);
  const checks = [
    {
      label: gradeLabel("최근 누적 순매수", buyPoint(m)),
      points: buyPoint(m)
    },
    {
      label: gradeLabel("순매수 지속성", continuityPoint(m)),
      points: continuityPoint(m)
    },
    {
      label: gradeLabel("주가 유지력", priceHoldPoint(m)),
      points: priceHoldPoint(m)
    },
    {
      label: gradeLabel("매수량 안정성", buyVolumePoint(m)),
      points: buyVolumePoint(m)
    },
    {
      label: gradeLabel("눌림 후 회복력", reboundPoint(m)),
      points: reboundPoint(m)
    }
  ];
  const score = makeScore("외국기관수급", "supply", checks, [
    "강한 수급 관심",
    "수급 유입 진행",
    "관찰",
    "제외"
  ]);

  if (distributionRisk) {
    score.score = Math.max(0, score.score - 25);
    score.failed.push("분배/이탈 의심 감점");
    score.checks.push({
      label: "거래량 증가 하락/윗꼬리/장대음봉",
      ok: false,
      points: -25
    });
    score.status = getGrade(score.score, [
      "강한 수급 관심",
      "수급 유입 진행",
      "관찰",
      "제외"
    ]);
  }

  return score;
}

function buyPoint(m) {
  if (
    m.programFlow.positiveDays30 >= 12 &&
    m.programFlow.totalNet > 0 &&
    m.programFlow.buyDominant
  ) {
    return 40;
  }
  if (m.programFlow.positiveDays10 >= 5 && m.programFlow.totalNet > 0) {
    return 30;
  }
  if (m.programFlow.positiveDays >= 3 && m.programFlow.totalNet > 0) {
    return 20;
  }
  if (m.programFlow.positiveDays3 >= 1 && m.programFlow.totalNet > 0) {
    return 10;
  }
  return 0;
}

function continuityPoint(m) {
  if (m.programFlow.positiveDays30 >= 12 || m.programFlow.positiveDays10 >= 7) {
    return 25;
  }
  if (m.programFlow.positiveDays10 >= 3 || m.programFlow.positiveDays >= 3) {
    return 15;
  }
  if (m.programFlow.positiveDays3 >= 1) return 5;
  return 0;
}

function priceHoldPoint(m) {
  const netBuying = m.programFlow.totalNet > 0;
  const lowHeld = m.recentLow10 >= m.low20 * 0.98;
  if (netBuying && m.price >= m.ma20 && m.changeRate > -3) return 20;
  if (netBuying && lowHeld && m.price >= m.ma20 * 0.97) return 15;
  if (netBuying && lowHeld && m.changeRate > -5) return 5;
  return 0;
}

function buyVolumePoint(m) {
  if (!m.programFlow.totalBuy) return 0;
  if (m.programFlow.buyMomentum >= 0.7 && m.programFlow.buyMomentum <= 1.8) {
    return 10;
  }
  if (
    (m.programFlow.buyMomentum >= 0.3 && m.programFlow.buyMomentum < 0.7) ||
    (m.programFlow.buyMomentum > 1.8 && m.programFlow.buyMomentum <= 2.5)
  ) {
    return 5;
  }
  return 0;
}

function reboundPoint(m) {
  if (
    m.programFlow.totalNet > 0 &&
    (m.intradayRebound >= 1.5 || (m.price >= m.open && m.price >= m.prevClose))
  ) {
    return 5;
  }
  return 0;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
