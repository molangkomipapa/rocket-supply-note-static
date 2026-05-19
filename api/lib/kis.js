export function createKisClient({
  baseUrl,
  marketDataCode,
  runtimeCache,
  appKey,
  appSecret
}) {
  async function kisGet(path, trId, params) {
    const accessToken = await getAccessToken(Date.now());
    const url = new URL(`${baseUrl}${path}`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        appkey: appKey,
        appsecret: appSecret,
        "content-type": "application/json; charset=utf-8",
        tr_id: trId
      }
    });
    return response.json();
  }

  async function getAccessToken(now) {
    const cached = runtimeCache.token;
    if (cached?.accessToken && cached.expiresAt > now + 60000) {
      return cached.accessToken;
    }

    const tokenRes = await fetch(`${baseUrl}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: appKey,
        appsecret: appSecret
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
    const masterList = await getMarketCapRankFromMaster(market, count).catch(
      () => []
    );
    const masterByCode = new Map(masterList.map((item) => [item.code, item]));
    const enrichedApiList = apiList.map((item) => ({
      ...masterByCode.get(item.code),
      ...item,
      sector: item.sector || masterByCode.get(item.code)?.sector || "섹터 확인 대기",
      industryCode:
        item.industryCode || masterByCode.get(item.code)?.industryCode || ""
    }));
    if (enrichedApiList.length >= count) return enrichedApiList.slice(0, count);

    const merged = uniqueStocks([...enrichedApiList, ...masterList]).slice(0, count);
    return merged.length ? merged : enrichedApiList;
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

  async function getPrice(code, fallbackMarketCode = marketDataCode) {
    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      "FHKST01010100",
      {
        fid_cond_mrkt_div_code: fallbackMarketCode,
        fid_input_iscd: code
      }
    );
    const output = data.output || null;
    if (output || fallbackMarketCode === "J") return output;
    return getPrice(code, "J");
  }

  async function getDailyChart(code, fallbackMarketCode = marketDataCode) {
    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      {
        fid_cond_mrkt_div_code: fallbackMarketCode,
        fid_input_iscd: code,
        fid_input_date_1: "20240101",
        fid_input_date_2: todayYmd(),
        fid_period_div_code: "D",
        fid_org_adj_prc: "0"
      }
    );
    const output = data.output2 || [];
    if (output.length || fallbackMarketCode === "J") return output;
    return getDailyChart(code, "J");
  }

  async function getProgramTradeDaily(code, fallbackMarketCode = marketDataCode) {
    const data = await kisGet(
      "/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily",
      "FHPPG04650201",
      {
        fid_cond_mrkt_div_code: fallbackMarketCode,
        fid_input_iscd: code,
        fid_input_date_1: ""
      }
    );
    const output = data.output || data.output1 || data.output2 || [];
    if (output.length || fallbackMarketCode === "J") return output;
    return getProgramTradeDaily(code, "J");
  }

  async function getStockMeta(code) {
    const [kospi, kosdaq] = await Promise.all([
      getMarketCapRankFromMaster("KOSPI", 10000).catch(() => []),
      getMarketCapRankFromMaster("KOSDAQ", 10000).catch(() => [])
    ]);
    return [...kospi, ...kosdaq].find((item) => item.code === code) || null;
  }

  return {
    getMarketCapRank,
    getPrice,
    getDailyChart,
    getProgramTradeDaily,
    getStockMeta
  };
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

  return rows.map(({ code, name, market, sector, industryCode, marketCap }) => ({
    code,
    name,
    market,
    sector,
    industryCode,
    marketCap
  }));
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
  const industryLarge = tail.slice(4, 8);
  const industryMiddle = tail.slice(8, 12);
  const marketCap = toNumber(tail.slice(tail.length - 15, tail.length - 6));

  if (!code || !name || !["ST", "FS"].includes(groupCode) || marketCap <= 0) {
    return null;
  }
  return {
    code,
    name,
    market: config.market,
    sector: inferSector(name, industryLarge, industryMiddle, config.market),
    industryCode: `${industryLarge}/${industryMiddle}`,
    marketCap
  };
}

function inferSector(name, industryLarge, industryMiddle, market) {
  const keywordSector = inferSectorByName(name);
  if (keywordSector) return keywordSector;

  const key = `${market}:${industryMiddle}`;
  const middleMap = {
    "KOSPI:0005": "음식료/담배",
    "KOSPI:0008": "화학/에너지",
    "KOSPI:0009": "바이오/제약",
    "KOSPI:0011": "철강/소재",
    "KOSPI:0012": "기계/중공업",
    "KOSPI:0013": "반도체/전자",
    "KOSPI:0015": "자동차/운송장비",
    "KOSDAQ:1024": "바이오/제약",
    "KOSDAQ:1027": "로봇/기계",
    "KOSDAQ:1028": "2차전지/소재"
  };
  if (middleMap[key]) return middleMap[key];

  const largeMap = {
    "0020": "통신",
    "0029": "인터넷/IT서비스",
    "1006": "바이오/헬스케어",
    "1014": "IT/소프트웨어"
  };
  return largeMap[industryLarge] || "섹터 확인 대기";
}

function inferSectorByName(name) {
  const rules = [
    [/조선|중공업|한화오션|한국조선|삼성중공업|HD현대미포/, "조선"],
    [/금융|은행|증권|보험|카드|지주|캐피탈/, "금융"],
    [/바이오|제약|셀트리온|알테오젠|삼천당|헬스케어|메디|파마/, "바이오/제약"],
    [/전자|하이닉스|반도체|실리콘|테크윙|리노공업/, "반도체/전자"],
    [/에코프로|배터리|에너지솔루션|퓨처엠|엘앤에프|천보/, "2차전지"],
    [/현대차|기아|모비스|만도|HL만도|자동차|타이어/, "자동차"],
    [/NAVER|카카오|엔씨|게임|소프트|데이터|클라우드/, "인터넷/게임"],
    [/화학|이노베이션|S-Oil|정유|석유|케미칼/, "화학/에너지"],
    [/POSCO|철강|스틸|제강/, "철강/소재"],
    [/텔레콤|통신|KT|LG유플러스/, "통신"],
    [/건설|건축|시멘트|레미콘/, "건설/인프라"],
    [/로보|로봇|Robot/, "로봇"]
  ];
  return rules.find(([pattern]) => pattern.test(name))?.[1] || "";
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

function toNumber(value) {
  const number = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function todayYmd() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("");
}
