const runtimeCache = globalThis.__rocketSupplyRuntimeCache || {
  token: null,
  scan: null
};
globalThis.__rocketSupplyRuntimeCache = runtimeCache;

export default async function handler(req, res) {
  try {
    const BASE_URL =
      process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
    const requestStartedAt = Date.now();
    const forceRefresh = req.query?.refresh === "1";
    const analyzeCodeParam = String(req.query?.analyzeCode || "").trim();
    const scanCacheTtlSeconds = Math.max(
      15,
      Math.min(Number(process.env.SCAN_CACHE_TTL_SECONDS ?? 180), 900)
    );
    const scanStaleTtlSeconds = Math.max(
      scanCacheTtlSeconds,
      Math.min(Number(process.env.SCAN_STALE_TTL_SECONDS ?? 900), 3600)
    );
    const requestedConcurrency = Number(process.env.SCAN_CONCURRENCY || 4);
    const scanConcurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4,
        8
      )
    );
    const requestedTopPercent = Number(process.env.SCAN_MARKET_TOP_PERCENT || 30);
    const marketTopPercent = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedTopPercent) ? requestedTopPercent : 30,
        100
      )
    );
    const estimatedKospiTotal = getPositiveNumber(
      process.env.KOSPI_LISTED_TOTAL,
      950
    );
    const estimatedKosdaqTotal = getPositiveNumber(
      process.env.KOSDAQ_LISTED_TOTAL,
      1800
    );
    const kospiScanCount = Math.ceil(
      estimatedKospiTotal * (marketTopPercent / 100)
    );
    const kosdaqScanCount = Math.ceil(
      estimatedKosdaqTotal * (marketTopPercent / 100)
    );
    const requestedMarketDataCode = String(
      process.env.KIS_MARKET_DATA_CODE || "UN"
    ).toUpperCase();
    const marketDataCode = ["J", "NX", "UN"].includes(requestedMarketDataCode)
      ? requestedMarketDataCode
      : "UN";
    const requestedProgramTradeScanLimit = Number(
      process.env.PROGRAM_TRADE_SCAN_LIMIT ?? 25
    );
    const programTradeScanLimit = Math.max(
      0,
      Math.min(
        Number.isFinite(requestedProgramTradeScanLimit)
          ? requestedProgramTradeScanLimit
          : 25,
        400
      )
    );
    const scanCacheKey = JSON.stringify({
      marketTopPercent,
      estimatedKospiTotal,
      estimatedKosdaqTotal,
      marketDataCode,
      kospiScanCount,
      kosdaqScanCount,
      programTradeScanLimit
    });

    if (
      !analyzeCodeParam &&
      !forceRefresh &&
      runtimeCache.scan?.key === scanCacheKey &&
      requestStartedAt - runtimeCache.scan.savedAt < scanCacheTtlSeconds * 1000
    ) {
      return res.status(200).json({
        ...runtimeCache.scan.payload,
        cache: {
          status: "fresh",
          ageSeconds: Math.round((requestStartedAt - runtimeCache.scan.savedAt) / 1000),
          ttlSeconds: scanCacheTtlSeconds
        }
      });
    }

    let accessToken = runtimeCache.token?.accessToken;
    if (!accessToken || runtimeCache.token.expiresAt <= requestStartedAt + 60000) {
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

      accessToken = tokenData.access_token;
      runtimeCache.token = {
        accessToken,
        expiresAt:
          requestStartedAt +
          Math.max(Number(tokenData.expires_in || 82800), 3600) * 1000
      };
    }

    const headers = {
      authorization: `Bearer ${accessToken}`,
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

    async function getPrice(code, marketCode = marketDataCode) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-price",
        "FHKST01010100",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: code
        }
      );
      const output = data.output || null;
      if (output || marketCode === "J") return output;
      return getPrice(code, "J");
    }

    const endDate = getTodayYmd();

    async function getDailyChart(code, marketCode = marketDataCode, toDate = endDate) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        "FHKST03010100",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: code,
          fid_input_date_1: "20240101",
          fid_input_date_2: toDate,
          fid_period_div_code: "D",
          fid_org_adj_prc: "0"
        }
      );

      const output = data.output2 || [];
      if (output.length || marketCode === "J") return output;
      return getDailyChart(code, "J", toDate);
    }

    async function getProgramTradeDaily(code, marketCode = marketDataCode, date = "") {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
        "FHPPG04650201",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: code,
          fid_input_date_1: date
        }
      );

      const output = data.output || data.output1 || data.output2 || [];
      if (output.length || marketCode === "J") return output;
      return getProgramTradeDaily(code, "J", date);
    }

    function pickNumber(source, candidates) {
      for (const key of candidates) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
          const n = Number(String(source[key]).replace(/,/g, ""));
          if (Number.isFinite(n)) return n;
        }
      }
      return 0;
    }

    function getProgramNetValue(row) {
      const direct = pickNumber(row, [
        "prgm_ntby_tr_pbmn",
        "prgm_ntby_pbmn",
        "ntby_tr_pbmn",
        "NTBY_TR_PBMN",
        "whol_ntby_tr_pbmn",
        "acml_ntby_tr_pbmn"
      ]);
      if (direct) return direct;

      const buy = pickNumber(row, [
        "shnu_tr_pbmn",
        "SHNU_TR_PBMN",
        "prgm_buy_tr_pbmn",
        "buy_tr_pbmn"
      ]);
      const sell = pickNumber(row, [
        "seln_tr_pbmn",
        "SELN_TR_PBMN",
        "prgm_sell_tr_pbmn",
        "sell_tr_pbmn"
      ]);
      if (buy || sell) return buy - sell;

      return pickNumber(row, [
        "prgm_ntby_qty",
        "ntby_cnqn",
        "NTBY_CNQN",
        "whol_ntby_qty",
        "acml_ntby_qty"
      ]);
    }

    function analyzeProgramContinuity(rows) {
      const recent = (rows || []).slice(0, 5);
      const values = recent.map(getProgramNetValue);
      const positiveDays = values.filter((v) => v > 0).length;
      const threeDayPositive = values.slice(0, 3).length === 3 && values.slice(0, 3).every((v) => v > 0);
      const totalNet = values.reduce((sum, v) => sum + v, 0);

      return {
        available: recent.length > 0,
        positiveDays,
        threeDayPositive,
        totalNet,
        label: threeDayPositive
          ? "프로그램 순매수 지속"
          : positiveDays >= 3
          ? "프로그램 순매수 우위"
          : positiveDays > 0
          ? "프로그램 단발 유입"
          : "프로그램 확인 대기",
        detail: recent.length
          ? `최근 ${recent.length}일 중 ${positiveDays}일 순매수`
          : "프로그램 매매 데이터 없음"
      };
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

    function getUpperWickRatio(candle) {
      const range = candle.high - candle.low;
      if (range <= 0) return 0;
      return (candle.high - Math.max(candle.close, candle.open)) / range;
    }

    function getPositiveNumber(value, fallback) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : fallback;
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
      getMarketCapRank("0001", kospiScanCount),
      getMarketCapRank("1001", kosdaqScanCount)
    ]);

    let kospi = kospiResult.status === "fulfilled" ? kospiResult.value : [];
    let kosdaq = kosdaqResult.status === "fulfilled" ? kosdaqResult.value : [];

    // 고정 샘플 대체 로직 제거: 코스피/코스닥 상위 30% 종목만 스캔합니다.
    // API에서 종목 리스트를 가져오지 못하면 해당 시장은 빈 목록으로 처리됩니다.

    const universe = [...kospi, ...kosdaq];
    const scanScope = {
      topPercent: marketTopPercent,
      marketDataCode,
      marketDataName:
        marketDataCode === "UN"
          ? "KRX+NXT 통합"
          : marketDataCode === "NX"
          ? "NXT"
          : "KRX",
      kospi: {
        estimatedTotal: estimatedKospiTotal,
        targetCount: kospiScanCount,
        actualCount: kospi.length
      },
      kosdaq: {
        estimatedTotal: estimatedKosdaqTotal,
        targetCount: kosdaqScanCount,
        actualCount: kosdaq.length
      },
      totalTargetCount: kospiScanCount + kosdaqScanCount,
      totalActualCount: universe.length,
      programTradeScanLimit
    };

    const stocks = [];
    const signalStocks = [];
    const avoidanceStocks = [];
    const missedStocks = [];
    const stats = {
      scanned: 0,
      passed: 0,
      scoreMiss: 0,
      excludedBreakdown: 0,
      excludedExtremeSurge: 0,
      excludedVolume: 0,
      validCharts: 0,
      rising: 0,
      aboveMa20: 0,
      recoveredMa20: 0,
      volumeIncreasing: 0,
      sharpDrop: 0,
      sharpSurge: 0,
      bottomCandidates: 0,
      trendPullbackCandidates: 0,
      riskCandidates: 0,
      chaseCandidates: 0,
      avoidanceSignalCount: 0,
      entrySignals: 0,
      watchSignals: 0
    };

    function rememberMissed(item, reason, detail) {
      if (missedStocks.length >= 40) return;
      missedStocks.push({
        name: item.name,
        code: item.code,
        market: item.market,
        reason,
        detail
      });
    }

    function rememberAvoidanceStock(item, m, avoidanceSignals, finalScore = 0) {
      const actionableSignals = avoidanceSignals.filter(
        (x) => x.severity === "RISK" || x.severity === "CHASE"
      );
      if (!actionableSignals.length) return;

      const existing = avoidanceStocks.find((x) => x.code === item.code);
      if (existing) {
        existing.avoidanceSignals = [
          ...existing.avoidanceSignals,
          ...actionableSignals.filter(
            (signal) =>
              !existing.avoidanceSignals.some((x) => x.code === signal.code)
          )
        ];
        existing.reason = existing.avoidanceSignals.map((x) => x.label).join(" · ");
        existing.score = Math.max(existing.score, finalScore);
        return;
      }

      avoidanceStocks.push({
        name: item.name,
        code: item.code,
        market: item.market,
        price: m.price.toLocaleString(),
        change: `${m.changeRate > 0 ? "+" : ""}${m.changeRate.toFixed(2)}%`,
        score: finalScore,
        avoidanceType: actionableSignals.some((x) => x.severity === "RISK")
          ? "위험"
          : "추격주의",
        reason: actionableSignals.map((x) => x.label).join(" · "),
        chart: `20일선 ${m.price >= m.ma20 ? "상회" : "이탈"} · 고점대비 -${m.pullbackFromHigh20.toFixed(1)}% · 거래량 ${m.volRelToday20.toFixed(2)}배`,
        avoidanceSignals: actionableSignals
      });
    }

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

    function isHealthyTrend(m) {
      return (
        m.price > m.ma20 &&
        m.ma20 > m.ma60 &&
        m.ma20Slope > 0 &&
        m.pullbackFromHigh20 >= 3 &&
        m.pullbackFromHigh20 <= 18 &&
        m.volRelToday20 <= 3.2 &&
        m.threeDayChange <= 18
      );
    }

    function buildAvoidanceSignals(m) {
      const signals = [];

      if (
        m.changeRate > 10 &&
        m.volRelToday20 > 4 &&
        m.upperWickRatio > 0.4
      ) {
        signals.push({
          code: "SURGE_VOLUME_UPPER_WICK",
          type: "추격주의",
          severity: "CHASE",
          label: "급등 후 거래량 폭발 + 윗꼬리",
          detail: "마지막 추격 매수 가능성, 고점권 추격 제외"
        });
      }

      if (
        m.ma20Slope > 0 &&
        m.price < m.ma20 &&
        m.volRelToday20 > 1.5 &&
        m.changeRate < -4
      ) {
        signals.push({
          code: "FIRST_TREND_BREAK",
          type: "위험",
          severity: "RISK",
          label: "강한 추세 첫 훼손",
          detail: "상승하던 20일선 이탈 + 거래량 증가 음봉"
        });
      }

      if (
        m.prevClose >= m.high20 * 0.95 &&
        m.changeRate < -5 &&
        m.volRelToday20 > 1.5
      ) {
        signals.push({
          code: "HIGH_AREA_DISTRIBUTION",
          type: "위험",
          severity: "RISK",
          label: "고점 대비 급락 시작",
          detail: "고점권 장대음봉과 거래량 증가, 세력 이탈 가능성"
        });
      }

      if (m.recentUpperWickCount >= 3) {
        signals.push({
          code: "REPEATED_REBOUND_FAIL",
          type: "관찰",
          severity: "WATCH",
          label: "반등 실패 반복",
          detail: "최근 5일 중 윗꼬리 캔들 3개 이상, 위 매물 부담"
        });
      }

      if (m.changeRate > 3 && m.volRelToday20 < 0.7) {
        signals.push({
          code: "LOW_VOLUME_REBOUND",
          type: "관찰",
          severity: "WATCH",
          label: "거래량 없는 반등",
          detail: "가격은 올랐지만 수급 확인 부족"
        });
      }

      if (
        m.hasBigCandle10 &&
        m.recentBoxLow > 0 &&
        m.price < m.recentBoxLow &&
        m.volRelToday20 >= 1.2
      ) {
        signals.push({
          code: "SURGE_BOX_BREAKDOWN",
          type: "위험",
          severity: "RISK",
          label: "급등 후 박스 붕괴",
          detail: "급등 후 재압축 실패, 박스 하단 이탈"
        });
      }

      return signals;
    }

    function classifySignal(m, finalScore = 0, bestStrategyCode = "") {
      const reasons = [];
      const healthyTrend = isHealthyTrend(m);
      const avoidanceSignals = buildAvoidanceSignals(m);
      const riskAvoidance = avoidanceSignals.find((x) => x.severity === "RISK");
      const chaseAvoidance = avoidanceSignals.find((x) => x.severity === "CHASE");
      const isRisk =
        !!riskAvoidance ||
        m.changeRate <= -5 ||
        m.price < m.ma20 * 0.97 ||
        m.price < m.low20 * 0.97 ||
        (m.changeRate < 0 && m.volRelToday20 >= 2.3 && m.price < m.open) ||
        m.pullbackFromHigh20 >= 24;
      const isChase =
        !!chaseAvoidance ||
        !healthyTrend &&
        (m.changeRate >= 8 ||
          m.threeDayChange >= 15 ||
          m.volRelToday20 >= 4 ||
          (m.changeRate >= 5 && m.price >= m.high20 * 0.98));

      if (isRisk) {
        if (riskAvoidance) reasons.push(riskAvoidance.label);
        if (m.changeRate <= -5) reasons.push("당일 급락");
        if (m.price < m.ma20 * 0.97) reasons.push("20일선 이탈");
        if (m.price < m.low20 * 0.97) reasons.push("저점 이탈");
        if (m.changeRate < 0 && m.volRelToday20 >= 2.3 && m.price < m.open) {
          reasons.push("거래량 동반 음봉");
        }
        if (m.pullbackFromHigh20 >= 24) reasons.push("고점 대비 급락");
        return {
          signalType: "위험",
          signalCode: "RISK",
          signalSummary: reasons.slice(0, 3).join(" · ")
        };
      }

      if (isChase) {
        if (chaseAvoidance) reasons.push(chaseAvoidance.label);
        if (m.changeRate >= 8) reasons.push("당일 급등");
        if (m.threeDayChange >= 15) reasons.push("단기 상승 과열");
        if (m.volRelToday20 >= 4) reasons.push("거래량 폭발");
        if (m.changeRate >= 5 && m.price >= m.high20 * 0.98) {
          reasons.push("고점권 장대양봉");
        }
        return {
          signalType: "추격주의",
          signalCode: "CHASE",
          signalSummary: reasons.slice(0, 3).join(" · ")
        };
      }

      if (
        finalScore >= 65 ||
        (bestStrategyCode === "BOTTOM" &&
          m.volRel5_20 >= 0.85 &&
          m.distLow20 <= 8 &&
          m.price >= m.low20 * 1.01)
      ) {
        return {
          signalType: "진입 관심",
          signalCode: "ENTRY",
          signalSummary: healthyTrend
            ? "강세 추세 · 과열 진정 · 20일선 위"
            : "저점 유지 · 거래량 회복 · 구조 양호"
        };
      }

      return {
        signalType: "관찰",
        signalCode: "WATCH",
        signalSummary: "구조 확인 · 수급 보강 대기"
      };
    }

    function getEntryDecision(signal, m, finalScore, bestStrategyCode) {
      const avoidanceSignals = buildAvoidanceSignals(m);
      const topAvoidance = avoidanceSignals.find((x) => x.severity === "RISK") ||
        avoidanceSignals.find((x) => x.severity === "CHASE");
      if (signal.signalCode === "RISK") {
        return {
          entryLabel: "위험 회피",
          entryCode: "AVOID",
          entryGuide: topAvoidance
            ? `${topAvoidance.label}: ${topAvoidance.detail}`
            : "20일선 회복 또는 거래량 둔화 전까지 보류"
        };
      }
      if (signal.signalCode === "CHASE") {
        return {
          entryLabel: "추격주의",
          entryCode: "CHASE",
          entryGuide: topAvoidance
            ? `${topAvoidance.label}: ${topAvoidance.detail}`
            : "당일 급등 추격보다 눌림 재확인"
        };
      }
      if (
        finalScore >= 72 &&
        m.price >= m.ma20 * 0.97 &&
        m.volRelToday20 <= 2.8 &&
        (bestStrategyCode === "BOTTOM" || isHealthyTrend(m))
      ) {
        return {
          entryLabel: "진입 유리",
          entryCode: "FAVORABLE",
          entryGuide: "1차 분할 후 저점 이탈 여부 확인"
        };
      }
      return {
        entryLabel: "관찰만",
        entryCode: "WATCH",
        entryGuide: "수급 지속 또는 눌림 지지 확인 후 접근"
      };
    }

    function getPositionLabel(boxLower) {
      if (boxLower <= 0.35) return "저점권";
      if (boxLower <= 0.7) return "중단권";
      return "고점권";
    }

    function makePositionBar(boxLower) {
      const percent = Math.max(0, Math.min(Math.round(boxLower * 100), 100));
      const filled = Math.max(1, Math.min(Math.round(percent / 10), 10));
      return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
    }

    function buildReasonChecklist(strategy, m) {
      const items = [];

      if (strategy.strategyCode === "BOTTOM") {
        items.push({ label: "20일 저점 부근", ok: m.distLow20 <= 8 });
        items.push({ label: "3일 거래량 증가", ok: m.volBuild3 });
        items.push({ label: "장중 저점 회복", ok: m.intradayRebound >= 1 });
        items.push({ label: "20일선 수렴 중", ok: m.price >= m.ma20 * 0.96 && m.price <= m.ma20 * 1.08 });
      } else if (strategy.strategyCode === "TREND_PULLBACK") {
        items.push({ label: "20일선 위 추세 유지", ok: m.price > m.ma20 });
        items.push({ label: "20일선 상승", ok: m.ma20Slope > 0 });
        items.push({ label: "고점 대비 건강한 눌림", ok: m.pullbackFromHigh20 >= 4 && m.pullbackFromHigh20 <= 18 });
        items.push({ label: "거래량 과열 아님", ok: m.volRelToday20 <= 2.5 });
      } else {
        items.push({ label: "최근 강한 양봉 이후 유지", ok: m.afterBigCandleHold });
        items.push({ label: "거래량 진정", ok: m.volCoolingAfterSurge });
        items.push({ label: "5일·20일선 지지권", ok: m.price >= m.ma5 * 0.96 && m.price >= m.ma20 * 0.94 });
        items.push({ label: "재추격 구간 아님", ok: m.changeRate <= 6 });
      }

      return items;
    }

    function getSupplyContinuity(m) {
      const details = [];
      if (m.volBuild3) details.push("3일 연속 거래량 증가");
      if (m.volRel5_20 >= 1) details.push("5일 평균 거래량 회복");
      if (m.volumeRecoveryDays >= 3) {
        details.push(`최근 5일 중 ${m.volumeRecoveryDays}일 거래량 우위`);
      }
      if (m.programFlow?.threeDayPositive) {
        details.push("프로그램 3일 연속 순매수");
      } else if (m.programFlow?.positiveDays >= 3) {
        details.push(m.programFlow.detail);
      }
      if (!details.length) details.push("오늘 거래량 중심, 지속성 추가 확인");

      return {
        label:
          m.programFlow?.threeDayPositive
            ? "프로그램 지속"
            : m.volBuild3 || m.volumeRecoveryDays >= 3
            ? "수급 지속"
            : m.volRel5_20 >= 1
            ? "수급 회복"
            : "수급 관찰",
        detail: details.slice(0, 3).join(" · ")
      };
    }

    function addMarketStats(m) {
      stats.validCharts += 1;
      const avoidanceSignals = buildAvoidanceSignals(m);
      if (avoidanceSignals.length) stats.avoidanceSignalCount += 1;
      if (m.changeRate > 0) stats.rising += 1;
      if (m.price >= m.ma20) stats.aboveMa20 += 1;
      if (m.price >= m.ma20 && m.prevClose < m.ma20) stats.recoveredMa20 += 1;
      if (m.volRelToday20 >= 1.4 || m.volRel5_20 >= 1.1) {
        stats.volumeIncreasing += 1;
      }
      if (
        m.distLow20 <= 8 &&
        m.volRel5_20 >= 0.85 &&
        m.price >= m.low20 * 1.01
      ) {
        stats.bottomCandidates += 1;
      }
      if (
        m.price > m.ma20 &&
        m.ma20 > m.ma60 &&
        m.pullbackFromHigh20 >= 4 &&
        m.pullbackFromHigh20 <= 18
      ) {
        stats.trendPullbackCandidates += 1;
      }
      if (
        m.changeRate <= -5 ||
        m.price < m.ma20 * 0.97 ||
        (m.changeRate < 0 && m.volRelToday20 >= 2.3 && m.price < m.open)
      ) {
        stats.sharpDrop += 1;
        stats.riskCandidates += 1;
      }
      if (m.changeRate >= 8 || m.threeDayChange >= 15 || m.volRelToday20 >= 4) {
        stats.sharpSurge += 1;
        stats.chaseCandidates += 1;
      }
    }

    function buildMarketBoard() {
      const valid = Math.max(stats.validCharts, 1);
      const risingRate = (stats.rising / valid) * 100;
      const ma20Rate = (stats.aboveMa20 / valid) * 100;
      const riskRate = (stats.riskCandidates / valid) * 100;
      const chaseRate = (stats.chaseCandidates / valid) * 100;
      const opportunityCount =
        stats.bottomCandidates + stats.trendPullbackCandidates;

      let status = "관망 우세";
      let action = "신규 매수는 소액만";
      let tone = "WATCH";

      if (riskRate >= 22 || (risingRate < 38 && ma20Rate < 42)) {
        status = "위험 관리";
        action = "현금 비중 우선, 신규 진입 보류";
        tone = "RISK";
      } else if (chaseRate >= 18 && opportunityCount < stats.riskCandidates) {
        status = "추격 과열";
        action = "급등주는 제외하고 눌림만 관찰";
        tone = "CHASE";
      } else if (risingRate >= 52 && ma20Rate >= 48 && opportunityCount >= 8) {
        status = "수급 회복";
        action = "분할 관심 가능";
        tone = "ENTRY";
      }

      const caution =
        tone === "RISK"
          ? "20일선 이탈과 거래량 동반 음봉 증가"
          : tone === "CHASE"
          ? "급등 후 밀리는 종목은 추격 제외"
          : "거래량 없는 반등은 제외";

      return {
        status,
        action,
        caution,
        tone,
        capture: `바닥권 수급 후보 ${stats.bottomCandidates}개 / 추세 눌림 후보 ${stats.trendPullbackCandidates}개 / 회피 시그널 ${stats.avoidanceSignalCount}개`,
        scanned: stats.scanned,
        validCharts: stats.validCharts,
        risingRate: Number(risingRate.toFixed(1)),
        ma20Rate: Number(ma20Rate.toFixed(1)),
        riskCount: stats.riskCandidates,
        chaseCount: stats.chaseCandidates,
        avoidanceSignalCount: stats.avoidanceSignalCount,
        volumeIncreasing: stats.volumeIncreasing,
        recoveredMa20: stats.recoveredMa20
      };
    }

    async function scanStock(item, index = 0) {
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
        const volumeRecoveryDays = recent5.filter(
          (d) => avgVol20 > 0 && d.volume >= avgVol20
        ).length;
        const volBuild3 =
          recent3.length === 3 &&
          recent3[0].volume >= recent3[1].volume &&
          recent3[1].volume >= recent3[2].volume;

        const ma20Slope = ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0;
        const intradayRebound = low > 0 ? ((price - low) / low) * 100 : 0;

        const threeDayChange =
          daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0;
        const prevClose = daily[1]?.close || 0;
        const todayCandle = { open, high, low, close: price };
        const upperWickRatio = getUpperWickRatio(todayCandle);
        const recentUpperWickCount = recent5.filter(
          (d) => getUpperWickRatio(d) >= 0.4
        ).length;
        const recentBoxLow = recent10.length > 1
          ? Math.min(...recent10.slice(1).map((d) => d.low))
          : low20;

        const baseMetrics = {
          price,
          open,
          high,
          low,
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
          volumeRecoveryDays,
          volBuild3,
          intradayRebound,
          pullbackFromHigh20,
          upperWickRatio,
          recentUpperWickCount,
          recentBoxLow,
          hasBigCandle10: false,
          afterBigCandleHold: false,
          volCoolingAfterSurge: false,
          low20,
          high20,
          threeDayChange,
          prevClose
        };

        addMarketStats(baseMetrics);
        rememberAvoidanceStock(
          item,
          baseMetrics,
          buildAvoidanceSignals(baseMetrics)
        );

        // 극단 제외
        if (changeRate <= -7 || price < low20 * 0.94) {
          stats.excludedBreakdown += 1;
          rememberMissed(
            item,
            "위험 제외",
            `급락/저점 이탈 조건 · 등락률 ${changeRate.toFixed(2)}% · 20일 저점 +${distLow20.toFixed(1)}%`
          );
          return null;
        }
        if ((changeRate >= 12 || threeDayChange >= 25) && !isHealthyTrend(baseMetrics)) {
          stats.excludedExtremeSurge += 1;
          rememberMissed(
            item,
            "추격 제외",
            `단기 과열 조건 · 3일 ${threeDayChange.toFixed(1)}% · 거래량 ${volRelToday20.toFixed(2)}배`
          );
          return null;
        }
        if (todayVolume < 20000) {
          stats.excludedVolume += 1;
          rememberMissed(
            item,
            "거래량 제외",
            `오늘 거래량 ${todayVolume.toLocaleString()}주로 기준 미달`
          );
          return null;
        }

        const programRows =
          index < programTradeScanLimit
            ? await getProgramTradeDaily(item.code).catch(() => [])
            : [];
        const programFlow = analyzeProgramContinuity(programRows);

        const bigCandle = recent10.find((d) => {
          const body = d.close > 0 ? ((d.close - d.open) / d.close) * 100 : 0;
          return body >= 5 && d.volume >= avgVol20 * 1.5;
        });

        const hasBigCandle10 = !!bigCandle;
        const afterBigCandleHold = hasBigCandle10 && price >= low20 * 1.03;
        const volCoolingAfterSurge = hasBigCandle10 && volRelToday20 <= 2.5;

        const metrics = {
          ...baseMetrics,
          hasBigCandle10,
          afterBigCandleHold,
          volCoolingAfterSurge,
          programFlow
        };
        const avoidanceSignals = buildAvoidanceSignals(metrics);
        rememberAvoidanceStock(item, metrics, avoidanceSignals);

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
        const riskAvoidanceCount = avoidanceSignals.filter((x) => x.severity === "RISK").length;
        const chaseAvoidanceCount = avoidanceSignals.filter((x) => x.severity === "CHASE").length;
        if (riskAvoidanceCount) {
          finalScore -= riskAvoidanceCount * 12;
          penalties.push(...avoidanceSignals.filter((x) => x.severity === "RISK").map((x) => x.label));
        }
        if (chaseAvoidanceCount) {
          finalScore -= chaseAvoidanceCount * 8;
          penalties.push(...avoidanceSignals.filter((x) => x.severity === "CHASE").map((x) => x.label));
        }
        if (programFlow.threeDayPositive) {
          finalScore += 6;
        } else if (programFlow.positiveDays >= 3) {
          finalScore += 3;
        }
        if (sessionLabel.includes("NXT")) {
          finalScore += 3;
        }

        finalScore = Math.max(0, Math.min(finalScore, 100));
        const signal = classifySignal(metrics, finalScore, best.strategyCode);
        rememberAvoidanceStock(item, metrics, avoidanceSignals, finalScore);
        if (
          (signal.signalCode === "RISK" || signal.signalCode === "CHASE") &&
          !signalStocks.some((s) => s.code === item.code && s.signalCode === signal.signalCode)
        ) {
          signalStocks.push({
            name: item.name,
            code: item.code,
            market: item.market,
            price: price.toLocaleString(),
            change: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
            score: finalScore,
            signalType: signal.signalType,
            signalCode: signal.signalCode,
            signalSummary: signal.signalSummary,
            reason: signal.signalSummary,
            chart: `20일선 ${price >= ma20 ? "상회" : "이탈"} · 고점대비 -${pullbackFromHigh20.toFixed(1)}% · 거래량 ${volRelToday20.toFixed(2)}배`
          });
        }

        if (finalScore < 50) {
          stats.scoreMiss += 1;
          rememberMissed(
            item,
            "점수 미달",
            `${best.strategyType} ${finalScore}점 · ${best.reasons.slice(0, 3).join(" · ") || "핵심 조건 부족"}`
          );
          return null;
        }

        const g = grade(finalScore);
        const entryDecision = getEntryDecision(
          signal,
          metrics,
          finalScore,
          best.strategyCode
        );
        const positionLabel = getPositionLabel(boxLower);
        const positionPercent = Math.max(0, Math.min(Math.round(boxLower * 100), 100));
        const supplyContinuity = getSupplyContinuity(metrics);
        stats.passed += 1;
        if (signal.signalCode === "ENTRY") stats.entrySignals += 1;
        if (signal.signalCode === "WATCH") stats.watchSignals += 1;

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
          signalType: signal.signalType,
          signalCode: signal.signalCode,
          signalSummary: signal.signalSummary,
          avoidanceSignals,
          entryLabel: entryDecision.entryLabel,
          entryCode: entryDecision.entryCode,
          entryGuide: entryDecision.entryGuide,

          strategyType: best.strategyType,
          strategyCode: best.strategyCode,
          sectorRank: best.strategyType,

          programBuy: `${sessionLabel} / ${best.strategyType}`,
          bigTrade:
            volBuild3 || volRel5_20 >= 1
              ? "거래량 회복 포착"
              : "거래량 관찰",
          bigTradeAmount: `오늘/20일 ${volRelToday20.toFixed(2)}배 · 5일/20일 ${volRel5_20.toFixed(2)}배`,
          supplyContinuity: supplyContinuity.label,
          supplyContinuityDetail: supplyContinuity.detail,
          programFlow,
          supply: programFlow.available
            ? `${programFlow.label} · ${programFlow.detail}`
            : "외국인·기관 수급 API 추가 연결 예정",
          volume: `오늘 ${todayVolume.toLocaleString()}주`,

          chart: `20일저점 +${distLow20.toFixed(1)}% · 고점대비 -${pullbackFromHigh20.toFixed(1)}% · 박스위치 ${(boxLower * 100).toFixed(0)}%`,
          positionLabel,
          positionPercent,
          positionBar: makePositionBar(boxLower),

          reason: [...best.reasons, ...penalties].slice(0, 7).join(" · "),
          reasonChecklist: buildReasonChecklist(best, metrics),

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

    async function analyzeMissedCode(code, targetDate = endDate) {
      const item =
        universe.find((x) => x.code === code) || {
          code,
          name: code,
          market: "직접입력"
        };
      const dailyRaw = await getDailyChart(code, marketDataCode, targetDate);
      const daily = dailyRaw
        .map((d) => ({
          close: Number(d.stck_clpr || 0),
          open: Number(d.stck_oprc || 0),
          high: Number(d.stck_hgpr || 0),
          low: Number(d.stck_lwpr || 0),
          volume: Number(d.acml_vol || 0),
          date: d.stck_bsop_date || d.bsop_date || ""
        }))
        .filter((d) => d.close > 0)
        .slice(0, 80);

      if (daily.length < 60) {
        return {
          name: item.name,
          code,
          market: item.market,
          date: targetDate,
          verdict: "분석 불가",
          detail: "일봉 데이터가 60개 미만이라 조건을 계산할 수 없습니다.",
          checks: []
        };
      }

      const today = daily[0];
      const recent3 = daily.slice(0, 3);
      const recent5 = daily.slice(0, 5);
      const recent10 = daily.slice(0, 10);
      const recent20 = daily.slice(0, 20);
      const recent40 = daily.slice(0, 40);
      const recent60 = daily.slice(0, 60);

      const price = today.close;
      const open = today.open;
      const low = today.low;
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
      const prevClose = daily[1]?.close || 0;
      const changeRate = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      const threeDayChange =
        daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0;
      const distLow20 = low20 > 0 ? ((price - low20) / low20) * 100 : 999;
      const distLow60 = low60 > 0 ? ((price - low60) / low60) * 100 : 999;
      const range40 = low40 > 0 ? ((high40 - low40) / low40) * 100 : 999;
      const boxLower = high40 > low40 ? (price - low40) / (high40 - low40) : 1;
      const pullbackFromHigh20 =
        high20 > 0 ? ((high20 - price) / high20) * 100 : 0;
      const volRel5_20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
      const volRelToday20 = avgVol20 > 0 ? today.volume / avgVol20 : 1;
      const volumeRecoveryDays = recent5.filter(
        (d) => avgVol20 > 0 && d.volume >= avgVol20
      ).length;
      const volBuild3 =
        recent3.length === 3 &&
        recent3[0].volume >= recent3[1].volume &&
        recent3[1].volume >= recent3[2].volume;
      const ma20Slope = ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0;
      const intradayRebound = low > 0 ? ((price - low) / low) * 100 : 0;
      const upperWickRatio = getUpperWickRatio(today);
      const recentUpperWickCount = recent5.filter(
        (d) => getUpperWickRatio(d) >= 0.4
      ).length;
      const recentBoxLow = recent10.length > 1
        ? Math.min(...recent10.slice(1).map((d) => d.low))
        : low20;
      const bigCandle = recent10.find((d) => {
        const body = d.close > 0 ? ((d.close - d.open) / d.close) * 100 : 0;
        return body >= 5 && d.volume >= avgVol20 * 1.5;
      });
      const programFlow = analyzeProgramContinuity(
        await getProgramTradeDaily(code, marketDataCode, targetDate).catch(() => [])
      );

      const metrics = {
        price,
        open,
        high: today.high,
        low,
        changeRate,
        todayVolume: today.volume,
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
        volumeRecoveryDays,
        volBuild3,
        intradayRebound,
        pullbackFromHigh20,
        upperWickRatio,
        recentUpperWickCount,
        recentBoxLow,
        hasBigCandle10: !!bigCandle,
        afterBigCandleHold: !!bigCandle && price >= low20 * 1.03,
        volCoolingAfterSurge: !!bigCandle && volRelToday20 <= 2.5,
        low20,
        high20,
        threeDayChange,
        prevClose,
        programFlow
      };

      const strategyScores = evaluateStrategies(metrics);
      const best = strategyScores[0];
      const avoidanceSignals = buildAvoidanceSignals(metrics);
      let finalScore = best.score;
      const failed = [];

      if (changeRate <= -7 || price < low20 * 0.94) {
        failed.push("급락/저점 이탈");
      }
      failed.push(
        ...avoidanceSignals
          .filter((x) => x.severity !== "WATCH")
          .map((x) => x.label)
      );
      if ((changeRate >= 12 || threeDayChange >= 25) && !isHealthyTrend(metrics)) {
        failed.push("단기 과열 추격 제외");
      }
      if (today.volume < 20000) failed.push("거래량 기준 미달");
      if (finalScore < 50) failed.push(`${best.strategyType} 점수 미달`);

      if (changeRate >= 8) finalScore -= 12;
      if (threeDayChange >= 15) finalScore -= 10;
      if (volRelToday20 > 4) finalScore -= 10;
      finalScore -= avoidanceSignals.filter((x) => x.severity === "RISK").length * 12;
      finalScore -= avoidanceSignals.filter((x) => x.severity === "CHASE").length * 8;
      if (programFlow.threeDayPositive) finalScore += 6;
      else if (programFlow.positiveDays >= 3) finalScore += 3;
      finalScore = Math.max(0, Math.min(finalScore, 100));

      const signal = classifySignal(metrics, finalScore, best.strategyCode);
      const entryDecision = getEntryDecision(
        signal,
        metrics,
        finalScore,
        best.strategyCode
      );

      return {
        name: item.name,
        code,
        market: item.market,
        date: today.date || targetDate,
        verdict: failed.length ? "탈락/관찰 사유 있음" : "조건 통과 가능",
        detail: failed.length
          ? failed.join(" · ")
          : `${best.strategyType} ${finalScore}점 · ${entryDecision.entryLabel}`,
        score: finalScore,
        strategyType: best.strategyType,
        signalType: signal.signalType,
        entryLabel: entryDecision.entryLabel,
        avoidanceSignals,
        programFlow,
        positionLabel: getPositionLabel(boxLower),
        positionPercent: Math.max(0, Math.min(Math.round(boxLower * 100), 100)),
        checks: buildReasonChecklist(best, metrics)
      };
    }

    const analyzeCode = String(req.query?.analyzeCode || "").trim();
    if (analyzeCode) {
      const analyzeDate = String(req.query?.date || endDate)
        .replace(/\D/g, "")
        .slice(0, 8);
      return res.status(200).json({
        success: true,
        analysis: await analyzeMissedCode(analyzeCode, analyzeDate || endDate),
        updatedAt: new Date().toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul"
        })
      });
    }

    const scannedStocks = await mapWithConcurrency(
      universe,
      scanConcurrency,
      scanStock
    );
    stocks.push(...scannedStocks.filter(Boolean));

    stocks.sort((a, b) => b.score - a.score);
    signalStocks.sort((a, b) => {
      const weight = { RISK: 2, CHASE: 1 };
      return (weight[b.signalCode] || 0) - (weight[a.signalCode] || 0) || b.score - a.score;
    });
    avoidanceStocks.sort((a, b) => {
      const weight = { 위험: 2, 추격주의: 1 };
      return (weight[b.avoidanceType] || 0) - (weight[a.avoidanceType] || 0) || b.score - a.score;
    });

    const payload = {
      success: true,
      mode: "3전략 통합 수급 스윙 스캐너",
      session: sessionLabel,
      scanScope,
      scanned: stats.scanned,
      stats,
      marketBoard: buildMarketBoard(),
      updatedAt: new Date().toLocaleString("ko-KR", {
        timeZone: "Asia/Seoul"
      }),
      stocks: stocks.slice(0, 40),
      signalStocks: signalStocks.slice(0, 30),
      avoidanceStocks: avoidanceStocks.slice(0, 40),
      missedStocks: missedStocks.slice(0, 30),
      sectors: []
    };

    runtimeCache.scan = {
      key: scanCacheKey,
      savedAt: Date.now(),
      payload
    };

    return res.status(200).json({
      ...payload,
      cache: {
        status: "refreshed",
        ageSeconds: 0,
        ttlSeconds: scanCacheTtlSeconds
      }
    });
  } catch (error) {
    const now = Date.now();
    if (
      runtimeCache.scan?.payload &&
      now - runtimeCache.scan.savedAt < 3600 * 1000
    ) {
      return res.status(200).json({
        ...runtimeCache.scan.payload,
        cache: {
          status: "stale",
          ageSeconds: Math.round((now - runtimeCache.scan.savedAt) / 1000),
          ttlSeconds: Math.max(
            180,
            Math.min(Number(process.env.SCAN_STALE_TTL_SECONDS ?? 900), 3600)
          ),
          warning: `최신 스캔 실패로 최근 성공 데이터를 표시합니다: ${error.message}`
        }
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
