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

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (req.method === 'POST' && pathname === '/api/analyze') return handleAnalyze(req, res);
  if (req.method === 'POST' && pathname === '/api/payment/verify') return handlePaymentVerify(req, res);
  if (req.method === 'GET') return serveStatic(req, res);

  send(res, 405, { error: 'Method not allowed' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`땅개 서버 실행 중: http://localhost:${PORT}`);
});
