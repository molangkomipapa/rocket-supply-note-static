const runtimeCache = globalThis.__rocketSupplyRuntimeCache || {
  token: null,
  scan: null,
  scanPromise: null,
  masterRanks: null
};
globalThis.__rocketSupplyRuntimeCache = runtimeCache;

const CATEGORY_LIMITS = {
  capture: 15,
  dayTrade: 10,
  supply: 15,
  avoidance: 15
};
const MIN_DAILY_COUNT = 60;

export default async function handler(req, res) {
  let staleTtlSeconds = 900;
  try {
    const baseUrl =
      process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";
    const requestStartedAt = Date.now();
    const forceRefresh = req.query?.refresh === "1";
    const analyzeCode = String(req.query?.analyzeCode || "").trim();
    const scanCacheTtlSeconds = clampNumber(
      Number(process.env.SCAN_CACHE_TTL_SECONDS ?? 180),
      15,
      900,
      180
    );
    staleTtlSeconds = clampNumber(
      Number(process.env.SCAN_STALE_TTL_SECONDS ?? 900),
      scanCacheTtlSeconds,
      3600,
      900
    );
    const scanConcurrency = clampNumber(
      Number(process.env.SCAN_CONCURRENCY || 4),
      1,
      8,
      4
    );
    const marketTopPercent = clampNumber(
      Number(process.env.SCAN_MARKET_TOP_PERCENT || 50),
      1,
      100,
      50
    );
    const estimatedKospiTotal = positiveNumber(
      process.env.KOSPI_LISTED_TOTAL,
      950
    );
    const estimatedKosdaqTotal = positiveNumber(
      process.env.KOSDAQ_LISTED_TOTAL,
      1800
    );
    const kospiScanCount = Math.ceil(
      estimatedKospiTotal * (marketTopPercent / 100)
    );
    const kosdaqScanCount = Math.ceil(
      estimatedKosdaqTotal * (marketTopPercent / 100)
    );
    const marketDataCode = normalizeMarketDataCode(
      process.env.KIS_MARKET_DATA_CODE || "UN"
    );
    const programTradeScanLimit = clampNumber(
      Number(process.env.PROGRAM_TRADE_SCAN_LIMIT ?? 80),
      0,
      400,
      80
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
      !analyzeCode &&
      !forceRefresh &&
      runtimeCache.scan?.key === scanCacheKey &&
      requestStartedAt - runtimeCache.scan.savedAt < scanCacheTtlSeconds * 1000
    ) {
      return res.status(200).json({
        ...runtimeCache.scan.payload,
        cache: makeCacheInfo("fresh", requestStartedAt, scanCacheTtlSeconds)
      });
    }

    const accessToken = await getAccessToken(baseUrl, requestStartedAt);
    const headers = {
      authorization: `Bearer ${accessToken}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      "content-type": "application/json; charset=utf-8"
    };

    async function kisGet(path, trId, params) {
      const url = new URL(`${baseUrl}${path}`);
      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      });

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { ...headers, tr_id: trId }
      });
      return response.json();
    }

    async function getAccessToken(base, now) {
      const cached = runtimeCache.token;
      if (cached?.accessToken && cached.expiresAt > now + 60000) {
        return cached.accessToken;
      }

      const tokenRes = await fetch(`${base}/oauth2/tokenP`, {
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
        throw new Error(
          `한국투자증권 토큰 발급 실패: ${JSON.stringify(tokenData)}`
        );
      }

      runtimeCache.token = {
        accessToken: tokenData.access_token,
        expiresAt:
          now + Math.max(Number(tokenData.expires_in || 82800), 3600) * 1000
      };
      return tokenData.access_token;
    }

    async function getMarketCapRank(market, count) {
      const apiList = await getMarketCapRankFromApi(market, count).catch(
        () => []
      );
      if (apiList.length >= count) return apiList.slice(0, count);

      const masterList = await getMarketCapRankFromMaster(market, count).catch(
        () => []
      );
      const merged = uniqueStocks([...apiList, ...masterList]).slice(0, count);
      return merged.length ? merged : apiList;
    }

    async function getMarketCapRankFromApi(market, count) {
      const marketCode = market === "KOSDAQ" ? "1001" : "0001";
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
          market
        }))
        .filter((x) => x.code && x.name)
        .slice(0, count);
    }

    async function getMarketCapRankFromMaster(market, count) {
      const cacheTtl = 12 * 60 * 60 * 1000;
      const cached = runtimeCache.masterRanks?.[market];
      if (cached && Date.now() - cached.savedAt < cacheTtl) {
        return cached.list.slice(0, count);
      }

      const config =
        market === "KOSDAQ"
          ? {
              url: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
              tailSize: 222,
              market
            }
          : {
              url: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
              tailSize: 228,
              market
            };
      const list = await fetchMarketMasterRank(config);
      runtimeCache.masterRanks = {
        ...(runtimeCache.masterRanks || {}),
        [market]: {
          savedAt: Date.now(),
          list
        }
      };
      return list.slice(0, count);
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

    async function getDailyChart(code, marketCode = marketDataCode) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
        "FHKST03010100",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: code,
          fid_input_date_1: "20240101",
          fid_input_date_2: todayYmd(),
          fid_period_div_code: "D",
          fid_org_adj_prc: "0"
        }
      );
      const output = data.output2 || [];
      if (output.length || marketCode === "J") return output;
      return getDailyChart(code, "J");
    }

    async function getProgramTradeDaily(code, marketCode = marketDataCode) {
      const data = await kisGet(
        "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
        "FHPPG04650201",
        {
          fid_cond_mrkt_div_code: marketCode,
          fid_input_iscd: code,
          fid_input_date_1: ""
        }
      );
      const output = data.output || data.output1 || data.output2 || [];
      if (output.length || marketCode === "J") return output;
      return getProgramTradeDaily(code, "J");
    }

    async function analyzeStock(item, options = {}) {
      const [priceData, dailyRaw] = await Promise.all([
        getPrice(item.code),
        getDailyChart(item.code)
      ]);

      if (!priceData) {
        return {
          item,
          ok: false,
          rejectReason: "가격 데이터 없음",
          rejectDetail: "현재가 API 응답이 없어 분석하지 못했습니다."
        };
      }

      const daily = normalizeDaily(dailyRaw);
      if (daily.length < MIN_DAILY_COUNT) {
        return {
          item,
          ok: false,
          rejectReason: "일봉 부족",
          rejectDetail: `일봉 ${daily.length}개라 60일선 기준을 계산하지 못했습니다.`
        };
      }

      const programRows = options.withProgram
        ? await getProgramTradeDaily(item.code).catch(() => [])
        : [];
      const metrics = buildMetrics(priceData, daily, programRows);
      const scores = {
        capture: scoreCapture(metrics),
        dayTrade: scoreDayTrade(metrics),
        supply: scoreSupply(metrics),
        avoidance: scoreAvoidance(metrics)
      };

      return {
        item,
        ok: true,
        metrics,
        scores,
        cards: {
          capture: makeCard(item, metrics, scores.capture),
          dayTrade: makeCard(item, metrics, scores.dayTrade),
          supply: makeCard(item, metrics, scores.supply),
          avoidance: makeCard(item, metrics, scores.avoidance)
        }
      };
    }

    if (analyzeCode) {
      const result = await analyzeStock({
        code: analyzeCode,
        name: analyzeCode,
        market: "직접입력"
      }, { withProgram: true });

      return res.status(200).json({
        success: true,
        analysis: makeIndividualAnalysis(result),
        updatedAt: nowKst()
      });
    }

    if (
      !forceRefresh &&
      runtimeCache.scanPromise?.key === scanCacheKey &&
      runtimeCache.scanPromise.promise
    ) {
      const payload = await runtimeCache.scanPromise.promise;
      return res.status(200).json({
        ...payload,
        cache: makeCacheInfo("shared-refresh", Date.now(), scanCacheTtlSeconds)
      });
    }

    const scanPromise = (async () => {
      const [kospiResult, kosdaqResult] = await Promise.allSettled([
        getMarketCapRank("KOSPI", kospiScanCount),
        getMarketCapRank("KOSDAQ", kosdaqScanCount)
      ]);
      const kospi = kospiResult.status === "fulfilled" ? kospiResult.value : [];
      const kosdaq =
        kosdaqResult.status === "fulfilled" ? kosdaqResult.value : [];
      const universe = [...kospi, ...kosdaq];

      const stats = {
        scanned: 0,
        analyzed: 0,
        rejected: 0,
        rejection: {},
        validCharts: 0
      };
      const categories = {
        capture: [],
        dayTrade: [],
        supply: [],
        avoidance: []
      };

      const results = await mapWithConcurrency(
        universe,
        scanConcurrency,
        async (item, index) => {
          stats.scanned += 1;
          return analyzeStock(item, {
            withProgram: index < programTradeScanLimit
          }).catch((error) => ({
            item,
            ok: false,
            rejectReason: "스캔 오류",
            rejectDetail: error.message
          }));
        }
      );

      results.forEach((result) => {
        if (!result?.ok) {
          stats.rejected += 1;
          const reason = result?.rejectReason || "분석 실패";
          stats.rejection[reason] = (stats.rejection[reason] || 0) + 1;
          return;
        }

        stats.analyzed += 1;
        stats.validCharts += 1;
        pushIfVisible(categories.capture, result.cards.capture);
        pushIfVisible(categories.dayTrade, result.cards.dayTrade);
        pushIfVisible(categories.supply, result.cards.supply);
        pushIfVisible(categories.avoidance, result.cards.avoidance);
      });

      Object.values(categories).forEach((list) => {
        list.sort((a, b) => b.score - a.score);
      });
      const totalMatches = {
        capture: categories.capture.length,
        dayTrade: categories.dayTrade.length,
        supply: categories.supply.length,
        avoidance: categories.avoidance.length
      };
      const visibleCategories = {
        capture: categories.capture.slice(0, CATEGORY_LIMITS.capture),
        dayTrade: categories.dayTrade.slice(0, CATEGORY_LIMITS.dayTrade),
        supply: categories.supply.slice(0, CATEGORY_LIMITS.supply),
        avoidance: categories.avoidance.slice(0, CATEGORY_LIMITS.avoidance)
      };

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
        totalActualCount: universe.length
      };

      const payload = {
        success: true,
        mode: "4분류 점수형 종목 판단",
        updatedAt: nowKst(),
        scanScope,
        stats,
        summary: {
          capture: visibleCategories.capture.length,
          dayTrade: visibleCategories.dayTrade.length,
          supply: visibleCategories.supply.length,
          avoidance: visibleCategories.avoidance.length
        },
        totalMatches,
        displayLimits: CATEGORY_LIMITS,
        stocks: visibleCategories.capture,
        dayTradeStocks: visibleCategories.dayTrade,
        supplyStocks: visibleCategories.supply,
        avoidanceStocks: visibleCategories.avoidance
      };

      runtimeCache.scan = {
        key: scanCacheKey,
        savedAt: Date.now(),
        payload
      };
      return payload;
    })();

    runtimeCache.scanPromise = {
      key: scanCacheKey,
      promise: scanPromise
    };

    const payload = await scanPromise.finally(() => {
      if (runtimeCache.scanPromise?.promise === scanPromise) {
        runtimeCache.scanPromise = null;
      }
    });

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
      now - runtimeCache.scan.savedAt < staleTtlSeconds * 1000
    ) {
      return res.status(200).json({
        ...runtimeCache.scan.payload,
        cache: {
          status: "stale",
          ageSeconds: Math.round((now - runtimeCache.scan.savedAt) / 1000),
          ttlSeconds: staleTtlSeconds,
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

function scoreCapture(m) {
  const trendOk = m.ma20 > m.ma60 || m.price > m.ma60;
  const pullbackOk = m.pullbackFromHigh20 >= 3 && m.pullbackFromHigh20 <= 15;
  const lowHoldOk =
    m.price >= m.recentLow10 * 0.995 || m.price >= m.ma20 * 0.98;
  const volumeRebuildOk =
    m.todayVolume > m.prevVolume ||
    m.volumeRecoveryDays >= 2 ||
    m.volRelToday20 >= m.volRel5_20 * 1.1;
  const restartOk =
    m.todayVolume > m.prevVolume ||
    m.price > m.open ||
    m.price >= m.prevClose ||
    m.price >= m.ma5;
  const compressionOk =
    (m.avgRange3 <= m.avgRange5 * 0.9 || m.range5 <= m.range10 * 0.85) &&
    m.volRel5_20 >= 0.5 &&
    m.volRel5_20 <= 1.2;
  const chaseRisk =
    m.changeRate >= 8 ||
    m.threeDayChange >= 15 ||
    m.volRelToday20 >= 4 ||
    m.longBearCandle;
  const checks = [
    {
      label: "저점 유지",
      ok: lowHoldOk,
      points: 25
    },
    {
      label: "거래량 재증가",
      ok: volumeRebuildOk,
      points: 20
    },
    {
      label: "재출발 신호",
      ok: restartOk,
      points: 20
    },
    {
      label: "압축 구조",
      ok: compressionOk,
      points: 15
    },
    {
      label: "눌림 위치",
      ok: pullbackOk,
      points: 10
    },
    {
      label: "추세 유지",
      ok: trendOk,
      points: 10
    }
  ];

  const score = makeScore("포착", "capture", checks, [
    "매수후보",
    "분할관심",
    "관찰후보",
    "제외"
  ]);

  if (chaseRisk) {
    score.score = Math.max(0, score.score - 35);
    score.failed.push("추격 제외 조건");
    score.checks.push({
      label: "추격 위험 감점",
      ok: false,
      points: -35
    });
    score.status = getGrade(score.score, [
      "매수후보",
      "분할관심",
      "관찰후보",
      "제외"
    ]);
  }

  return score;
}

function scoreDayTrade(m) {
  const risk =
    m.upperWickRatio > 0.45 ||
    (m.volRelToday20 >= 5 && m.price < m.open) ||
    m.longBearCandle ||
    m.price < m.open * 0.995;
  const checks = [
    {
      label: "거래량 20일 평균 2~5배",
      ok: m.volRelToday20 >= 2 && m.volRelToday20 <= 5,
      points: 30
    },
    { label: "시가 유지/회복", ok: m.price >= m.open, points: 20 },
    {
      label: "장중 저점 회복",
      ok: m.intradayRebound >= 1.5 || m.price >= m.prevClose,
      points: 20
    },
    {
      label: "체결강도 추정",
      ok: m.price >= m.open && m.todayVolume > m.prevVolume,
      points: 15
    },
    {
      label: "고점 대비 밀림 작음",
      ok: m.pullbackFromTodayHigh <= 3,
      points: 10
    },
    {
      label: "섹터 동반 상승 추정",
      ok: m.price > m.ma20 && m.ma20 >= m.ma60 * 0.98,
      points: 5
    }
  ];
  const score = makeScore("당일급등", "dayTrade", checks, [
    "당일 단타 핵심",
    "단타 관심",
    "관찰",
    "제외"
  ]);

  if (risk) {
    score.score = Math.max(0, score.score - 25);
    score.failed.push("위험 제외 조건");
    score.checks.push({
      label: "윗꼬리/시가 이탈/장대음봉 위험",
      ok: false,
      points: -25
    });
    score.status = getGrade(score.score, [
      "당일 단타 핵심",
      "단타 관심",
      "관찰",
      "제외"
    ]);
  }

  return score;
}

function scoreSupply(m) {
  const overheated =
    m.threeDayChange >= 20 ||
    (m.volRelToday20 >= 4 && m.upperWickRatio > 0.35) ||
    m.longBearCandle;
  const checks = [
    {
      label: "최근 누적 순매수",
      ok: m.programFlow.threeDayPositive || m.programFlow.positiveDays >= 3,
      points: 35
    },
    {
      label: "주가 유지력",
      ok: m.price >= m.ma20 * 0.98 && m.recentLow10 >= m.low20 * 0.98,
      points: 20
    },
    {
      label: "거래량 증가 지속성",
      ok: m.volBuild3 || m.volumeRecoveryDays >= 3 || m.volRel5_20 >= 1,
      points: 15
    },
    {
      label: "이평선 회복",
      ok: m.price >= m.ma20 || (m.ma20 > m.ma60 && m.ma20Slope > -0.3),
      points: 15
    },
    {
      label: "눌림 후 회복력",
      ok: m.intradayRebound >= 1 || m.price >= m.open || m.price >= m.prevClose,
      points: 10
    },
    {
      label: "섹터 동반 흐름 추정",
      ok: m.price > m.ma60 && m.ma20Slope > -0.5,
      points: 5
    }
  ];
  const score = makeScore("외국기관수급", "supply", checks, [
    "강한 수급 관심",
    "수급 유입 진행",
    "관찰",
    "제외"
  ]);

  if (overheated) {
    score.score = Math.max(0, score.score - 20);
    score.failed.push("과열 제외 조건");
    score.checks.push({ label: "최근 과열/윗꼬리/장대음봉", ok: false, points: -20 });
    score.status = getGrade(score.score, [
      "강한 수급 관심",
      "수급 유입 진행",
      "관찰",
      "제외"
    ]);
  }

  return score;
}

function scoreAvoidance(m) {
  const checks = [
    {
      label: "20일선 이탈 + 회복 실패",
      ok: m.prevClose < m.ma20 && m.price < m.ma20 * 0.99,
      points: 25
    },
    {
      label: "거래량 증가 음봉",
      ok: m.price < m.open && m.volRelToday20 >= 1.5 && m.changeRate < 0,
      points: 25
    },
    {
      label: "반등 실패 반복",
      ok: m.recentUpperWickCount >= 3,
      points: 15
    },
    {
      label: "고점 대비 급락 시작",
      ok:
        m.pullbackFromHigh20 >= 12 ||
        (m.prevClose >= m.high20 * 0.95 && m.changeRate <= -5),
      points: 15
    },
    { label: "장대음봉", ok: m.longBearCandle, points: 10 },
    {
      label: "외국인/기관 수급 이탈 추정",
      ok: m.programFlow.available && m.programFlow.positiveDays === 0 && m.programFlow.totalNet < 0,
      points: 5
    },
    {
      label: "섹터 약화 추정",
      ok: m.price < m.ma60 || (m.ma20Slope < -0.5 && m.price < m.ma20),
      points: 5
    }
  ];

  return makeScore("회피", "avoidance", checks, [
    "회피 강력 경고",
    "분할매도 고려",
    "주의 관찰",
    "정상"
  ]);
}

function makeScore(category, code, checks, labels) {
  const passed = checks.filter((x) => x.ok);
  const failed = checks.filter((x) => !x.ok).map((x) => x.label);
  const score = Math.min(
    100,
    passed.reduce((sum, x) => sum + Math.max(0, x.points), 0)
  );

  return {
    category,
    code,
    score,
    status: getGrade(score, labels),
    passed: passed.map((x) => x.label),
    failed,
    checks
  };
}

function makeCard(item, m, scoreInfo) {
  return {
    name: item.name,
    code: item.code,
    market: item.market,
    category: scoreInfo.category,
    categoryCode: scoreInfo.code,
    score: scoreInfo.score,
    status: scoreInfo.status,
    price: m.price.toLocaleString(),
    change: `${m.changeRate > 0 ? "+" : ""}${m.changeRate.toFixed(2)}%`,
    reason: scoreInfo.passed.join(" · ") || "통과 조건 없음",
    failed: scoreInfo.failed,
    checks: scoreInfo.checks,
    metrics: makeMetricSummary(m),
    visible: scoreInfo.score >= 50
  };
}

function makeIndividualAnalysis(result) {
  if (!result?.ok) {
    return {
      ok: false,
      name: result?.item?.name || "",
      code: result?.item?.code || "",
      market: result?.item?.market || "직접입력",
      rejectReason: result?.rejectReason || "분석 실패",
      rejectDetail: result?.rejectDetail || "분석하지 못했습니다."
    };
  }

  return {
    ok: true,
    name: result.item.name,
    code: result.item.code,
    market: result.item.market,
    price: result.metrics.price.toLocaleString(),
    change: `${result.metrics.changeRate > 0 ? "+" : ""}${result.metrics.changeRate.toFixed(2)}%`,
    metrics: makeMetricSummary(result.metrics),
    categories: [
      result.cards.capture,
      result.cards.dayTrade,
      result.cards.supply,
      result.cards.avoidance
    ]
  };
}

function pushIfVisible(list, card) {
  if (card.visible) list.push(card);
}

function uniqueStocks(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.code || seen.has(item.code)) return false;
    seen.add(item.code);
    return true;
  });
}

async function fetchMarketMasterRank(config) {
  const response = await fetch(config.url);
  if (!response.ok) {
    throw new Error(`${config.market} 종목 마스터 다운로드 실패`);
  }

  const zipBytes = new Uint8Array(await response.arrayBuffer());
  const mstBytes = await extractFirstZipEntry(zipBytes);
  const decoder = makeKoreanDecoder();
  const rows = splitLines(mstBytes)
    .map((line) => parseMarketMasterLine(line, decoder, config))
    .filter(Boolean)
    .sort((a, b) => b.marketCap - a.marketCap);

  return rows.map(({ code, name, market }) => ({ code, name, market }));
}

async function extractFirstZipEntry(bytes) {
  const signature = readUint32LE(bytes, 0);
  if (signature !== 0x04034b50) {
    throw new Error("종목 마스터 ZIP 형식을 읽지 못했습니다.");
  }

  const method = readUint16LE(bytes, 8);
  const compressedSize = readUint32LE(bytes, 18);
  const fileNameLength = readUint16LE(bytes, 26);
  const extraLength = readUint16LE(bytes, 28);
  const start = 30 + fileNameLength + extraLength;
  const compressed = bytes.slice(start, start + compressedSize);

  if (method === 0) return compressed;
  if (method !== 8) {
    throw new Error(`지원하지 않는 ZIP 압축 방식입니다: ${method}`);
  }

  const { inflateRawSync } = await import("node:zlib");
  return new Uint8Array(inflateRawSync(compressed));
}

function parseMarketMasterLine(lineBytes, decoder, config) {
  if (!lineBytes.length) return null;

  const row = decoder.decode(lineBytes);
  if (row.length <= config.tailSize) return null;

  const head = row.slice(0, -config.tailSize);
  const tail = row.slice(-config.tailSize);
  const shortCode = head.slice(0, 9).trim();
  const code = /^\d{6}$/.test(shortCode) ? shortCode : "";
  const name = head.slice(21).trim();
  const groupCode = tail.slice(1, 3);
  const marketCap = toNumber(tail.slice(tail.length - 15, tail.length - 6));

  if (!code || !name || !["ST", "FS"].includes(groupCode) || marketCap <= 0) {
    return null;
  }
  return {
    code,
    name,
    market: config.market,
    marketCap
  };
}

function makeKoreanDecoder() {
  try {
    return new TextDecoder("euc-kr");
  } catch {
    return new TextDecoder("utf-8");
  }
}

function splitLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 10) {
      const end = bytes[index - 1] === 13 ? index - 1 : index;
      lines.push(bytes.slice(start, end));
      start = index + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.slice(start));
  return lines;
}

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function normalizeDaily(raw) {
  return (raw || [])
    .map((d) => ({
      close: toNumber(d.stck_clpr),
      open: toNumber(d.stck_oprc),
      high: toNumber(d.stck_hgpr),
      low: toNumber(d.stck_lwpr),
      volume: toNumber(d.acml_vol)
    }))
    .filter((d) => d.close > 0)
    .slice(0, 80);
}

function buildMetrics(priceData, daily, programRows) {
  const today = daily[0];
  const recent3 = daily.slice(0, 3);
  const recent5 = daily.slice(0, 5);
  const recent10 = daily.slice(0, 10);
  const recent20 = daily.slice(0, 20);
  const recent60 = daily.slice(0, 60);
  const price = toNumber(priceData.stck_prpr) || today.close;
  const open = toNumber(priceData.stck_oprc) || today.open;
  const high = toNumber(priceData.stck_hgpr) || today.high;
  const low = toNumber(priceData.stck_lwpr) || today.low;
  const todayVolume = toNumber(priceData.acml_vol) || today.volume;
  const prevClose = daily[1]?.close || 0;
  const prevVolume = daily[1]?.volume || 0;
  const ma5 = avg(recent5.map((d) => d.close));
  const ma20 = avg(recent20.map((d) => d.close));
  const ma60 = avg(recent60.map((d) => d.close));
  const ma20Prev5 = avg(daily.slice(5, 25).map((d) => d.close));
  const avgVol5 = avg(recent5.map((d) => d.volume));
  const avgVol20 = avg(recent20.map((d) => d.volume));
  const high20 = Math.max(...recent20.map((d) => d.high));
  const low20 = Math.min(...recent20.map((d) => d.low));
  const high5 = Math.max(...recent5.map((d) => d.high));
  const low5 = Math.min(...recent5.map((d) => d.low));
  const high10 = Math.max(...recent10.map((d) => d.high));
  const low10 = Math.min(...recent10.map((d) => d.low));
  const candleRange = (d) =>
    d.close > 0 ? ((d.high - d.low) / d.close) * 100 : 0;
  const bodyRate = price > 0 ? ((price - open) / price) * 100 : 0;

  return {
    price,
    open,
    high,
    low,
    todayVolume,
    prevVolume,
    prevClose,
    changeRate: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
    threeDayChange:
      daily[2]?.close > 0 ? ((price - daily[2].close) / daily[2].close) * 100 : 0,
    ma5,
    ma20,
    ma60,
    ma20Slope: ma20Prev5 > 0 ? ((ma20 - ma20Prev5) / ma20Prev5) * 100 : 0,
    low20,
    high20,
    recentLow10: recent10.length > 1
      ? Math.min(...recent10.slice(1).map((d) => d.low))
      : low20,
    range5: low5 > 0 ? ((high5 - low5) / low5) * 100 : 999,
    range10: low10 > 0 ? ((high10 - low10) / low10) * 100 : 999,
    avgRange3: avg(recent3.map(candleRange)),
    avgRange5: avg(recent5.map(candleRange)),
    volRel5_20: avgVol20 > 0 ? avgVol5 / avgVol20 : 1,
    volRelToday20: avgVol20 > 0 ? todayVolume / avgVol20 : 1,
    volumeRecoveryDays: recent5.filter((d) => avgVol20 > 0 && d.volume >= avgVol20).length,
    volBuild3:
      recent3.length === 3 &&
      recent3[0].volume >= recent3[1].volume &&
      recent3[1].volume >= recent3[2].volume,
    intradayRebound: low > 0 ? ((price - low) / low) * 100 : 0,
    pullbackFromHigh20: high20 > 0 ? ((high20 - price) / high20) * 100 : 0,
    pullbackFromTodayHigh: high > 0 ? ((high - price) / high) * 100 : 0,
    upperWickRatio: getUpperWickRatio({ open, high, low, close: price }),
    recentUpperWickCount: recent5.filter((d) => getUpperWickRatio(d) >= 0.4).length,
    bodyRate,
    longBearCandle:
      bodyRate <= -4 && todayVolume >= avgVol20 * 1.2 && price <= low * 1.03,
    programFlow: analyzeProgramContinuity(programRows)
  };
}

function makeMetricSummary(m) {
  return {
    price: m.price,
    changeRate: Number(m.changeRate.toFixed(2)),
    pullbackFromHigh20: Number(m.pullbackFromHigh20.toFixed(1)),
    pullbackFromTodayHigh: Number(m.pullbackFromTodayHigh.toFixed(1)),
    volRelToday20: Number(m.volRelToday20.toFixed(2)),
    volRel5_20: Number(m.volRel5_20.toFixed(2)),
    ma20Position: m.price >= m.ma20 ? "20일선 위" : "20일선 아래",
    trend: m.ma20 > m.ma60 ? "20일선 > 60일선" : "20일선 <= 60일선",
    program: m.programFlow.label,
    programDetail: m.programFlow.detail
  };
}

function analyzeProgramContinuity(rows) {
  const recent = (rows || []).slice(0, 5);
  const values = recent.map(getProgramNetValue);
  const positiveDays = values.filter((v) => v > 0).length;
  const threeDayPositive =
    values.slice(0, 3).length === 3 && values.slice(0, 3).every((v) => v > 0);
  const totalNet = values.reduce((sum, value) => sum + value, 0);

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
      : "외국인/기관 직접 수급 API 연결 전"
  };
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

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") {
      const number = toNumber(value);
      if (Number.isFinite(number)) return number;
    }
  }
  return 0;
}

function getUpperWickRatio(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  return (candle.high - Math.max(candle.close, candle.open)) / range;
}

function getGrade(score, labels) {
  if (score >= 80) return labels[0];
  if (score >= 65) return labels[1];
  if (score >= 50) return labels[2];
  return labels[3];
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

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toNumber(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(number, max));
}

function normalizeMarketDataCode(value) {
  const code = String(value || "UN").toUpperCase();
  return ["J", "NX", "UN"].includes(code) ? code : "UN";
}

function todayYmd() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("");
}

function nowKst() {
  return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

function makeCacheInfo(status, now, ttlSeconds) {
  return {
    status,
    ageSeconds: runtimeCache.scan?.savedAt
      ? Math.round((now - runtimeCache.scan.savedAt) / 1000)
      : 0,
    ttlSeconds
  };
}
