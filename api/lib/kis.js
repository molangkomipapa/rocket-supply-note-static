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

  return {
    getMarketCapRank,
    getPrice,
    getDailyChart,
    getProgramTradeDaily
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
