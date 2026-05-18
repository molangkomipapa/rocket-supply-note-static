export default async function handler(req, res) {
  try {
    const BASE_URL =
      process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
    const requestedConcurrency = Number(process.env.SCAN_CONCURRENCY || 8);
    const scanConcurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedConcurrency) ? requestedConcurrency : 8,
        16
      )
    );

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

    const headers = {
      authorization: `Bearer ${tokenData.access_token}`,
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
        headers: { ...headers, tr_id: trId }
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
          market: marketCode === "1001" ? "KOSDAQ" : "KOSPI"
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

    const endDate = getTodayYmd();

    async function getDailyChart(code) {
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

    function getTodayYmd() {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    }

    function avg(arr) {
      if (!arr.length) return 0;
      return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    async function mapWithConcurrency(items, limit, mapper) {
      const results = new Array(items.length);
      let nextIndex = 0;

      async function worker() {
        while (nextIndex < items.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
      }

      const workerCount = Math.min(limit, items.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
      return results;
    }

    function getSessionLabel() {
      const parts = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).formatToParts(new Date());

      const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
      const t = h * 60 + m;

      if (t >= 480 && t <= 530) return "NXT 프리마켓 확인";
      if (t >= 540 && t <= 920) return "정규장 판단";
      if (t >= 940 && t <= 1200) return "NXT 애프터마켓 확인";
      return "장외/휴장 판단";
    }

    const sessionLabel = getSessionLabel();

    const [kospiResult, kosdaqResult] = await Promise.allSettled([
      getMarketCapRank("0001", 270),
      getMarketCapRank("1001", 500)
    ]);

    let kospi = kospiResult.status === "fulfilled" ? kospiResult.value : [];
    let kosdaq = kosdaqResult.status === "fulfilled" ? kosdaqResult.value : [];

    if (!kospi.length) {
      kospi = [
        { code: "005930", name: "삼성전자", market: "KOSPI" },
        { code: "000660", name: "SK하이닉스", market: "KOSPI" },
        { code: "005380", name: "현대차", market: "KOSPI" },
        { code: "000270", name: "기아", market: "KOSPI" },
        { code: "064350", name: "현대로템", market: "KOSPI" },
        { code: "204320", name: "HL만도", market: "KOSPI" },
        { code: "006280", name: "녹십자", market: "KOSPI" },
        { code: "454910", name: "두산로보틱스", market: "KOSPI" },
        { code: "034020", name: "두산에너빌리티", market: "KOSPI" }
      ];
    }

    if (!kosdaq.length) {
      kosdaq = [
        { code: "196170", name: "알테오젠", market: "KOSDAQ" },
        { code: "086520", name: "에코프로", market: "KOSDAQ" },
        { code: "247540", name: "에코프로비엠", market: "KOSDAQ" },
        { code: "277810", name: "레인보우로보틱스", market: "KOSDAQ" },
        { code: "042700", name: "한미반도체", market: "KOSDAQ" }
      ];
    }

    const universe = [...kospi, ...kosdaq];

    const stocks = [];
    const stats = {
      scanned: 0,
      passed: 0,
      scoreMiss: 0,
      excludedBreakdown: 0,
      excludedExtremeSurge: 0,
      excludedVolume: 0
    };

    function grade(score) {
      if (score >= 80) return { status: "매수후보", action: "1차 분할 가능" };
      if (score >= 65) return { status: "분할관심", action: "눌림 확인 후 1차" };
      if (score >= 50) return { status: "관찰후보", action: "후보 저장" };
      return { status: "제외", action: "미진입" };
    }

    function evaluateStrategies(m) {
      const results = [];

      // 전략 1. 바닥권 수급 초기형
      let s1 = 0;
      const r1 = [];

      if (m.distLow20 <= 8 || m.distLow60 <= 12) {
        s1 += 20;
        r1.push("저점권");
      }
      if (m.range40 <= 35 && m.boxLower <= 0.45) {
        s1 += 16;
        r1.push("박스 하단/중단");
      }
      if (m.volBuild3) {
        s1 += 14;
        r1.push("3일 거래량 증가");
      }
      if (m.volRel5_20 >= 0.85 && m.volRel5_20 <= 2.2) {
        s1 += 14;
        r1.push("거래량 회복");
      }
      if (m.price >= m.ma20 * 0.96 && m.price <= m.ma20 * 1.08) {
        s1 += 12;
        r1.push("20일선 근처");
      }
      if (m.ma20Slope > -0.8) {
        s1 += 8;
        r1.push("하락 둔화");
      }
      if (m.changeRate >= -3 && m.changeRate <= 4.8) {
        s1 += 10;
        r1.push("하락폭 제한");
      }

      results.push({
        strategyType: "바닥권 수급 초기형",
        strategyCode: "BOTTOM",
        score: s1,
        reasons: r1
      });

      // 전략 2. 강한 추세 눌림목형
      let s2 = 0;
      const r2 = [];

      if (m.price > m.ma20 && m.ma20 > m.ma60) {
        s2 += 22;
        r2.push("20일·60일선 위");
      }
      if (m.ma20Slope > 0) {
        s2 += 12;
        r2.push("20일선 상승");
      }
      if (m.pullbackFromHigh20 >= 4 && m.pullbackFromHigh20 <= 18) {
        s2 += 18;
        r2.push("고점 대비 건강한 눌림");
      }
      if (m.price >= m.ma20 * 0.97) {
        s2 += 14;
        r2.push("20일선 지지권");
      }
      if (m.volRelToday20 <= 2.5 && m.changeRate >= -4) {
        s2 += 10;
        r2.push("눌림 과열 아님");
      }
      if (m.intradayRebound >= 1 || m.price >= m.open) {
        s2 += 10;
        r2.push("장중 회복");
      }
      if (m.volRel5_20 >= 0.8 && m.volRel5_20 <= 1.8) {
        s2 += 8;
        r2.push("거래량 유지");
      }

      results.push({
        strategyType: "강한 추세 눌림목형",
        strategyCode: "TREND_PULLBACK",
        score: s2,
        reasons: r2
      });

      // 전략 3. 급등 후 재압축형
      let s3 = 0;
      const r3 = [];

      if (m.hasBigCandle10) {
        s3 += 20;
        r3.push("최근 강한 양봉 발생");
      }
      if (m.afterBigCandleHold) {
        s3 += 18;
        r3.push("급등 후 가격 유지");
      }
      if (m.volCoolingAfterSurge) {
        s3 += 16;
        r3.push("거래량 진정");
      }
      if (m.price >= m.ma5 * 0.96 && m.price >= m.ma20 * 0.94) {
        s3 += 14;
        r3.push("5일·20일선 지지권");
      }
      if (m.pullbackFromHigh20 >= 5 && m.pullbackFromHigh20 <= 20) {
        s3 += 12;
        r3.push("과열 후 적정 눌림");
      }
      if (m.volRelToday20 >= 0.7 && m.volRelToday20 <= 2.5) {
        s3 += 8;
        r3.push("재압축 거래량");
      }
      if (m.changeRate <= 6) {
        s3 += 8;
        r3.push("재추격 아님");
      }

      results.push({
        strategyType: "급등 후 재압축형",
        strategyCode: "RE_COMPRESSION",
        score: s3,
        reasons: r3
      });

      return results.sort((a, b) => b.score - a.score);
    }

    async function scanStock(item) {
      try {
        stats.scanned += 1;

        const [priceData, dailyRaw] = await Promise.all([
          getPrice(item.code),
          getDailyChart(item.code)
        ]);
        if (!priceData) return null;

        const price = Number(priceData.stck_prpr || 0);
        const changeRate = Number(priceData.prdy_ctrt || 0);
        const todayVolume = Number(priceData.acml_vol || 0);
        const open = Number(priceData.stck_oprc || 0);
        const high = Number(priceData.stck_hgpr || 0);
        const low = Number(priceData.stck_lwpr || 0);

        const daily = dailyRaw
          .map((d) => ({
            close: Number(d.stck_clpr || 0),
            open: Number(d.stck_oprc || 0),
            high: Number(d.stck_hgpr || 0),
            low: Number(d.stck_lwpr || 0),
            volume: Number(d.acml_vol || 0)
          }))
          .filter((d) => d.close > 0)
          .slice(0, 80);

        if (daily.length < 60) return null;

        const recent3 = daily.slice(0, 3);
        const recent5 = daily.slice(0, 5);
        const recent10 = daily.slice(0, 10);
        const recent20 = daily.slice(0, 20);
        const recent40 = daily.slice(0, 40);
        const recent60 = daily.slice(0, 60);

        const ma5 = avg(recent5.map((d) => d.close));
        const ma20 = avg(recent20.map((d) => d.close));
        const ma60 = avg(recent60.map((d) => d.close));
        const ma20Prev5 = avg(daily.slice(5, 25).map((d) => d.close));

        const avgVol5 = avg(recent5.map((d) => d.volume));
        const avgVol20 = avg(recent20.map((d) => d.volume));

        const low20 = Math.min(...recent20.map((d) => d.low));
        const low60 = Math.min(...recent60.map((d) => d.low));
        const high20 = Math.max(...recent20.map((d) => d.high));
        const high40 = Math.max(...recent40.map((d) => d.high));
        const low40 = Math.min(...recent40.map((d) => d.low));

        const distLow20 = low20 > 0 ? ((price - low20) / low20) * 100 : 999;
        const distLow60 = low60 > 0 ? ((price - low60) / low60) * 100 : 999;
        const range40 = low40 > 0 ? ((high40 - low40) / low40) * 100 : 999;
        const boxLower = high40 > low40 ? (price - low40) / (high40 - low40) : 1;
        const pullbackFromHigh20 =
          high20 > 0 ? ((high20 - price) / high20) * 100 : 0;

        const volRel5_20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
        const volRelToday20 = avgVol20 > 0 ? todayVolume / avgVol20 : 1;
        const volBuild3 =
          recent3.length === 3 &&
          recent3[0].volume >= recent3[1].volume &&
          recent3[1].volume >= recent3[2].volume;

        const ma20Slope = ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0;
        const intradayRebound = low > 0 ? ((price - low) / low) * 100 : 0;

        const threeDayChange =
          daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0;

        // 극단 제외
        if (changeRate <= -7 || price < low20 * 0.94) {
          stats.excludedBreakdown += 1;
          return null;
        }
        if (changeRate >= 12 || threeDayChange >= 25) {
          stats.excludedExtremeSurge += 1;
          return null;
        }
        if (todayVolume < 20000) {
          stats.excludedVolume += 1;
          return null;
        }

        const bigCandle = recent10.find((d) => {
          const body = d.close > 0 ? ((d.close - d.open) / d.close) * 100 : 0;
          return body >= 5 && d.volume >= avgVol20 * 1.5;
        });

        const hasBigCandle10 = !!bigCandle;
        const afterBigCandleHold = hasBigCandle10 && price >= low20 * 1.03;
        const volCoolingAfterSurge = hasBigCandle10 && volRelToday20 <= 2.5;

        const metrics = {
          price,
          open,
          changeRate,
          todayVolume,
          ma5,
          ma20,
          ma60,
          ma20Slope,
          distLow20,
          distLow60,
          range40,
          boxLower,
          volRel5_20,
          volRelToday20,
          volBuild3,
          intradayRebound,
          pullbackFromHigh20,
          hasBigCandle10,
          afterBigCandleHold,
          volCoolingAfterSurge
        };

        const strategyScores = evaluateStrategies(metrics);
        const best = strategyScores[0];

        let finalScore = best.score;

        // 공통 추격/위험 페널티
        const penalties = [];
        if (changeRate >= 8) {
          finalScore -= 12;
          penalties.push("당일 급등 추격 주의");
        }
        if (threeDayChange >= 15) {
          finalScore -= 10;
          penalties.push("3일 상승률 과열");
        }
        if (volRelToday20 > 4) {
          finalScore -= 10;
          penalties.push("거래량 폭발 주의");
        }
        if (sessionLabel.includes("NXT")) {
          finalScore += 3;
        }

        finalScore = Math.max(0, Math.min(finalScore, 100));

        if (finalScore < 50) {
          stats.scoreMiss += 1;
          return null;
        }

        const g = grade(finalScore);
        stats.passed += 1;

        return {
          name: item.name,
          code: item.code,
          market: item.market,
          sector: item.market === "KOSDAQ" ? "코스닥 상위권" : "코스피 상위권",

          price: price.toLocaleString(),
          change: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,

          score: finalScore,
          status: g.status,
          action: g.action,

          strategyType: best.strategyType,
          strategyCode: best.strategyCode,
          sectorRank: best.strategyType,

          programBuy: `${sessionLabel} / ${best.strategyType}`,
          bigTrade:
            volBuild3 || volRel5_20 >= 1
              ? "거래량 회복 포착"
              : "거래량 관찰",
          bigTradeAmount: `오늘/20일 ${volRelToday20.toFixed(2)}배 · 5일/20일 ${volRel5_20.toFixed(2)}배`,
          supply: "외국인·기관·프로그램 수급 API 추가 연결 예정",
          volume: `오늘 ${todayVolume.toLocaleString()}주`,

          chart: `20일저점 +${distLow20.toFixed(1)}% · 고점대비 -${pullbackFromHigh20.toFixed(1)}% · 박스위치 ${(boxLower * 100).toFixed(0)}%`,

          reason: [...best.reasons, ...penalties].slice(0, 7).join(" · "),

          buy:
            best.strategyCode === "BOTTOM"
              ? "1차 25% / 저점 이탈 없을 때 추가"
              : best.strategyCode === "TREND_PULLBACK"
              ? "20일선 눌림 확인 후 분할"
              : "급등 후 거래량 감소·가격 유지 확인 후 분할",

          stop:
            best.strategyCode === "TREND_PULLBACK"
              ? "20일선 이탈 + 거래량 증가 음봉"
              : "20일 저점 이탈 또는 수급 악화",

          target: "전고점 회복 / +5~8%"
        };
      } catch (e) {
        return null;
      }
    }

    const scannedStocks = await mapWithConcurrency(
      universe,
      scanConcurrency,
      scanStock
    );
    stocks.push(...scannedStocks.filter(Boolean));

    stocks.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      mode: "3전략 통합 수급 스윙 스캐너",
      session: sessionLabel,
      scanned: stats.scanned,
      stats,
      updatedAt: new Date().toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul"
      }),
      stocks: stocks.slice(0, 40),
      sectors: []
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
