export default async function handler(req, res) {
  try {
    const tokenRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(500).json({
        success: false,
        message: "한국투자증권 토큰 발급 실패",
        detail: tokenData
      });
    }

    const ACCESS_TOKEN = tokenData.access_token;

    const targets = [
      { code: "204320", name: "HL만도", sector: "자동차부품", sectorRank: "자동차부품 관찰" },
      { code: "064350", name: "현대로템", sector: "방산/철도", sectorRank: "방산/철도 관찰" },
      { code: "010140", name: "삼성중공업", sector: "조선", sectorRank: "조선 관찰" }
    ];

    const stocks = [];

    for (const item of targets) {
      const priceRes = await fetch(
        `https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${item.code}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${ACCESS_TOKEN}`,
            appkey: process.env.KIS_APP_KEY,
            appsecret: process.env.KIS_APP_SECRET,
            tr_id: "FHKST01010100"
          }
        }
      );

      const priceData = await priceRes.json();

      if (!priceData.output) {
        stocks.push({
          name: item.name,
          code: item.code,
          sector: item.sector,
          price: "조회실패",
          change: "-",
          status: "데이터 확인 필요",
          sectorRank: item.sectorRank,
          programBuy: "확인 필요",
          bigTrade: "확인 필요",
          bigTradeAmount: "확인 필요",
          supply: "확인 필요",
          volume: "확인 필요",
          chart: "확인 필요",
          score: 0,
          reason: "한국투자증권 시세 응답을 확인해야 합니다.",
          buy: "판단 보류",
          stop: "판단 보류",
          target: "판단 보류"
        });
        continue;
      }

      const output = priceData.output;
      const currentPrice = Number(output.stck_prpr || 0);
      const changeRate = Number(output.prdy_ctrt || 0);
      const volume = Number(output.acml_vol || 0);

      let score = 50;
      if (changeRate > 0) score += 10;
      if (changeRate > 2) score += 10;
      if (volume > 1000000) score += 10;
      if (volume > 5000000) score += 10;
      score = Math.min(score, 100);

      let status = "관찰";
      if (score >= 85) status = "당일 주도주 후보";
      else if (score >= 75) status = "수급 유입 확인";
      else if (score >= 60) status = "눌림반등 관찰";

      stocks.push({
        name: item.name,
        code: item.code,
        sector: item.sector,
        price: currentPrice.toLocaleString(),
        change: `${output.prdy_ctrt || "0"}%`,
        status,
        sectorRank: item.sectorRank,
        programBuy: "프로그램 수급 확인 필요",
        bigTrade: volume > 1000000 ? "거래량 증가 포착" : "대량체결 확인 필요",
        bigTradeAmount: "API 추가 연결 필요",
        supply: "외국인/기관 수급 API 추가 연결 필요",
        volume: `누적거래량 ${volume.toLocaleString()}주`,
        chart: changeRate > 0 ? "양봉 반등 확인 필요" : "눌림 구간 관찰",
        score,
        reason: "현재가는 한국투자증권 실시간 시세로 반영됐고, 수급·대량체결은 추가 API 연결 후 정밀 계산 예정입니다.",
        buy: "분할 접근",
        stop: "-3% 또는 직전 저점 이탈",
        target: "+5~7% / 전고점"
      });
    }

    const sectors = [
      { name: "조선", change: "실시간 확인", strength: 80, leaders: "삼성중공업" },
      { name: "방산/철도", change: "실시간 확인", strength: 80, leaders: "현대로템" },
      { name: "자동차부품", change: "실시간 확인", strength: 75, leaders: "HL만도" }
    ];

    res.status(200).json({
      success: true,
      updatedAt: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
      stocks,
      sectors
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
