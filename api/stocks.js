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

    async function getMarketCapRank(marketCode) {
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
          sector: marketCode === "1001" ? "코스닥 우량주" : "코스피 우량주"
        }))
        .filter((x) => x.code && x.name)
        .slice(0, 100);
    }

    let kospi = [];
    let kosdaq = [];

    try {
      kospi = await getMarketCapRank("0001");
    } catch (e) {
      kospi = [];
    }

    try {
      kosdaq = await getMarketCapRank("1001");
    } catch (e) {
      kosdaq = [];
    }

    if (!kospi.length) {
      kospi = [
        { code: "005930", name: "삼성전자", sector: "코스피 우량주" },
        { code: "000660", name: "SK하이닉스", sector: "코스피 우량주" },
        { code: "005380", name: "현대차", sector: "코스피 우량주" },
        { code: "000270", name: "기아", sector: "코스피 우량주" },
        { code: "064350", name: "현대로템", sector: "코스피 우량주" },
        { code: "204320", name: "HL만도", sector: "코스피 우량주" },
        { code: "010140", name: "삼성중공업", sector: "코스피 우량주" },
        { code: "042660", name: "한화오션", sector: "코스피 우량주" },
        { code: "267260", name: "HD현대일렉트릭", sector: "코스피 우량주" },
        { code: "010120", name: "LS ELECTRIC", sector: "코스피 우량주" }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        { code: "196170", name: "알테오젠", sector: "코스닥 우량주" },
        { code: "086520", name: "에코프로", sector: "코스닥 우량주" },
        { code: "247540", name: "에코프로비엠", sector: "코스닥 우량주" },
        { code: "277810", name: "레인보우로보틱스", sector: "코스닥 우량주" },
        { code: "042700", name: "한미반도체", sector: "코스닥 우량주" }
      ];
    }

    const universe = [...kospi, ...kosdaq].slice(0, 200);

    const stocks = [];
    const sectorMap = {};

    for (const item of universe) {
      try {
        const output = await getPrice(item.code);
        if (!output) continue;

        const daily = await getDailyChart(item.code);

        const currentPrice = Number(output.stck_prpr || 0);
        const changeRate = Number(output.prdy_ctrt || 0);
        const volume = Number(output.acml_vol || 0);
        const open = Number(output.stck_oprc || 0);
        const high = Number(output.stck_hgpr || 0);
        const low = Number(output.stck_lwpr || 0);

        const recent = daily
          .slice(0, 20)
          .map((d) => ({
            close: Number(d.stck_clpr || 0),
            high: Number(d.stck_hgpr || 0),
            low: Number(d.stck_lwpr || 0),
            volume: Number(d.acml_vol || 0)
          }))
          .filter((d) => d.close > 0);

        const recent5 = recent.slice(0, 5);
        const recent20 = recent.slice(0, 20);

        const avgVol5 =
          recent5.length > 0
            ? recent5.reduce((sum, d) => sum + d.volume, 0) / recent5.length
            : 0;

        const avgClose20 =
          recent20.length > 0
            ? recent20.reduce((sum, d) => sum + d.close, 0) / recent20.length
            : currentPrice;

        const recentLow20 =
          recent20.length > 0
            ? Math.min(...recent20.map((d) => d.low).filter((x) => x > 0))
            : low;

        const recentHigh20 =
          recent20.length > 0
            ? Math.max(...recent20.map((d) => d.high))
            : high;

        const highPullback =
          high > 0 ? ((high - currentPrice) / high) * 100 : 0;

        const intradayRebound =
          low > 0 ? ((currentPrice - low) / low) * 100 : 0;

        const nearRecentLow =
          recentLow20 > 0
            ? ((currentPrice - recentLow20) / recentLow20) * 100
            : 999;

        const fromRecentHigh =
          recentHigh20 > 0
            ? ((recentHigh20 - currentPrice) / recentHigh20) * 100
            : 0;

        const volumePower =
          avgVol5 > 0 ? volume / avgVol5 : 1;

        const isBelow20Avg = currentPrice <= avgClose20 * 1.06;
        const isHolding20Avg = currentPrice >= avgClose20 * 0.94;

        /*
          과감한 제외 조건
          - 고점에서 크게 밀린 종목
          - 급등 후 꺾인 종목
          - 장대음봉 성격
          - 시가 회복 실패
          - 거래량 죽은 종목
        */
        if (changeRate >= 5) continue;
        if (changeRate <= -3) continue;
        if (highPullback >= 3) continue;
        if (currentPrice < open) continue;
        if (volume < 150000) continue;

        /*
          우리가 원하는 종목
          - 최근 저점 부근에서 버팀
          - 당일 저점 대비 회복
          - 하락폭 제한
          - 거래량 회복
          - 시가 회복
          - 아직 고점 추격 아님
        */
        let score = 0;

        if (changeRate >= -1 && changeRate <= 3) score += 20;
        if (nearRecentLow >= 1 && nearRecentLow <= 12) score += 20;
        if (intradayRebound >= 1.2) score += 15;
        if (intradayRebound >= 2.5) score += 10;
        if (currentPrice > open) score += 15;
        if (volumePower >= 1.1 && volumePower <= 3.5) score += 20;
        if (isBelow20Avg && isHolding20Avg) score += 15;
        if (fromRecentHigh >= 4 && fromRecentHigh <= 18) score += 10;

        if (changeRate > 3) score -= 10;
        if (volumePower > 5) score -= 10;

        score = Math.max(0, Math.min(score, 100));

        if (score < 65) continue;

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
          sectorRank: "우량주 눌림반등",
          score,

          programBuy: "장중 수급: 거래량 회복 감지",
          bigTrade:
            volumePower >= 1.5
              ? "평균 대비 거래량 증가"
              : "거래량 회복 관찰",
          bigTradeAmount:
            volumePower >= 2
              ? `5일 평균 대비 ${volumePower.toFixed(1)}배`
              : "완만한 거래량 회복",
          supply:
            "기관·외국인 세부 수급은 추가 API 연결 예정",
          volume:
            `누적거래량 ${volume.toLocaleString()}주 / 5일평균 ${volumePower.toFixed(1)}배`,
          chart:
            `저점대비 +${intradayRebound.toFixed(1)}%, 20일 평균선 부근 유지`,
          reason:
            "급등·고점 붕괴 종목은 제외하고, 최근 저점 부근에서 버티며 거래량이 다시 살아나는 우량주만 선별했습니다.",
          buy:
            "눌림 분할 접근",
          stop:
            "당일 저점 또는 최근 저점 이탈",
          target:
            "전고점 / +5~8%"
        });
      } catch (e) {
        console.log(`${item.name} 오류`, e.message);
      }
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
      mode: "우량주 눌림반등 수급 스캐너",
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
