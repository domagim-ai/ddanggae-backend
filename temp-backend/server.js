// Node.js 내장 모듈만 사용 — npm install 불필요 (Node 18+ 필요)
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 파일 수동 로드
function loadEnv() {
  try {
    const lines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    console.warn('.env 파일을 찾을 수 없습니다. 환경변수를 직접 설정하세요.');
  }
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function repairJSON(str) {
  // 마크다운 코드블록 제거
  let s = str.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  // JSON 객체 추출
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  s = m[0];
  // 제어문자 제거 (newline/tab → 공백)
  s = s.replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // 문자열 값 내부의 비탈출 큰따옴표 수정 (상태 기계)
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') {
      if (!inString) { inString = true; result += ch; continue; }
      // 다음에 오는 문자가 :, ,, }, ] 또는 공백+이런 문자이면 문자열 닫힘
      const rest = s.slice(i + 1).trimStart();
      if (/^[,}\]:]/.test(rest)) { inString = false; result += ch; }
      else { result += '\\"'; } // 비탈출 따옴표 → 이스케이프
      continue;
    }
    result += ch;
  }
  return result;
}

async function handleAnalyze(req, res) {
  const { sido, jibun, purpose } = await readBody(req);
  if (!sido || !jibun || !purpose) {
    return send(res, 400, { error: '시/군/구, 지번, 개발 목적을 모두 입력해 주세요.' });
  }

  const prompt = `당신은 30년 경력의 한국 토지 개발 및 인허가 전문가입니다. 다음 토지를 분석하고 반드시 아래 JSON 형식으로만 응답하세요.

토지: ${sido} ${jibun}
개발 목적: ${purpose}

JSON 출력 규칙 (반드시 준수):
- 순수 JSON만 출력. 마크다운, 코드블록, 설명 텍스트 절대 없음
- 모든 문자열 값 내부에 큰따옴표(") 사용 금지. 괄호 표현은 소괄호()와 홑따옴표(') 사용
- 모든 문자열 값은 한 줄로 작성. 줄바꿈 사용 금지
- 배열 마지막 요소 뒤 콤마 없음

JSON 형식:
{
  "score": 75,
  "grade": "보통",
  "grade_type": "warn",
  "summary": "분석 요약 3~4문장. 따옴표 없이 작성",
  "zone_info": "추정 용도지역",
  "key_laws": ["국토계획법","농지법","산지관리법"],
  "risk_tags": [{"label":"리스크항목","type":"ok|warn|danger"}],
  "departments": [{"name":"부서명","role":"담당 역할 설명","docs":"주요 서류 목록"}],
  "documents": [{"name":"서류명","note":"발급처 설명","expert":"필요 전문가"}],
  "preconditions": "사전 확인사항 한 줄 설명",
  "experts_needed": ["산림기술사","환경영향평가사"]
}

grade_type 기준: score 70이상=ok, 40~69=warn, 40미만=danger`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: '한국 토지 개발 인허가 전문가. 순수 JSON만 출력. 마크다운 없음. 문자열 내 큰따옴표 사용 금지.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error('[Claude API 오류]', JSON.stringify(err));
      const msg = err?.error?.message || err?.error?.type || JSON.stringify(err);
      return send(res, 502, { error: `AI 분석 오류: ${msg}` });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    let parsed;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('JSON 객체 없음');
      parsed = JSON.parse(m[0]);
    } catch {
      const repaired = repairJSON(raw);
      if (!repaired) return send(res, 502, { error: 'AI 응답 파싱 오류' });
      parsed = JSON.parse(repaired);
    }
    send(res, 200, parsed);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handlePaymentVerify(req, res) {
  const { paymentKey, orderId, amount } = await readBody(req);
  if (!paymentKey || !orderId || !amount) {
    return send(res, 400, { error: '결제 정보가 부족합니다.' });
  }

  try {
    const auth = Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64');
    const response = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });

    const data = await response.json();
    if (!response.ok) {
      const msg = data?.message || data?.code || JSON.stringify(data);
      console.error('[Toss 결제 오류]', JSON.stringify(data));
      return send(res, 400, { error: msg, detail: data });
    }

    send(res, 200, { success: true, orderId: data.orderId });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  let filePath = path.join(__dirname, parsed.pathname === '/' ? 'index.html' : parsed.pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ========== 감정평가 (공공데이터 API) ==========

async function fetchDataGov(url, params) {
  const query = new URLSearchParams({
    serviceKey: process.env.LAND_DATA_KEY,
    numOfRows: '100',
    pageNo: '1',
    ...params,
  });
  const resp = await fetch(`${url}?${query}`, { signal: AbortSignal.timeout(12000) });
  const text = await resp.text();
  if (!resp.ok) {
    console.error(`[fetchDataGov 오류] ${resp.status} ${url}`, text.slice(0, 200));
    throw new Error(`API ${resp.status}`);
  }
  if (text.includes('SERVICE_KEY_IS_NOT_REGISTERED_ERROR') || text.includes('LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR') || text.includes('INVALID_REQUEST_PARAMETER_ERROR')) {
    console.error(`[data.go.kr 키 오류]`, text.slice(0, 300));
    throw new Error('data.go.kr API 키 오류: ' + text.slice(0, 100));
  }
  return text;
}

// XML <item> 목록 → 객체 배열
function parseXmlItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const obj = {};
    const fr = /<([^/>\s]+)>([\s\S]*?)<\/\1>/g;
    let fm;
    while ((fm = fr.exec(m[1])) !== null) obj[fm[1]] = fm[2].trim();
    if (Object.keys(obj).length) items.push(obj);
  }
  return items;
}

// V-World 지번주소 지오코더 → { pnu, dongCode10 }
async function getPNUFromVworld(fullAddress) {
  const params = new URLSearchParams({
    service: 'address',
    request: 'getcoord',
    type: 'PARCEL',
    address: fullAddress,
    key: process.env.VWORLD_KEY,
    format: 'json',
  });
  const resp = await fetch(`https://api.vworld.kr/req/address?${params}`, {
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json();

  if (data.response?.status !== 'OK') return null;

  // level4LC = 19자리 PNU (법정동코드10 + 대지구분1 + 본번4 + 부번4)
  const structure = data.response?.refined?.structure;
  const pnu = structure?.level4LC || '';
  if (pnu.length !== 19) return null;

  return { pnu, dongCode10: pnu.slice(0, 10) };
}

// 주소 문자열 파싱 → { parts, bun, ji }
function parseKoreanAddress(address) {
  const tokens = address.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const last = tokens[tokens.length - 1];
  let bun, ji = 0;
  if (/^\d+-\d+$/.test(last)) {
    [bun, ji] = last.split('-').map(Number);
  } else if (/^\d+$/.test(last)) {
    bun = Number(last);
  } else return null;
  if (!bun) return null;
  return { parts: tokens.slice(0, -1), bun, ji };
}

function buildPNU(dongCode10, landType, bun, ji) {
  return `${dongCode10}${landType}${String(bun).padStart(4,'0')}${String(ji).padStart(4,'0')}`;
}

// V-World 국가중점데이터 API 호출 (/ned/data/ 엔드포인트)
async function fetchNed(path, params) {
  const query = new URLSearchParams({
    key: process.env.PUBLIC_DATA_KEY,   // 개별공시지가 전용 V-World 키
    format: 'json',
    numOfRows: '10',
    pageNo: '1',
    ...params,
  });
  const resp = await fetch(`https://api.vworld.kr/ned/data/${path}?${query}`, {
    signal: AbortSignal.timeout(12000),
    headers: { Referer: 'https://ddanggae.co.kr' },
  });
  const data = await resp.json();
  console.log(`[NED ${path}]`, JSON.stringify(data).slice(0, 400));
  return data;
}

// 개별공시지가 조회 (V-World NED API — getIndvdLandPriceAttr)
// 응답 구조: { indvdLandPrices: { field:[...], row:[...] } }
async function getIndvdLandPrice(pnu) {
  const curYear = new Date().getFullYear();
  for (const year of [curYear, curYear - 1, curYear - 2]) {
    try {
      const data = await fetchNed('getIndvdLandPriceAttr', { pnu, stdrYear: String(year) });
      const inner = data?.indvdLandPrices;
      if (!inner || (inner.resultCode && inner.resultCode !== '' && inner.resultCode !== '00')) continue;
      const rows = inner?.field || inner?.row || inner?.rows || [];
      const arr  = Array.isArray(rows) ? rows : [rows];
      if (!arr.length || !arr[0]) continue;
      const row = arr[0];
      const price = Number(row.pblntfPclnd || row.indvdLandPrice || 0);
      const area  = Number(row.lndpclAr || row.area || 0);
      if (price > 0 || area > 0) {
        return {
          year: Number(row.stdrYear || year),
          pricePerSqm: price,
          area,
          landType: row.lndcgrCodeNm || '',
          usage: row.ladUseSittnNm || '',
        };
      }
    } catch (e) {
      console.error(`[getIndvdLandPrice ${year}]`, e.message);
    }
  }
  return null;
}

// 토지특성 (V-World Data API — 연속지적도, 면적 포함)
async function getLandCharacter(pnu) {
  const keys = [process.env.PUBLIC_DATA_KEY, process.env.VWORLD_KEY];
  for (const key of keys) {
    try {
      const params = new URLSearchParams({
        service: 'data', request: 'GetFeature', data: 'LP_PA_CBND_BUBUN',
        key, format: 'json', geometry: 'false', attrFilter: `pnu:=:${pnu}`,
        crs: 'EPSG:4326',
      });
      const resp = await fetch(`https://api.vworld.kr/req/data?${params}`, {
        signal: AbortSignal.timeout(10000),
        headers: { Referer: 'https://ddanggae.co.kr' },
      });
      const data = await resp.json();
      const props0 = data?.response?.result?.featureCollection?.features?.[0]?.properties;
      console.log('[getLandCharacter props]', JSON.stringify(props0));
      const features = data?.response?.result?.featureCollection?.features || [];
      if (!features.length) continue;
      const p = features[0]?.properties || {};
      return {
        area: Number(p.lndpclAr || p.shape_area || p.SHAPE_AREA || 0),
        landType: p.lndcgrCodeNm || p.lndcgrCode || '',
        usage: p.ladUseSittnNm || p.ladUseSittn || '',
        road: p.roadSideCodeNm || '',
        shape: p.tpgrphFrmCodeNm || '',
        topo: p.tpgrphHgCodeNm || '',
      };
    } catch (e) {
      console.error('[getLandCharacter]', e.message);
    }
  }
  return null;
}

// 표준지공시지가 조회 (시군구 단위)
async function getStdLandPrices(dongCode10, year) {
  const url = 'https://apis.data.go.kr/1611000/nsdi/StdLandPriceService/attr/getStdLandPriceAttrList';
  const ldCode = dongCode10.slice(0, 5);
  const xml = await fetchDataGov(url, { ldCode, stdrYear: String(year), numOfRows: '50' });
  return parseXmlItems(xml)
    .map(i => ({
      pricePerSqm: Number(i.pblntfPclnd || 0),
      landType: i.lndcgrCodeNm || '',
      usage: i.ladUseSittnNm || '',
    }))
    .filter(i => i.pricePerSqm > 0);
}

// 토지 실거래가 조회 (최근 N개월)
async function getLandTransactions(dongCode10, months = 12) {
  const url = 'https://apis.data.go.kr/1613000/RTMSDataSvcLandTrade/getRTMSDataSvcLandTrade';
  const lawdCd = dongCode10.slice(0, 5);
  const now = new Date();

  const reqs = Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i - 1, 1);
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
    return fetchDataGov(url, { LAWD_CD: lawdCd, DEAL_YMD: ym, numOfRows: '100' })
      .then(parseXmlItems).catch(() => []);
  });

  const all = (await Promise.all(reqs)).flat();
  return all.map(item => {
    const price = Number((item['거래금액'] || item.dealAmount || '').replace(/,/g, '')) || 0;
    const area  = Number(item['면적'] || item.area || 0);
    const year  = Number(item['년'] || item.dealYear || 0);
    const month = Number(item['월'] || item.dealMonth || 0);
    return {
      price, area, year, month,
      landType: item['지목'] || item.landType || '',
      usage: item['용도지역'] || item.usage || '',
    };
  }).filter(t => t.price > 0 && t.area > 0 && t.year > 0);
}

// 시점수정계수 (연 3% 단순 적용)
function timeAdjFactor(fromYear, fromMonth = 1) {
  const now = new Date();
  const months = (now.getFullYear() - fromYear) * 12 + (now.getMonth() + 1 - fromMonth);
  return months > 0 ? Math.pow(1.03, months / 12) : 1;
}

// 공시지가 기준법
function calcOfficialMethod(ip, area) {
  const factor = timeAdjFactor(ip.year, 1);
  const adjPpSqm = Math.round(ip.pricePerSqm * factor);
  return {
    method: '공시지가 기준법',
    baseYear: ip.year,
    basePricePerSqm: ip.pricePerSqm,
    timeAdjFactor: Math.round(factor * 10000) / 10000,
    adjPricePerSqm: adjPpSqm,
    area,
    totalPrice: Math.round(adjPpSqm * area),
  };
}

// 거래사례비교법
function calcComparativeMethod(txns, area, targetLandType) {
  if (!txns.length) return null;

  const same = txns.filter(t => t.landType === targetLandType);
  const pool = same.length >= 3 ? same : txns;

  const now = new Date();
  const adjusted = pool.map(t => {
    const mo = (now.getFullYear() - t.year) * 12 + (now.getMonth() + 1 - t.month);
    const adjPpSqm = (t.price * 10000 / t.area) * Math.pow(1.03, mo / 12);
    return { ...t, adjPpSqm };
  }).sort((a, b) => a.adjPpSqm - b.adjPpSqm);

  // IQR 이상치 제거
  let finalPool = adjusted;
  if (adjusted.length >= 4) {
    const q1 = adjusted[Math.floor(adjusted.length * 0.25)].adjPpSqm;
    const q3 = adjusted[Math.floor(adjusted.length * 0.75)].adjPpSqm;
    const iqr = q3 - q1;
    const trimmed = adjusted.filter(a => a.adjPpSqm >= q1 - 1.5 * iqr && a.adjPpSqm <= q3 + 1.5 * iqr);
    if (trimmed.length >= 3) finalPool = trimmed;
  }

  const median = finalPool[Math.floor(finalPool.length / 2)].adjPpSqm;
  const adjPpSqm = Math.round(median);

  return {
    method: '거래사례비교법',
    totalTxns: txns.length,
    usedTxns: finalPool.length,
    adjPricePerSqm: adjPpSqm,
    area,
    totalPrice: Math.round(adjPpSqm * area),
    samples: finalPool.slice(-5).reverse().map(t => ({
      date: `${t.year}.${String(t.month).padStart(2, '0')}`,
      area: t.area,
      priceMw: t.price,
      adjPpSqm: Math.round(t.adjPpSqm),
    })),
  };
}

async function handleVworldTest(req, res) {
  const pnu = '4113510300101000001';
  const results = {};

  // 1. Data API — VWORLD_KEY
  try {
    const p1 = new URLSearchParams({ service:'data', request:'GetFeature', data:'LP_PA_CBND_BUBUN', key: process.env.VWORLD_KEY, format:'json', geometry:'false', attrFilter:`pnu:=:${pnu}` });
    const r1 = await fetch(`https://api.vworld.kr/req/data?${p1}`, { signal: AbortSignal.timeout(8000) });
    results.dataAPI_VWORLD = (await r1.json())?.response?.status + ' / ' + JSON.stringify((await fetch(`https://api.vworld.kr/req/data?${p1}`,{signal:AbortSignal.timeout(8000)})).status);
  } catch(e){ results.dataAPI_VWORLD = 'ERR: '+e.message; }

  // 2. Data API — PUBLIC_DATA_KEY
  try {
    const p2 = new URLSearchParams({ service:'data', request:'GetFeature', data:'LP_PA_CBND_BUBUN', key: process.env.PUBLIC_DATA_KEY, format:'json', geometry:'false', attrFilter:`pnu:=:${pnu}` });
    const r2 = await (await fetch(`https://api.vworld.kr/req/data?${p2}`, { signal: AbortSignal.timeout(8000) })).json();
    results.dataAPI_PUBLIC = r2?.response?.status + ' error:' + r2?.response?.error?.code;
  } catch(e){ results.dataAPI_PUBLIC = 'ERR: '+e.message; }

  // 3. WFS — PUBLIC_DATA_KEY (개별공시지가 키가 WFS용일 수 있음)
  try {
    const p3 = new URLSearchParams({ service:'WFS', version:'2.0.0', request:'GetFeature', typename:'LP_PA_CBND_BUBUN', key: process.env.PUBLIC_DATA_KEY, outputFormat:'application/json', count:'1', CQL_FILTER:`pnu='${pnu}'` });
    const r3 = await (await fetch(`https://api.vworld.kr/req/wfs?${p3}`, { signal: AbortSignal.timeout(8000) })).text();
    results.wfsAPI_PUBLIC = r3.slice(0, 200);
  } catch(e){ results.wfsAPI_PUBLIC = 'ERR: '+e.message; }

  // 4. data.go.kr 개별공시지가 — PUBLIC_DATA_KEY
  try {
    const p4 = new URLSearchParams({ serviceKey: process.env.PUBLIC_DATA_KEY, pnu, stdrYear:'2024', numOfRows:'1', pageNo:'1' });
    const r4 = await fetch(`http://apis.data.go.kr/1611000/nsdi/IndvdLandPriceService/attr/getIndvdLandPriceAttrList?${p4}`, { signal: AbortSignal.timeout(8000) });
    results.dataGov_status = r4.status;
    results.dataGov_body = (await r4.text()).slice(0, 200);
  } catch(e){ results.dataGov = 'ERR: '+e.message; }

  results.keys = { VWORLD_KEY: process.env.VWORLD_KEY?.slice(0,8)+'...', PUBLIC_DATA_KEY: process.env.PUBLIC_DATA_KEY?.slice(0,8)+'...' };
  send(res, 200, results);
}

async function handleValuation(req, res) {
  const body = await readBody(req);
  const { pnu: directPnu, address, landType = '1' } = body;

  let pnu, dongCode10;

  if (directPnu && /^\d{19}$/.test(directPnu.trim())) {
    pnu = directPnu.trim();
    dongCode10 = pnu.slice(0, 10);
  } else if (address) {
    let vwResult;
    try {
      vwResult = await getPNUFromVworld(address);
    } catch (e) {
      return send(res, 502, { error: `V-World 주소 조회 실패: ${e.message}` });
    }
    if (!vwResult) {
      return send(res, 404, { error: `'${address}' 주소를 찾을 수 없습니다. 지번주소를 정확히 입력하거나 PNU를 직접 입력해 주세요.` });
    }
    pnu = vwResult.pnu;
    dongCode10 = vwResult.dongCode10;
  } else {
    return send(res, 400, { error: 'address 또는 pnu(19자리)를 입력해 주세요.' });
  }

  // 개별공시지가 + 토지특성 병렬 조회 (data.go.kr LAND_DATA_KEY 필요)
  const [ipRes, lcRes] = await Promise.allSettled([
    getIndvdLandPrice(pnu),
    getLandCharacter(pnu),
  ]);
  const ip = ipRes.status === 'fulfilled' ? ipRes.value : null;
  const lc = lcRes.status === 'fulfilled' ? lcRes.value : null;

  if (!ip || ip.pricePerSqm === 0) {
    return send(res, 404, {
      error: `PNU ${pnu} 공시지가 정보를 찾을 수 없습니다.`,
      hint: '.env 파일의 LAND_DATA_KEY에 data.go.kr 서비스키를 설정해 주세요. (data.go.kr → 국토교통부 개별공시지가정보서비스 신청)',
    });
  }

  const area        = Number(body.area) || lc?.area || ip.area || 0;
  const targetType  = lc?.landType || ip.landType || '';

  // 표준지 + 실거래가 병렬 조회 (실패해도 계속)
  const [stdsRes, txnsRes] = await Promise.allSettled([
    getStdLandPrices(dongCode10, ip.year),
    getLandTransactions(dongCode10, 12),
  ]);
  const txns = txnsRes.status === 'fulfilled' ? txnsRes.value : [];

  const officialResult     = calcOfficialMethod(ip, area);
  const comparativeResult  = calcComparativeMethod(txns, area, targetType);

  const methods   = [officialResult, comparativeResult].filter(Boolean);
  const avgTotal  = Math.round(methods.reduce((s, m) => s + m.totalPrice, 0) / methods.length);
  const low       = Math.min(...methods.map(m => m.totalPrice));
  const high      = Math.max(...methods.map(m => m.totalPrice));

  send(res, 200, {
    pnu,
    address: address || pnu,
    landInfo: {
      area,
      landType: targetType,
      usage: lc?.usage || ip.usage || '',
      road: lc?.road || '',
      shape: lc?.shape || '',
      topo: lc?.topo || '',
    },
    officialMethod: officialResult,
    comparativeMethod: comparativeResult,
    summary: {
      avgTotalPrice: avgTotal,
      priceRange: { low, high },
      methodsUsed: methods.length,
    },
  });
}

// ========== 라우터 ==========

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (req.method === 'POST' && pathname === '/api/analyze')          return handleAnalyze(req, res);
  if (req.method === 'POST' && pathname === '/api/payment/verify')   return handlePaymentVerify(req, res);
  if (req.method === 'POST' && pathname === '/api/valuation')        return handleValuation(req, res);
  if (req.method === 'GET') return serveStatic(req, res);

  send(res, 405, { error: 'Method not allowed' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`땅개 서버 실행 중: http://localhost:${PORT}`);
});
