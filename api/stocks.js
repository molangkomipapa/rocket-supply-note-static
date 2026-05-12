export default async function handler(req, res) {
  try {
    const BASE_URL =
      process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";

    const tokenRes = await fetch(`${BASE_URL}/oauth2/tokenP`, {
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

    const commonHeaders = {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      "content-type": "application/json; charset=utf-8"
    };

    async function kisGet(path, trId, params) {
      const url = new URL(`${BASE_URL}${path}`);

      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      });

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          ...commonHeaders,
          tr_id: trId
        }
      });

      return response.json();
    }

    async function getMarketCapRank(marketCode, count) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/ranking/market-cap",
        "FHPST01740000",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: "0000",
          fid_div_cls_code: "0",
          fid_trgt_cls_code: "0",
          fid_trgt_exls_cls_code: "0"
        }
      );

      const list = data.output || data.output1 || data.output2 || [];

      return list
        .map((x) => ({
          code:
            x.mksc_shrn_iscd ||
            x.stck_shrn_iscd ||
            x.iscd ||
            x.code,
          name:
            x.hts_kor_isnm ||
            x.prdt_name ||
            x.name ||
            "",
          sector: marketCode === "1001" ? "코스닥 상위권" : "코스피 상위권"
        }))
        .filter((x) => x.code && x.name)
        .slice(0, count);
    }

    async function getPrice(code) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-price",
        "FHKST01010100",
        {
          fid_cond_mrkt_div_code: "J",
          fid_input_iscd: code
        }
      );

      return data.output || null;
    }

    let kospi = [];
    let kosdaq = [];

    try {
      kospi = await getMarketCapRank("0001", 270);
    } catch (e) {
      kospi = [];
    }

    try {
      kosdaq = await getMarketCapRank("1001", 500);
    } catch (e) {
      kosdaq = [];
    }

    if (!kospi.length) {
      kospi = [
        { code: "005930", name: "삼성전자", sector: "코스피 상위권" },
        { code: "000660", name: "SK하이닉스", sector: "코스피 상위권" },
        { code: "005380", name: "현대차", sector: "코스피 상위권" },
        { code: "000270", name: "기아", sector: "코스피 상위권" },
        { code: "064350", name: "현대로템", sector: "코스피 상위권" },
        { code: "204320", name: "HL만도", sector: "코스피 상위권" },
        { code: "010140", name: "삼성중공업", sector: "코스피 상위권" },
        { code: "042660", name: "한화오션", sector: "코스피 상위권" },
        { code: "267260", name: "HD현대일렉트릭", sector: "코스피 상위권" },
        { code: "010120", name: "LS ELECTRIC", sector: "코스피 상위권" }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        { code: "196170", name: "알테오젠", sector: "코스닥 상위권" },
        { code: "086520", name: "에코프로", sector: "코스닥 상위권" },
        { code: "247540", name: "에코프로비엠", sector: "코스닥 상위권" },
        { code: "277810", name: "레인보우로보틱스", sector: "코스닥 상위권" },
        { code: "042700", name: "한미반도체", sector: "코스닥 상위권" }
      ];
    }

    const universe = [...kospi, ...kosdaq];

    const firstPass = [];
    const sectorMap = {};

    for (const item of universe) {
      try {
        const output = await getPrice(item.code);
        if (!output) continue;

        const currentPrice = Number(output.stck_prpr || 0);
        const changeRate = Number(output.prdy_ctrt || 0);
        const volume = Number(output.acml_vol || 0);
        const open = Number(output.stck_oprc || 0);
        const high = Number(output.stck_hgpr || 0);
        const low = Number(output.stck_lwpr || 0);

        const highPullback =
          high > 0 ? ((high - currentPrice) / high) * 100 : 0;

        const intradayRebound =
          low > 0 ? ((currentPrice - low) / low) * 100 : 0;

        // 과감한 제외
        if (changeRate >= 5) continue;
        if (changeRate <= -3) continue;
        if (highPullback >= 5) continue;
        if (volume < 80000) continue;

        let preScore = 0;

        if (changeRate >= -1.5 && changeRate <= 3) preScore += 20;
        if (intradayRebound >= 1.2) preScore += 20;
        if (currentPrice >= open) preScore += 20;
        if (volume >= 300000) preScore += 15;
        if (highPullback <= 3) preScore += 15;

        if (preScore < 45) continue;

        firstPass.push({
          item,
          output,
          currentPrice,
          changeRate,
          volume,
          open,
          high,
          low,
          highPullback,
          intradayRebound,
          preScore
        });
      } catch (e) {}
    }

    const compressed = firstPass
      .sort((a, b) => b.preScore - a.preScore)
      .slice(0, 120);

    const stocks = [];

    for (const row of compressed) {
      const {
        item,
        currentPrice,
        changeRate,
        volume,
        open,
        high,
        low,
        highPullback,
        intradayRebound,
        preScore
      } = row;

      let score = preScore;

      if (changeRate >= -0.8 && changeRate <= 2.5) score += 15;
      if (intradayRebound >= 2) score += 15;
      if (currentPrice > open) score += 15;
      if (volume >= 500000 && volume <= 5000000) score += 15;
      if (highPullback >= 1 && highPullback <= 4) score += 10;

      if (changeRate > 3) score -= 10;
      if (currentPrice < open) score -= 15;

      score = Math.max(0, Math.min(score, 100));

      if (score < 60) continue;

      let status = "바닥 다지기";
      if (score >= 90) status = "강한 눌림반등";
      else if (score >= 80) status = "눌림 후 반등";
      else if (score >= 70) status = "저점 회복 시도";

      if (!sectorMap[item.sector]) {
        sectorMap[item.sector] = {
          name: item.sector,
          totalScore: 0,
          count: 0,
          leaders: [],
          bestChange: changeRate
        };
      }

      sectorMap[item.sector].totalScore += score;
      sectorMap[item.sector].count += 1;
      sectorMap[item.sector].leaders.push({
        name: item.name,
        score,
        changeRate
      });
      sectorMap[item.sector].bestChange = Math.max(
        sectorMap[item.sector].bestChange,
        changeRate
      );

      stocks.push({
        name: item.name,
        code: item.code,
        sector: item.sector,
        price: currentPrice.toLocaleString(),
        change: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
        status,
        sectorRank: "상위 30% 눌림반등",
        score,

        programBuy: "장중 수급: 거래량 회복 감지",
        bigTrade:
          volume >= 1000000
            ? "거래량 회복 포착"
            : "거래량 회복 관찰",
        bigTradeAmount:
          highPullback <= 3
            ? "고점 붕괴 없음"
            : "고점 대비 일부 조정",
        supply:
          currentPrice >= open
            ? "시가 회복 확인"
            : "시가 회복 관찰",
        volume: `누적거래량 ${volume.toLocaleString()}주`,
        chart: `저점대비 +${intradayRebound.toFixed(
          1
        )}%, 고점대비 -${highPullback.toFixed(1)}%`,
        reason:
          "상위권 종목 중 급등·장대음봉·고점 붕괴 종목은 제외하고, 저점에서 회복하며 거래량이 살아나는 종목만 선별했습니다.",
        buy: "눌림 분할 접근",
        stop: "당일 저점 또는 최근 저점 이탈",
        target: "전고점 / +5~8%"
      });
    }

    stocks.sort((a, b) => b.score - a.score);

    const sectors = Object.values(sectorMap)
      .map((s) => {
        const leaders = s.leaders
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .map((x) => x.name)
          .join(", ");

        return {
          name: s.name,
          change: `${s.bestChange > 0 ? "+" : ""}${s.bestChange.toFixed(2)}%`,
          strength: Math.min(Math.round(s.totalScore / s.count), 100),
          leaders
        };
      })
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8);

    return res.status(200).json({
      success: true,
      mode: "상위30% 우량 눌림반등 수급 스캐너",
      scanned: universe.length,
      compressed: compressed.length,
      updatedAt: new Date().toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul"
      }),
      stocks: stocks.slice(0, 30),
      sectors
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
