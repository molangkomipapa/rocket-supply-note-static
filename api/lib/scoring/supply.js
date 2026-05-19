import { getGrade, makeScore } from "./common.js";

export function scoreSupply(m) {
  const overheated =
    m.threeDayChange >= 20 ||
    (m.volRelToday20 >= 4 && m.upperWickRatio > 0.35) ||
    m.longBearCandle;
  const checks = [
    {
      label: gradeLabel("최근 누적 순매수", buyPoint(m)),
      points: buyPoint(m)
    },
    {
      label: gradeLabel("주가 유지력", priceHoldPoint(m)),
      points: priceHoldPoint(m)
    },
    {
      label: gradeLabel("거래량 지속성", volumePoint(m)),
      points: volumePoint(m)
    },
    {
      label: gradeLabel("이평선 회복", maPoint(m)),
      points: maPoint(m)
    },
    {
      label: gradeLabel("눌림 후 회복력", reboundPoint(m)),
      points: reboundPoint(m)
    },
    {
      label: gradeLabel("섹터 흐름", m.price > m.ma60 && m.ma20Slope > -0.5 ? 5 : 0),
      points: m.price > m.ma60 && m.ma20Slope > -0.5 ? 5 : 0
    }
  ];
  const score = makeScore("외국기관수급", "supply", checks, [
    "강한 수급 관심",
    "수급 유입 진행",
    "관찰",
    "제외"
  ]);

  if (overheated) {
    score.score = Math.max(0, score.score - 20);
    score.failed.push("과열 제외 조건");
    score.checks.push({
      label: "최근 과열/윗꼬리/장대음봉",
      ok: false,
      points: -20
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
  if (m.programFlow.positiveDays30 >= 10 && m.programFlow.totalNet > 0) return 35;
  if (m.programFlow.positiveDays10 >= 5 || m.programFlow.positiveDays >= 3) return 25;
  if (m.programFlow.positiveDays3 >= 2) return 15;
  return 0;
}

function priceHoldPoint(m) {
  if (m.programFlow.positiveDays > 0 && m.price >= m.ma20) return 20;
  if (m.price >= m.ma20 * 0.98) return 14;
  if (m.recentLow10 >= m.low20 * 0.98) return 7;
  return 0;
}

function volumePoint(m) {
  if (m.volBuild3 || m.volumeRecoveryDays >= 4) return 15;
  if (m.volRel5_20 >= 1) return 10;
  if (m.todayVolume > m.prevVolume) return 5;
  return 0;
}

function maPoint(m) {
  if (m.price >= m.ma20 && m.ma20 >= m.ma60 * 0.98) return 15;
  if (m.price >= m.ma20 || (m.ma20 > m.ma60 && m.ma20Slope > -0.3)) return 10;
  if (m.price >= m.ma60) return 5;
  return 0;
}

function reboundPoint(m) {
  if (m.intradayRebound >= 2 || (m.price >= m.open && m.price >= m.prevClose)) {
    return 10;
  }
  if (m.intradayRebound >= 1 || m.price >= m.open || m.price >= m.prevClose) {
    return 6;
  }
  return 0;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
