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

    const headers = {
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
          ...headers,
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
          code: x.mksc_shrn_iscd || x.stck_shrn_iscd || x.iscd || x.code,
          name: x.hts_kor_isnm || x.prdt_name || x.name || "",
          market: marketCode === "1001" ? "KOSDAQ" : "KOSPI",
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

    function average(arr) {
      if (!arr.length) return 0;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    function getKoreaSession() {
      const parts = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).formatToParts(new Date());

      const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
      const nowMin = hour * 60 + minute;

      if (nowMin >= 480 && nowMin <= 530) return "NXT 프리마켓 확인 구간";
      if (nowMin >= 540 && nowMin <= 920) return "정규장 판단 구간";
      if (nowMin >= 940 && nowMin <= 1200) return "NXT 애프터마켓 확인 구간";
      return "장외/휴장 판단 구간";
    }

    const sessionLabel = getKoreaSession();

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
        { code: "005930", name: "삼성전자", market: "KOSPI", sector: "코스피 상위권" },
        { code: "000660", name: "SK하이닉스", market: "KOSPI", sector: "코스피 상위권" },
        { code: "005380", name: "현대차", market: "KOSPI", sector: "코스피 상위권" },
        { code: "000270", name: "기아", market: "KOSPI", sector: "코스피 상위권" },
        { code: "064350", name: "현대로템", market: "KOSPI", sector: "코스피 상위권" },
        { code: "204320", name: "HL만도", market: "KOSPI", sector: "코스피 상위권" },
        { code: "006280", name: "녹십자", market: "KOSPI", sector: "코스피 상위권" }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        { code: "196170", name: "알테오젠", market: "KOSDAQ", sector: "코스닥 상위권" },
        { code: "086520", name: "에코프로", market: "KOSDAQ", sector: "코스닥 상위권" },
        { code: "247540", name: "에코프로비엠", market: "KOSDAQ", sector: "코스닥 상위권" },
        { code: "277810", name: "레인보우로보틱스", market: "KOSDAQ", sector: "코스닥 상위권" },
        { code: "042700", name: "한미반도체", market: "KOSDAQ", sector: "코스닥 상위권" }
      ];
    }

    const universe = [...kospi, ...kosdaq];

    const stocks = [];
    const stats = {
      scanned: 0,
      passed: 0,
      excludedSurge: 0,
      excludedBreakdown: 0,
      excludedVolume: 0,
      scoreMiss: 0
    };

    for (const item of universe) {
      try {
        stats.scanned += 1;

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
          .slice(0, 60);

        if (daily.length < 40) continue;

        const recent3 = daily.slice(0, 3);
        const recent5 = daily.slice(0, 5);
        const recent20 = daily.slice(0, 20);
        const recent40 = daily.slice(0, 40);
        const prev15 = daily.slice(5, 20);

        const ma5 = average(recent5.map((d) => d.close));
        const ma20 = average(recent20.map((d) => d.close));
        const ma20Prev5 = average(daily.slice(5, 25).map((d) => d.close));
        const avgVol5 = average(recent5.map((d) => d.volume));
        const avgVol20 = average(recent20.map((d) => d.volume));
        const avgVolPrev15 = average(prev15.map((d) => d.volume));

        const low20 = Math.min(...recent20.map((d) => d.low));
        const low60 = Math.min(...daily.slice(0, 60).map((d) => d.low));
        const high40 = Math.max(...recent40.map((d) => d.high));
        const low40 = Math.min(...recent40.map((d) => d.low));

        const distLow20 = low20 > 0 ? ((currentPrice - low20) / low20) * 100 : 999;
        const distLow60 = low60 > 0 ? ((currentPrice - low60) / low60) * 100 : 999;
        const range40 = low40 > 0 ? ((high40 - low40) / low40) * 100 : 999;
        const boxLower =
          high40 > low40 ? ((currentPrice - low40) / (high40 - low40)) : 1;

        const volRel5_20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
        const volRelToday20 = avgVol20 > 0 ? todayVolume / avgVol20 : 1;
        const volRecovery = avgVolPrev15 > 0 ? avgVol5 / avgVolPrev15 : 1;

        const volBuild3 =
          recent3.length === 3 &&
          recent3[0].volume >= recent3[1].volume &&
          recent3[1].volume >= recent3[2].volume;

        const ma20Slope =
          ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0;

        const intradayRebound = low > 0 ? ((currentPrice - low) / low) * 100 : 0;
        const highPullback = high > 0 ? ((high - currentPrice) / high) * 100 : 0;

        const threeDayChange =
          daily[2]?.close > 0
            ? ((currentPrice - daily[2].close) / daily[2].close) * 100
            : 0;

        const upperTail =
          high > low ? (high - currentPrice) / (high - low) : 0;

        const bodyRate =
          daily[1]?.close > 0
            ? (Math.abs(currentPrice - open) / daily[1].close) * 100
            : 0;

        // =========================
        // 강한 제외 조건
        // =========================
        if (changeRate >= 8 || threeDayChange >= 15) {
          stats.excludedSurge += 1;
          continue;
        }

        if (changeRate <= -5 || currentPrice < low20 * 0.96) {
          stats.excludedBreakdown += 1;
          continue;
        }

        if (todayVolume < 20000) {
          stats.excludedVolume += 1;
          continue;
        }

        // =========================
        // 점수 계산
        // =========================
        let score = 0;
        const reasons = [];

        // 1. 바닥 위치
        if (distLow20 <= 5 || distLow60 <= 8) {
          score += 18;
          reasons.push("저점권");
        } else if (distLow20 <= 12) {
          score += 9;
          reasons.push("저점 근처");
        }

        // 2. 박스권/에너지 압축
        if (range40 <= 25 && boxLower <= 0.35) {
          score += 14;
          reasons.push("박스 하단");
        } else if (range40 <= 35 && boxLower <= 0.5) {
          score += 7;
          reasons.push("박스권");
        }

        // 3. 거래량 지속성
        if (volBuild3) {
          score += 12;
          reasons.push("3일 거래량 증가");
        }

        if (volRel5_20 >= 0.9 && volRel5_20 <= 1.8) {
          score += 12;
          reasons.push("5일 거래량 회복");
        }

        if (volRecovery >= 1.0 && volRecovery <= 2.2) {
          score += 10;
          reasons.push("거래량 축적");
        }

        if (volRelToday20 >= 0.8 && volRelToday20 <= 3.0) {
          score += 8;
          reasons.push("당일 거래량 유지");
        }

        // 4. 추세 회복
        if (currentPrice >= ma20) {
          score += 12;
          reasons.push("20일선 회복");
        } else if (currentPrice >= ma20 * 0.97) {
          score += 6;
          reasons.push("20일선 근접");
        }

        if (currentPrice >= ma5) {
          score += 8;
          reasons.push("5일선 회복");
        }

        if (ma20Slope > -0.5) {
          score += 6;
          reasons.push("하락 둔화");
        }

        // 5. 장중 회복
        if (intradayRebound >= 1.0) {
          score += 6;
          reasons.push("장중 저점 회복");
        }

        if (currentPrice >= open) {
          score += 6;
          reasons.push("시가 회복");
        }

        // 6. 캔들 품질
        if (upperTail <= 0.45) {
          score += 5;
          reasons.push("윗꼬리 부담 낮음");
        }

        if (bodyRate >= 3 && changeRate > 4) {
          score -= 8;
          reasons.push("장대봉 추격 주의");
        }

        if (highPullback >= 8 && changeRate < 0) {
          score -= 10;
          reasons.push("고점 이탈 주의");
        }

        if (volRelToday20 > 4) {
          score -= 10;
          reasons.push("거래량 과열 주의");
        }

        // 7. NXT 세션 보정
        if (sessionLabel.includes("NXT")) {
          score += 3;
          reasons.push(sessionLabel);
        }

        score = Math.max(0, Math.min(score, 100));

        if (score < 50) {
          stats.scoreMiss += 1;
          continue;
        }

        let status = "관찰";
        let action = "관찰만";

        if (score >= 80) {
          status = "매수후보";
          action = "1차 분할 가능";
        } else if (score >= 65) {
          status = "분할관심";
          action = "눌림 확인 후 1차";
        } else {
          status = "관찰후보";
          action = "후보 저장";
        }

        stats.passed += 1;

        stocks.push({
          name: item.name,
          code: item.code,
          market: item.market,
          sector: item.sector,
          price: currentPrice.toLocaleString(),
          change: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
          score,
          status,
          action,

          sectorRank: "바닥·축적·수급 스윙",
          programBuy: `${sessionLabel} / 수급 확인 필요`,

          bigTrade:
            volBuild3 || volRel5_20 >= 1
              ? "거래량 회복 포착"
              : "거래량 관찰",

          bigTradeAmount: `5일/20일 거래량 ${volRel5_20.toFixed(
            2
          )}배, 오늘/20일 ${volRelToday20.toFixed(2)}배`,

          supply:
            "외국인·기관·프로그램 상세 수급은 추가 API 연결 대상",

          volume: `오늘 ${todayVolume.toLocaleString()}주`,

          chart: `20일저점 +${distLow20.toFixed(
            1
          )}%, 40일박스 위치 ${(boxLower * 100).toFixed(
            0
          )}%, 20일선 대비 ${(((currentPrice - ma20) / ma20) * 100).toFixed(
            1
          )}%`,

          reason: reasons.slice(0, 6).join(" · "),

          buy: "1차 25% / 눌림 시 2차",
          stop: "20일 저점 이탈 또는 거래량 동반 음봉",
          target: "전고점 회복 / +5~8%"
        });
      } catch (e) {
        continue;
      }
    }

    stocks.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      mode: "바닥·축적·수급 스윙 스캐너",
      session: sessionLabel,
      scanned: stats.scanned,
      stats,
      updatedAt: new Date().toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul"
      }),
      stocks: stocks.slice(0, 30),
      sectors: []
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
