export default async function handler(req, res) {
  try {
    const BASE_URL =
      process.env.KIS_BASE_URL ||
      "https://openapi.koreainvestment.com:9443";

    // =========================
    // 토큰 발급
    // =========================
    const tokenRes = await fetch(`${BASE_URL}/oauth2/tokenP`, {
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

    if (!tokenData.access_token) {
      return res.status(500).json({
        success: false,
        message: "한국투자증권 토큰 발급 실패"
      });
    }

    const ACCESS_TOKEN = tokenData.access_token;

    const commonHeaders = {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      "content-type": "application/json"
    };

    // =========================
    // 공통 GET
    // =========================
    async function kisGet(path, trId, params) {
      const url = new URL(`${BASE_URL}${path}`);

      Object.entries(params || {}).forEach(([k, v]) => {
        url.searchParams.set(k, v);
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

    // =========================
    // 현재가 조회
    // =========================
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

    // =========================
    // 시총 상위 조회
    // =========================
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

      const list =
        data.output ||
        data.output1 ||
        data.output2 ||
        [];

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

          sector:
            marketCode === "1001"
              ? "코스닥 우량주"
              : "코스피 우량주"
        }))
        .filter((x) => x.code && x.name)
        .slice(0, 100);
    }

    // =========================
    // 코스피100 + 코스닥100
    // =========================
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

    // fallback
    if (!kospi.length) {
      kospi = [
        {
          code: "005930",
          name: "삼성전자",
          sector: "코스피 우량주"
        }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        {
          code: "196170",
          name: "알테오젠",
          sector: "코스닥 우량주"
        }
      ];
    }

    const universe = [
      ...kospi,
      ...kosdaq
    ];

    const scanList =
      universe.slice(0, 200);

    const stocks = [];
    const sectorMap = {};

    // =========================
    // 스캔 시작
    // =========================
    for (const item of scanList) {
      try {

        const output =
          await getPrice(item.code);

        if (!output) continue;

        const currentPrice =
          Number(output.stck_prpr || 0);

        const changeRate =
          Number(output.prdy_ctrt || 0);

        const volume =
          Number(output.acml_vol || 0);

        const open =
          Number(output.stck_oprc || 0);

        const high =
          Number(output.stck_hgpr || 0);

        const low =
          Number(output.stck_lwpr || 0);

        // =========================
        // 위험 종목 제거
        // =========================

        // 급등 후 꺾임 제거
        if (changeRate >= 5) continue;

        // 장대음봉 제거
        if (changeRate <= -3) continue;

        // 고점 대비 너무 밀림 제거
        const highPullback =
          high > 0
            ? ((high - currentPrice) / high) * 100
            : 0;

        if (highPullback >= 3) continue;

        // 시가 회복 실패 제거
        if (currentPrice < open) continue;

        // 거래량 너무 적은 종목 제거
        if (volume < 150000) continue;

        // =========================
        // 점수 계산
        // =========================
        let score = 50;

        // 안정적인 눌림 구간
        if (
          changeRate >= -1 &&
          changeRate <= 3
        ) {
          score += 20;
        }

        // 장중 저점 회복
        const rebound =
          low > 0
            ? ((currentPrice - low) / low) * 100
            : 0;

        if (rebound >= 1.5) score += 10;
        if (rebound >= 3) score += 10;

        // 시가 회복
        if (currentPrice > open) {
          score += 15;
        }

        // 거래량 살아나는 느낌
        if (
          volume >= 300000 &&
          volume <= 3000000
        ) {
          score += 15;
        }

        // 고점 추격 아님
        const nearHigh =
          high > 0
            ? (currentPrice / high) * 100
            : 0;

        if (
          nearHigh >= 94 &&
          nearHigh <= 98
        ) {
          score += 10;
        }

        // 저점 유지
        const keepLow =
          low > 0
            ? (currentPrice / low) * 100
            : 0;

        if (keepLow >= 102) {
          score += 10;
        }

        score = Math.min(score, 100);

        // =========================
        // 상태
        // =========================
        let status = "관심";

        if (score >= 90) {
          status = "강한 눌림반등";
        } else if (score >= 80) {
          status = "눌림 후 반등";
        } else if (score >= 70) {
          status = "바닥 다지기";
        }

        // =========================
        // 섹터 집계
        // =========================
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

        sectorMap[item.sector].bestChange =
          Math.max(
            sectorMap[item.sector].bestChange,
            changeRate
          );

        // =========================
        // 최종 저장
        // =========================
        stocks.push({
          name: item.name,
          code: item.code,
          sector: item.sector,

          price:
            currentPrice.toLocaleString(),

          change:
            `${changeRate > 0 ? "+" : ""}` +
            `${changeRate.toFixed(2)}%`,

          status,

          sectorRank:
            "우량주 눌림반등",

          score,

          programBuy:
            "수급 유입 감시",

          bigTrade:
            volume >= 1000000
              ? "거래량 회복 포착"
              : "거래량 증가 관찰",

          bigTradeAmount:
            "체결 분석 예정",

          supply:
            "기관·외국인 수급 예정",

          volume:
            `누적거래량 ${volume.toLocaleString()}주`,

          chart:
            "저점 다지며 회복 시도",

          reason:
            "고점 추격 종목이 아닌, 저점 부근에서 거래량이 살아나며 반등을 시도하는 우량주입니다.",

          buy:
            "눌림 분할 접근",

          stop:
            "당일 저점 이탈",

          target:
            "전고점 / +5~8%"
        });

      } catch (e) {
        console.log(
          `${item.name} 오류`,
          e.message
        );
      }
    }

    // =========================
    // 정렬
    // =========================
    stocks.sort(
      (a, b) => b.score - a.score
    );

    // =========================
    // 섹터 정리
    // =========================
    const sectors =
      Object.values(sectorMap)
        .map((s) => {

          const leaders =
            s.leaders
              .sort(
                (a, b) =>
                  b.score - a.score
              )
              .slice(0, 3)
              .map((x) => x.name)
              .join(", ");

          return {
            name: s.name,

            change:
              `${s.bestChange > 0 ? "+" : ""}` +
              `${s.bestChange.toFixed(2)}%`,

            strength: Math.min(
              Math.round(
                s.totalScore / s.count
              ),
              100
            ),

            leaders
          };

        })
        .sort(
          (a, b) =>
            b.strength - a.strength
        )
        .slice(0, 8);

    // =========================
    // 응답
    // =========================
    return res.status(200).json({
      success: true,

      mode:
        "우량주 눌림반등 스캐너",

      scanned:
        scanList.length,

      updatedAt:
        new Date().toLocaleString(
          "ko-KR",
          {
            timeZone: "Asia/Seoul"
          }
        ),

      stocks:
        stocks.slice(0, 30),

      sectors

    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      message: error.message
    });

  }
}
