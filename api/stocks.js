import { createKisClient } from "./lib/kis.js";
import {
  MIN_DAILY_COUNT,
  buildMetrics,
  makeMetricSummary,
  normalizeDaily
} from "./lib/metrics.js";
import { scoreAvoidance } from "./lib/scoring/avoidance.js";
import { scoreCapture } from "./lib/scoring/capture.js";
import { scoreDayTrade } from "./lib/scoring/dayTrade.js";
import { scoreSupply } from "./lib/scoring/supply.js";

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
const MIN_TRADE_VALUE = {
  capture: 1000000000,
  dayTrade: 5000000000,
  supply: 1000000000,
  avoidance: 0
};

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

    const kis = createKisClient({
      baseUrl,
      marketDataCode,
      runtimeCache,
      appKey: process.env.KIS_APP_KEY,
      appSecret: process.env.KIS_APP_SECRET
    });

    async function analyzeStock(item, options = {}) {
      const stockMeta =
        item.market === "직접입력" && !item.sector
          ? await kis.getStockMeta(item.code)
          : null;
      const resolvedItem = {
        ...item,
        ...(stockMeta || {}),
        name:
          item.market === "직접입력"
            ? stockMeta?.name || item.name || item.code
            : item.name || stockMeta?.name || item.code,
        market: item.market === "직접입력" ? stockMeta?.market || item.market : item.market
      };
      const [priceData, dailyRaw] = await Promise.all([
        kis.getPrice(resolvedItem.code),
        kis.getDailyChart(resolvedItem.code)
      ]);

      if (!priceData) {
        return {
          item: resolvedItem,
          ok: false,
          rejectReason: "가격 데이터 없음",
          rejectDetail: "현재가 API 응답이 없어 분석하지 못했습니다."
        };
      }

      const daily = normalizeDaily(dailyRaw);
      if (daily.length < MIN_DAILY_COUNT) {
        return {
          item: resolvedItem,
          ok: false,
          rejectReason: "일봉 부족",
          rejectDetail: `일봉 ${daily.length}개라 60일선 기준을 계산하지 못했습니다.`
        };
      }

      const programRows = options.withProgram
        ? await kis.getProgramTradeDaily(resolvedItem.code).catch(() => [])
        : [];
      const metrics = buildMetrics(priceData, daily, programRows);
      const scores = {
        capture: scoreCapture(metrics),
        dayTrade: scoreDayTrade(metrics),
        supply: scoreSupply(metrics),
        avoidance: scoreAvoidance(metrics)
      };

      return {
        item: resolvedItem,
        ok: true,
        metrics,
        scores,
        cards: {
          capture: makeCard(resolvedItem, metrics, scores.capture, scores),
          dayTrade: makeCard(resolvedItem, metrics, scores.dayTrade, scores),
          supply: makeCard(resolvedItem, metrics, scores.supply, scores),
          avoidance: makeCard(resolvedItem, metrics, scores.avoidance, scores)
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
        kis.getMarketCapRank("KOSPI", kospiScanCount),
        kis.getMarketCapRank("KOSDAQ", kosdaqScanCount)
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
      const analyzedResults = [];

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
        analyzedResults.push(result);
        pushCandidate(categories.capture, result.cards.capture);
        pushCandidate(categories.dayTrade, result.cards.dayTrade);
        pushCandidate(categories.supply, result.cards.supply);
        pushCandidate(categories.avoidance, result.cards.avoidance);
      });

      const sectorBoard = buildSectorBoard(analyzedResults);
      applySectorPriority(categories, sectorBoard);
      Object.keys(categories).forEach((key) => {
        categories[key] = categories[key].filter((card) => card.visible);
      });
      Object.values(categories).forEach((list) => {
        list.sort((a, b) => b.priorityScore - a.priorityScore);
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

      const payload = {
        success: true,
        mode: "4분류 점수형 종목 판단",
        updatedAt: nowKst(),
        scanScope: makeScanScope({
          marketTopPercent,
          marketDataCode,
          estimatedKospiTotal,
          estimatedKosdaqTotal,
          kospiScanCount,
          kosdaqScanCount,
          kospi,
          kosdaq,
          universe
        }),
        stats,
        summary: {
          capture: visibleCategories.capture.length,
          dayTrade: visibleCategories.dayTrade.length,
          supply: visibleCategories.supply.length,
          avoidance: visibleCategories.avoidance.length
        },
        totalMatches,
        sectorBoard,
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

function makeScanScope({
  marketTopPercent,
  marketDataCode,
  estimatedKospiTotal,
  estimatedKosdaqTotal,
  kospiScanCount,
  kosdaqScanCount,
  kospi,
  kosdaq,
  universe
}) {
  return {
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
}

function makeCard(item, m, scoreInfo, allScores) {
  const riskPenalty =
    scoreInfo.code === "avoidance" ? 0 : Math.round(allScores.avoidance.score * 0.35);
  const liquidityBonus = getLiquidityBonus(m.tradeValue, scoreInfo.code);
  const tradeValueOk = m.tradeValue >= (MIN_TRADE_VALUE[scoreInfo.code] || 0);
  const priorityScore =
    scoreInfo.code === "avoidance"
      ? scoreInfo.score
      : clampNumber(scoreInfo.score - riskPenalty + liquidityBonus, 0, 100, 0);
  const finalStatus = getCategoryStatus(scoreInfo.code, priorityScore, scoreInfo.status);
  const failed = [...scoreInfo.failed];
  if (!tradeValueOk) failed.push("거래대금 기준 미달");

  return {
    name: item.name,
    code: item.code,
    market: item.market,
    sector: item.sector || "섹터 확인 대기",
    industryCode: item.industryCode || "",
    category: scoreInfo.category,
    categoryCode: scoreInfo.code,
    score: scoreInfo.score,
    rawScore: scoreInfo.score,
    priorityScore,
    riskPenalty,
    liquidityBonus,
    tradeValueOk,
    status: finalStatus,
    price: m.price.toLocaleString(),
    change: `${m.changeRate > 0 ? "+" : ""}${m.changeRate.toFixed(2)}%`,
    reason: buildReasonSummary(scoreInfo, riskPenalty, liquidityBonus),
    failed,
    checks: scoreInfo.checks,
    metrics: makeMetricSummary(m),
    visible: tradeValueOk && priorityScore >= 50
  };
}

function makeIndividualAnalysis(result) {
  if (!result?.ok) {
    return {
      ok: false,
      name: result?.item?.name || "",
      code: result?.item?.code || "",
      market: result?.item?.market || "직접입력",
      sector: result?.item?.sector || "섹터 확인 대기",
      rejectReason: result?.rejectReason || "분석 실패",
      rejectDetail: result?.rejectDetail || "분석하지 못했습니다."
    };
  }

  return {
    ok: true,
    name: result.item.name,
    code: result.item.code,
    market: result.item.market,
    sector: result.item.sector || "섹터 확인 대기",
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

function buildSectorBoard(results) {
  const sectors = new Map();
  results.forEach((result) => {
    const sector = result.item.sector || "섹터 확인 대기";
    const row = sectors.get(sector) || {
      sector,
      analyzed: 0,
      capture: 0,
      dayTrade: 0,
      supply: 0,
      avoidance: 0,
      risk: 0,
      totalScore: 0,
      topStocks: []
    };
    row.analyzed += 1;
    row.totalScore += Math.max(
      result.scores.capture.score,
      result.scores.dayTrade.score,
      result.scores.supply.score
    );
    if (result.scores.capture.score >= 50) row.capture += 1;
    if (result.scores.dayTrade.score >= 50) row.dayTrade += 1;
    if (result.scores.supply.score >= 50) row.supply += 1;
    if (result.scores.avoidance.score >= 50) row.avoidance += 1;
    if (result.scores.avoidance.score >= 65) row.risk += 1;
    row.topStocks.push({
      name: result.item.name,
      code: result.item.code,
      score: Math.max(
        result.scores.capture.score,
        result.scores.dayTrade.score,
        result.scores.supply.score
      )
    });
    sectors.set(sector, row);
  });

  return [...sectors.values()]
    .map((row) => {
      const opportunity = row.capture + row.dayTrade + row.supply;
      const strength = Math.round(
        (opportunity / Math.max(row.analyzed, 1)) * 55 +
          (row.totalScore / Math.max(row.analyzed, 1)) * 0.45 -
          row.risk * 6
      );
      return {
        ...row,
        strength: clampNumber(strength, 0, 100, 0),
        tone:
          row.risk >= 3
            ? "RISK"
            : strength >= 70
            ? "ENTRY"
            : strength >= 50
            ? "WATCH"
            : "QUIET",
        topStocks: row.topStocks
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
      };
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 8);
}

function applySectorPriority(categories, sectorBoard) {
  const sectorStrength = new Map(
    sectorBoard.map((row) => [row.sector, row.strength])
  );
  Object.values(categories).forEach((list) => {
    list.forEach((card) => {
      const strength = sectorStrength.get(card.sector) || 0;
      const sectorBonus =
        card.categoryCode === "avoidance" ? 0 : Math.max(0, Math.round((strength - 50) / 10));
      card.sectorStrength = strength;
      card.sectorBonus = sectorBonus;
      card.priorityScore =
        card.categoryCode === "avoidance"
          ? card.priorityScore
          : clampNumber(card.priorityScore + sectorBonus, 0, 100, 0);
      card.status =
        card.categoryCode === "avoidance"
          ? card.status
          : getCategoryStatus(card.categoryCode, card.priorityScore, card.status);
      card.visible = card.tradeValueOk && card.priorityScore >= 50;
    });
  });
}

function buildReasonSummary(scoreInfo, riskPenalty, liquidityBonus) {
  const parts = scoreInfo.passed.slice(0, 3);
  if (riskPenalty > 0) parts.push(`회피점수 -${riskPenalty}`);
  if (liquidityBonus > 0) parts.push(`거래대금 +${liquidityBonus}`);
  return parts.join(" · ") || "통과 조건 없음";
}

function getLiquidityBonus(tradeValue, categoryCode) {
  if (categoryCode === "avoidance") return 0;
  const eok = tradeValue / 100000000;
  if (categoryCode === "dayTrade") {
    if (eok >= 300) return 6;
    if (eok >= 100) return 4;
    if (eok >= 50) return 2;
    return 0;
  }
  if (eok >= 100) return 5;
  if (eok >= 30) return 3;
  if (eok >= 10) return 1;
  return 0;
}

function getCategoryStatus(categoryCode, score, fallback) {
  if (categoryCode === "dayTrade") {
    if (score >= 80) return "당일 단타 핵심";
    if (score >= 65) return "단타 관심";
    if (score >= 50) return "관찰";
    return "제외";
  }
  if (categoryCode === "supply") {
    if (score >= 80) return "강한 수급 관심";
    if (score >= 65) return "수급 유입 진행";
    if (score >= 50) return "관찰";
    return "제외";
  }
  if (categoryCode === "capture") {
    return getEntryStatus(score);
  }
  return fallback;
}

function getEntryStatus(score) {
  if (score >= 80) return "매수후보";
  if (score >= 65) return "분할관심";
  if (score >= 50) return "관찰후보";
  return "제외";
}

function pushCandidate(list, card) {
  if (card.tradeValueOk && card.priorityScore >= 40) list.push(card);
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
