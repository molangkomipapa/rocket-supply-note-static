export default async function handler(req, res) {
  try {

    // 1. 한국투자증권 토큰 발급
    const tokenRes = await fetch("https://openapi.koreainvestment.com:9443/oauth2/tokenP", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });

    const tokenData = await tokenRes.json();
    const ACCESS_TOKEN = tokenData.access_token;

    // 2. 테스트용 종목 조회
    const targets = [
      { code: "204320", name: "HL만도", sector: "자동차부품" },
      { code: "064350", name: "현대로템", sector: "방산/철도" },
      { code: "010140", name: "삼성중공업", sector: "조선" }
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

      const output = priceData.output;

      stocks.push({
        name: item.name,
        code: item.code,
        sector: item.sector,
        price: output.stck_prpr,
        change: output.prdy_ctrt + "%",
        high: output.stck_hgpr,
        low: output.stck_lwpr,
        volume: output.acml_vol
      });
    }

    res.status(200).json({
      success: true,
      updated: new Date(),
      stocks
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      message: error.message
    });

  }
}
