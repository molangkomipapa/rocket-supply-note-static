import { makeScore } from "./common.js";

export function scoreAvoidance(m) {
  const checks = [
    {
      label: gradeLabel("20일선 이탈", maBreakPoint(m)),
      points: maBreakPoint(m)
    },
    {
      label: gradeLabel("거래량 증가 음봉", volumeBearPoint(m)),
      points: volumeBearPoint(m)
    },
    {
      label: gradeLabel("반등 실패 반복", m.recentUpperWickCount >= 3 ? 15 : 0),
      points: m.recentUpperWickCount >= 3 ? 15 : 0
    },
    {
      label: gradeLabel("고점 대비 급락", highDropPoint(m)),
      points: highDropPoint(m)
    },
    {
      label: gradeLabel("장대음봉", m.longBearCandle ? 10 : 0),
      points: m.longBearCandle ? 10 : 0
    },
    {
      label: gradeLabel("외국/기관 이탈", m.programFlow.available && m.programFlow.positiveDays === 0 && m.programFlow.totalNet < 0 ? 5 : 0),
      points: m.programFlow.available && m.programFlow.positiveDays === 0 && m.programFlow.totalNet < 0 ? 5 : 0
    },
    {
      label: gradeLabel("섹터 약화", m.price < m.ma60 || (m.ma20Slope < -0.5 && m.price < m.ma20) ? 5 : 0),
      points: m.price < m.ma60 || (m.ma20Slope < -0.5 && m.price < m.ma20) ? 5 : 0
    }
  ];

  return makeScore("회피", "avoidance", checks, [
    "회피 강력 경고",
    "분할매도 고려",
    "주의 관찰",
    "정상"
  ]);
}

function maBreakPoint(m) {
  const volumeIncreasing = m.volRelToday20 >= 1.2 || m.todayVolume > m.prevVolume;
  if (m.price < m.ma20 * 0.99 && m.prevClose < m.ma20 && volumeIncreasing) return 25;
  if (m.price < m.ma20 * 0.99) return 18;
  if (m.price < m.ma20 * 1.01) return 8;
  return 0;
}

function volumeBearPoint(m) {
  const bearish = m.price < m.open && m.changeRate < 0;
  if (bearish && m.volRelToday20 >= 2) return 25;
  if (bearish && m.volRelToday20 >= 1.5) return 18;
  if (bearish) return 8;
  return 0;
}

function highDropPoint(m) {
  if (m.pullbackFromHigh20 >= 15) return 15;
  if (m.pullbackFromHigh20 >= 10) return 10;
  if (m.pullbackFromHigh20 >= 5) return 5;
  return 0;
}

function gradeLabel(label, points) {
  if (points >= 20) return `${label} 강함`;
  if (points >= 10) return `${label} 보통`;
  if (points > 0) return `${label} 약함`;
  return `${label} 없음`;
}
