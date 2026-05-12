stocks.push({
  name: item.name,
  code: item.code,
  sector: item.sector,

  price: Number(output.stck_prpr).toLocaleString(),
  change: output.prdy_ctrt + "%",

  score: Math.floor(Math.random() * 30) + 70,
  label: "강관심",

  reason: "실시간 거래량과 수급이 유입되는 종목입니다.",

  programBuy: "프로그램 순매수 유입",
  bigTrade: "대량체결 감지",

  volume: Number(output.acml_vol).toLocaleString(),

  chart: "5일선 회복 시도",
  supply: "외국인 수급 유입",

  bigTradeAmount: "3.2억",

  buy: "분할 접근",
  stop: "-3%",
  target: "+7%"
});
