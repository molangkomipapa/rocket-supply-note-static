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

    async function getDailyChart(code) {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const endDate = `${yyyy}${mm}${dd}`;

      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        "FHKST03010100",
        {
          fid_cond_mrkt_div_code: "J",
          fid_input_iscd: code,
          fid_input_date_1: "20240101",
          fid_input_date_2: endDate,
          fid_period_div_code: "D",
          fid_org_adj_prc: "0"
        }
      );

      return data.output2 || [];
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
        { code: "204320", name: "HL만도", sector: "코스피 상위권" }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        { code: "196170", name: "알테오젠", sector: "코스닥 상위권" },
        { code: "086520", name: "에코프로", sector: "코스닥 상위권" },
        { code: "247540", name: "에코프로비엠", sector: "코스닥 상위권" },
        { code: "277810", name: "레인보우로보틱스", sector: "코스닥 상위권" }
      ];
    }

    const universe = [...kospi, ...kosdaq];

    const stocks = [];
    const sectorMap = {};

    for (const item of universe) {
      try {
        const price = await getPrice(item.code);
        if (!price) continue;

        const dailyRaw = await getDailyChart(item.code);

        const currentPrice = Number(price.stck_prpr || 0);
        const changeRate = Number(price.prdy_ctrt || 0);
        const todayVolume = Number(price.acml_vol || 0);
        const open = Number(price.stck_oprc || 0);
        const high = Number(price.stck_hgpr || 0);
        const low = Number(price.stck_lwpr || 0);

        const daily = dailyRaw
          .map((d) => ({
            close: Number(d.stck_clpr || 0),
            open: Number(d.stck_oprc || 0),
            high: Number(d.stck_hgpr || 0),
            low: Number(d.stck_lwpr || 0),
            volume: Number(d.acml_vol || 0)
          }))
          .filter((d) => d.close > 0)
          .slice(0, 30);

        if (daily.length < 20) continue;

        const recent5 = daily.slice(0, 5);
        const recent20 = daily.slice(0, 20);
        const prev15 = daily.slice(5, 20);

        const avgClose5 =
          recent5.reduce((sum, d) => sum + d.close, 0) / recent5.length;

        const avgClose20 =
          recent20.reduce((sum, d) => sum + d.close, 0) / recent20.length;

        const avgVol5 =
          recent5.reduce((sum, d) => sum + d.volume, 0) / recent5.length;

        const avgVolPrev15 =
          prev15.reduce((sum, d) => sum + d.volume, 0) / prev15.length;

        const recentLow20 = Math.min(...recent20.map((d) => d.low));
        const recentHigh20 = Math.max(...recent20.map((d) => d.high));

        const nearLow20 =
          recentLow20 > 0
            ? ((currentPrice - recentLow20) / recentLow20) * 100
            : 999;

        const belowHigh20 =
          recentHigh20 > 0
            ? ((recentHigh20 - currentPrice) / recentHigh20) * 100
            : 0;

        const intradayRebound =
          low > 0 ? ((currentPrice - low) / low) * 100 : 0;

        const highPullback =
          high > 0 ? ((high - currentPrice) / high) * 100 : 0;

        const volumeRecovery =
          avgVolPrev15 > 0 ? avgVol5 / avgVolPrev15 : 1;

        const todayVolumePower =
          avgVol5 > 0 ? todayVolume / avgVol5 : 1;

        const above5 = currentPrice >= avgClose5;
        const near20 =
          currentPrice >= avgClose20 * 0.94 &&
          currentPrice <= avgClose20 * 1.08;

        /*
          과감한 제외 조건
          - 급등주 제외
          - 장대음봉·고점 붕괴 제외
          - 20일 저점 이탈 종목 제외
          - 거래량 완전히 죽은 종목 제외
        */
        if (changeRate >= 5) continue;
        if (changeRate <= -4) continue;
        if (highPullback >= 8) continue;
        if (currentPrice < recentLow20 * 0.98) continue;
        if (todayVolume < 30000) continue;

        let score = 0;

        // 1. 바닥권 위치
        if (nearLow20 >= 2 && nearLow20 <= 15) score += 25;
        else if (nearLow20 > 15 && nearLow20 <= 25) score += 10;

        // 2. 전고점 추격 아님
        if (belowHigh20 >= 5 && belowHigh20 <= 25) score += 20;
        if (belowHigh20 < 3) score -= 15;

        // 3. 20일선 근처에서 버팀
        if (near20) score += 20;

        // 4. 5일선 회복 시도
        if (above5) score += 20;

        // 5. 최근 거래량 회복
        if (volumeRecovery >= 1.05 && volumeRecovery <= 3.5) score += 25;
        else if (volumeRecovery >= 0.9) score += 10;

        // 6. 당일 거래량도 죽지 않음
        if (todayVolumePower >= 0.8 && todayVolumePower <= 3.5) score += 15;

        // 7. 당일 저점 대비 회복
        if (intradayRebound >= 1) score += 10;
        if (intradayRebound >= 2) score += 10;

        // 8. 시가 회복
        if (currentPrice >= open) score += 15;
        else score -= 10;

        // 9. 하락폭 제한
        if (changeRate >= -2 && changeRate <= 2.5) score += 15;

        // 10. 과열 감점
        if (changeRate > 3) score -= 15;
        if (todayVolumePower > 5) score -= 10;

        score = Math.max(0, Math.min(score, 100));

        if (score < 50) continue;

        let status = "관찰 후보";
        if (score >= 85) status = "바닥권 수급 포착";
        else if (score >= 75) status = "눌림 후 회복 시도";
        else if (score >= 65) status = "저점 다지기";
        else if (score >= 50) status = "분할 관심";

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
          sectorRank: "상위30% 바닥권 수급",
          score,

          programBuy: "거래량 기반 수급 유입 감시",
          bigTrade:
            volumeRecovery >= 1.05
              ? "최근 5일 거래량 회복"
              : "거래량 관찰",
          bigTradeAmount: `5일 거래량 / 이전평균 ${volumeRecovery.toFixed(
            1
          )}배`,

          supply:
            todayVolumePower >= 1
              ? "당일 거래량도 유지"
              : "당일 거래량 확인 필요",

          volume: `오늘 ${todayVolume.toLocaleString()}주 / 5일평균 ${todayVolumePower.toFixed(
            1
          )}배`,

          chart: `20일저점 대비 +${nearLow20.toFixed(
            1
          )}%, 20일고점 대비 -${belowHigh20.toFixed(1)}%`,

          reason:
            "최근 20일 저점권에서 무너지지 않고, 5일선 회복과 거래량 회복이 함께 나타나는 분할매수 후보입니다.",

          buy: "1차 소액 / 눌림 시 2차 분할",
          stop: "20일 저점 또는 당일 저점 이탈",
          target: "전고점 회복 / +5~8%"
        });
      } catch (e) {}
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
      mode: "상위30% 바닥권 수급 스윙 스캐너",
      scanned: universe.length,
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
