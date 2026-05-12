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

    // =========================
    // 공통 GET 함수
    // =========================
    async function kisGet(path, trId, params) {
      const url = new URL(`${BASE_URL}${path}`);

      Object.entries(params || {}).forEach(([key, value]) => {
        url.searchParams.set(key, value);
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
    // 시총 상위 종목 조회
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
    // 코스피 / 코스닥 상위
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

    // =========================
    // 실패 대비 예비 종목
    // =========================
    if (!kospi.length) {
      kospi = [
        {
          code: "005930",
          name: "삼성전자",
          sector: "코스피 우량주"
        },
        {
          code: "000660",
          name: "SK하이닉스",
          sector: "코스피 우량주"
        },
        {
          code: "373220",
          name: "LG에너지솔루션",
          sector: "코스피 우량주"
        },
        {
          code: "207940",
          name: "삼성바이오로직스",
          sector: "코스피 우량주"
        },
        {
          code: "005380",
          name: "현대차",
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
        },
        {
          code: "086520",
          name: "에코프로",
          sector: "코스닥 우량주"
        },
        {
          code: "247540",
          name: "에코프로비엠",
          sector: "코스닥 우량주"
        },
        {
          code: "277810",
          name: "레인보우로보틱스",
          sector: "코스닥 우량주"
        }
      ];
    }

    // =========================
    // 우량주 200개
    // =========================
    const universe = [
      ...kospi,
      ...kosdaq
    ];

    /*
      코스피 시가총액 상위 100개
      +
      코스닥 시가총액 상위 100개
    */

    const scanList = universe.slice(0, 200);

    const stocks = [];
    const sectorMap = {};

    // =========================
    // 종목 스캔
    // =========================
    for (const item of scanList) {
      try {
        const output = await getPrice(item.code);

        if (!output) continue;

        const currentPrice = Number(
          output.stck_prpr || 0
        );

        const changeRate = Number(
          output.prdy_ctrt || 0
        );

        const volume = Number(
          output.acml_vol || 0
        );

        const open = Number(
          output.stck_oprc || 0
        );

        const high = Number(
          output.stck_hgpr || 0
        );

        const low = Number(
          output.stck_lwpr || 0
        );

        // =========================
        // 점수 계산
        // =========================
        let score = 35;

        // 상승률
        if (changeRate > 0) score += 10;
        if (changeRate >= 1.5) score += 10;
        if (changeRate >= 3) score += 10;
        if (changeRate >= 5) score += 5;

        // 거래량
        if (volume >= 300000) score += 5;
        if (volume >= 800000) score += 10;
        if (volume >= 1500000) score += 10;
        if (volume >= 3000000) score += 10;

        // 장중 흐름
        if (currentPrice > open) score += 10;

        if (
          high > 0 &&
          currentPrice >= high * 0.97
        ) {
          score += 10;
        }

        if (
          low > 0 &&
          currentPrice > low * 1.03
        ) {
          score += 5;
        }

        score = Math.min(score, 100);

        // =========================
        // 상태
        // =========================
        let status = "관찰";

        if (score >= 85) {
          status = "당일 주도주 후보";
        } else if (score >= 75) {
          status = "강관심";
        } else if (score >= 60) {
          status = "눌림반등 관찰";
        } else if (score >= 45) {
          status = "관심";
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
        // 후보 저장
        // =========================
        if (score >= 45) {
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

            sectorRank: item.sector,

            programBuy:
              "프로그램 수급 추가 연결 예정",

            bigTrade:
              volume >= 1500000
                ? "거래량 증가 포착"
                : "거래량 관찰",

            bigTradeAmount:
              "대량체결 API 추가 연결 예정",

            supply:
              "외국인/기관 수급 추가 연결 예정",

            volume:
              `누적거래량 ${volume.toLocaleString()}주`,

            chart:
              currentPrice > open
                ? "양봉 흐름 확인"
                : "눌림 구간 관찰",

            score,

            reason:
              score >= 75
                ? "우량주 감시군 안에서 거래량과 상승률이 동시에 살아나는 종목입니다."
                : "우량주 감시군 안에서 눌림 또는 반등 가능성을 관찰하는 종목입니다.",

            buy: "분할 접근",

            stop:
              "-3% 또는 직전 저점 이탈",

            target:
              "+5~7% / 전고점"
          });
        }
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
          const leaders = s.leaders
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
        "KOSPI100_KOSDAQ100",

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
