/**
 * Proxy + static server cho trang tuyển dụng Thịnh Thế Vinh Hoa.
 * Chỉ dùng module built-in của Node (http, https, fs, path, url) — KHÔNG cần npm install.
 *
 * Chạy:   node server.js
 * Mở:     http://localhost:3000/tuyen-dung.html
 *
 * Trình duyệt KHÔNG bao giờ thấy token: nó chỉ gọi /api/<key>,
 * server này mới gắn token và gọi tới 1Office.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const chatbot = require('./chatbot');
const db = require('./db');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

function loadConfig() {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    // Khi deploy (vd Railway) không có config.json (đã gitignore) -> dùng config.example.json làm nền
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    } catch (e2) {
      console.error('Không đọc được config.json/config.example.json:', e2.message);
      return null;
    }
  }
  // Overlay biến môi trường (cho deploy) — token & các giá trị nhạy cảm KHÔNG nằm trong git
  const o = cfg.oneOffice || (cfg.oneOffice = {});
  if (process.env.ONEOFFICE_TOKEN) o.token = process.env.ONEOFFICE_TOKEN;
  if (process.env.ONEOFFICE_BASEURL) o.baseUrl = process.env.ONEOFFICE_BASEURL;
  if (o.create) {
    if (process.env.ONEOFFICE_WRITE_TOKEN) o.create.token = process.env.ONEOFFICE_WRITE_TOKEN;
    o.create.extra = o.create.extra || {};
    if (process.env.APPLY_SOURCE) o.create.extra.source = process.env.APPLY_SOURCE;
    if (process.env.APPLY_CAMPAIGN) o.create.extra.campaign_current_id = process.env.APPLY_CAMPAIGN;
  }
  // Chatbot
  const cb = cfg.chatbot || (cfg.chatbot = {});
  if (process.env.GEMINI_API_KEY) cb.geminiApiKey = process.env.GEMINI_API_KEY;
  if (process.env.GEMINI_MODEL) cb.geminiModel = process.env.GEMINI_MODEL;
  if (process.env.AGENT_KEY) cb.agentKey = process.env.AGENT_KEY;
  return cfg;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

// Lấy mảng dữ liệu từ JSON trả về của 1Office (cấu trúc có thể khác nhau).
function extractArray(payload, dataPath) {
  if (dataPath) {
    let cur = payload;
    for (const part of dataPath.split('.')) {
      if (cur == null) break;
      cur = cur[part];
    }
    if (Array.isArray(cur)) return cur;
    if (cur && typeof cur === 'object') return [cur];
  }
  if (Array.isArray(payload)) return payload;
  // Tự dò: tìm mảng đầu tiên trong các key phổ biến rồi tới mọi key.
  const prefer = ['data', 'rows', 'results', 'items', 'list', 'records'];
  if (payload && typeof payload === 'object') {
    for (const k of prefer) {
      if (Array.isArray(payload[k])) return payload[k];
      if (payload[k] && Array.isArray(payload[k].rows)) return payload[k].rows;
      if (payload[k] && Array.isArray(payload[k].data)) return payload[k].data;
    }
    for (const k of Object.keys(payload)) {
      if (Array.isArray(payload[k])) return payload[k];
    }
  }
  return null;
}

function proxyTo1Office(key, cfg, res, clientParams) {
  const o = cfg.oneOffice || {};
  const endpoint = (o.endpoints || {})[key];
  if (!endpoint) {
    return sendJson(res, 400, { error: 'Chưa cấu hình endpoint cho "' + key + '" trong config.json' });
  }

  // Token: ưu tiên token riêng của mục, nếu trống thì dùng token mặc định.
  const perKey = (o.endpointTokens || {})[key];
  const token = (perKey && !/^PASTE_/i.test(perKey)) ? perKey : o.token;
  if (!token || /PASTE_|YOUR_/i.test(token)) {
    return sendJson(res, 428, {
      error: 'Mục "' + key + '" chưa có token hợp lệ. Hãy tạo API token cho object này trong 1Office rồi dán vào config.json (endpointTokens.' + key + ').'
    });
  }

  // Cho phép endpoint là URL đầy đủ hoặc chỉ path.
  let targetUrl;
  try {
    targetUrl = /^https?:\/\//i.test(endpoint)
      ? new URL(endpoint)
      : new URL(endpoint.replace(/^\//, '/'), o.baseUrl);
  } catch (e) {
    return sendJson(res, 500, { error: 'baseUrl/endpoint không hợp lệ: ' + e.message });
  }

  // Chuyển tiếp tham số phân trang / lọc từ client (limit, page, ...).
  if (clientParams) {
    for (const [k, v] of clientParams) {
      if (k === 'access_token') continue;
      targetUrl.searchParams.set(k, v);
    }
  }
  if (!targetUrl.searchParams.has('limit') && o.pageLimit) {
    targetUrl.searchParams.set('limit', String(o.pageLimit));
  }

  const headers = { 'Accept': 'application/json' };
  if ((o.tokenMode || 'query') === 'header') {
    headers[o.headerName || 'Authorization'] = (o.headerPrefix || '') + token;
  } else {
    targetUrl.searchParams.set(o.tokenParam || 'access_token', token);
  }

  const lib = targetUrl.protocol === 'http:' ? http : https;
  const reqOpts = {
    method: 'GET',
    headers,
    timeout: 20000
  };

  const upstream = lib.request(targetUrl, reqOpts, (up) => {
    let raw = '';
    up.setEncoding('utf8');
    up.on('data', (c) => (raw += c));
    up.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 502, {
          error: '1Office không trả về JSON hợp lệ (HTTP ' + up.statusCode + ').',
          preview: raw.slice(0, 400)
        });
      }
      // 1Office báo lỗi nghiệp vụ ngay trong JSON (error:true) dù HTTP 200.
      if (payload && payload.error === true) {
        return sendJson(res, 200, {
          ok: false,
          key,
          error: '1Office: ' + (payload.message || payload.code || 'lỗi không xác định'),
          code: payload.code
        });
      }
      const rows = extractArray(payload, o.dataPath);
      sendJson(res, 200, {
        ok: true,
        key,
        count: rows ? rows.length : 0,
        total: payload && (payload.total_item != null ? payload.total_item : payload.total),
        rows: rows || [],
        raw: rows ? undefined : payload // nếu không tìm thấy mảng, trả raw để bạn xem cấu trúc
      });
    });
  });

  upstream.on('timeout', () => {
    upstream.destroy();
    sendJson(res, 504, { error: 'Hết thời gian chờ khi gọi 1Office.' });
  });
  upstream.on('error', (e) => sendJson(res, 502, { error: 'Lỗi gọi 1Office: ' + e.message }));
  upstream.end();
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  // chặn path traversal
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Không tìm thấy: ' + safe);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Đọc body (JSON) của request POST.
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve(null); } });
  });
}

// Tạo ứng viên mới trên 1Office từ dữ liệu form (đẩy vào Kanban).
async function createCandidate(form, cfg, res) {
  const o = cfg.oneOffice || {};
  const c = o.create || {};
  if (!c.endpoint) {
    return sendJson(res, 501, { error: 'Chưa cấu hình endpoint tạo ứng viên (oneOffice.create.endpoint) trong config.json.' });
  }
  const token = (c.token && !/^PASTE_|^$/.test(c.token)) ? c.token : o.token;
  if (!token || /PASTE_|YOUR_/i.test(token)) {
    return sendJson(res, 428, { error: 'Chưa có token GHI hợp lệ để tạo ứng viên (oneOffice.create.token).' });
  }

  // Map field form -> field 1Office theo cấu hình; gộp thêm các field cố định (vd campaign).
  const map = c.fieldMap || {};
  const payload = Object.assign({}, c.extra || {});
  for (const k in form) {
    if (form[k] == null || form[k] === '') continue;
    const target = map[k];
    if (target) payload[target] = form[k];
  }
  // Ngày sinh: input HTML là yyyy-mm-dd -> 1Office cần dd/mm/YYYY
  if (payload.birthday && /^\d{4}-\d{2}-\d{2}$/.test(payload.birthday)) {
    const p = payload.birthday.split('-'); payload.birthday = p[2] + '/' + p[1] + '/' + p[0];
  }
  // code BẮT BUỘC & duy nhất -> tự sinh nếu chưa có
  if (!payload.code) payload.code = (c.codePrefix || 'WEB') + Date.now();
  // bỏ các field cố định để rỗng (vd campaign_current_id chưa cấu hình)
  for (const k in payload) { if (payload[k] === '' || payload[k] == null) delete payload[k]; }

  let targetUrl;
  try {
    targetUrl = /^https?:\/\//i.test(c.endpoint) ? new URL(c.endpoint) : new URL(c.endpoint, o.baseUrl);
  } catch (e) { return sendJson(res, 500, { error: 'create.endpoint không hợp lệ: ' + e.message }); }
  targetUrl.searchParams.set(o.tokenParam || 'access_token', token);

  const body = new URLSearchParams(payload).toString();
  const lib = targetUrl.protocol === 'http:' ? http : https;
  const upstream = lib.request(targetUrl, {
    method: c.method || 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'Accept': 'application/json' },
    timeout: 20000
  }, (up) => {
    let raw = ''; up.setEncoding('utf8'); up.on('data', (d) => (raw += d));
    up.on('end', () => {
      let j; try { j = JSON.parse(raw); } catch (e) { j = null; }
      if (j && j.error === true) return sendJson(res, 200, { ok: false, error: '1Office: ' + (j.message || j.code) });
      sendJson(res, 200, { ok: true, result: j || raw.slice(0, 300), sent: Object.keys(payload) });
    });
  });
  upstream.on('timeout', () => { upstream.destroy(); sendJson(res, 504, { error: 'Hết thời gian chờ khi gọi 1Office.' }); });
  upstream.on('error', (e) => sendJson(res, 502, { error: 'Lỗi gọi 1Office: ' + e.message }));
  upstream.write(body); upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Đăng ký lịch đào tạo (lưu DB / RAM)
  if (url.pathname === '/api/training' && req.method === 'POST') {
    const form = await readBody(req);
    if (!form || !((form.name || '').trim()) || !((form.phone || '').trim())) {
      return sendJson(res, 400, { error: 'Thiếu họ tên hoặc số điện thoại.' });
    }
    try {
      const id = await db.addTraining(form);
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 500, { error: 'Không lưu được đăng ký: ' + e.message });
    }
  }
  // Danh sách đăng ký đào tạo cho nhân viên (cần token đăng nhập agent)
  if (url.pathname === '/api/training' && req.method === 'GET') {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token');
    if (!db.getSession(token)) return sendJson(res, 401, { error: 'Cần đăng nhập nhân viên.' });
    try {
      return sendJson(res, 200, { ok: true, rows: await db.listTraining() });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Nhận hồ sơ ứng tuyển từ form -> tạo ứng viên trên 1Office
  if (url.pathname === '/api/apply' && req.method === 'POST') {
    const cfg = loadConfig();
    if (!cfg) return sendJson(res, 500, { error: 'Không đọc được config.json' });
    const form = await readBody(req);
    if (!form) return sendJson(res, 400, { error: 'Dữ liệu form không hợp lệ.' });
    return createCandidate(form, cfg, res);
  }

  // Chatbot (khách + nhân viên)
  if (url.pathname.startsWith('/api/chat/') || url.pathname.startsWith('/api/agent/')) {
    return chatbot.handleChat(req, res, url, loadConfig);
  }

  if (url.pathname.startsWith('/api/')) {
    const key = url.pathname.slice('/api/'.length).replace(/\/$/, '');
    const cfg = loadConfig();
    if (!cfg) return sendJson(res, 500, { error: 'Không đọc được config.json' });
    return proxyTo1Office(key, cfg, res, url.searchParams);
  }
  serveStatic(req, res);
});

const cfg = loadConfig() || { port: 3000 };
const PORT = process.env.PORT || cfg.port || 3000;
chatbot.init().catch((e) => console.error(' [db] init lỗi:', e.message));
server.listen(PORT, () => {
  console.log('--------------------------------------------------');
  console.log(' Thịnh Thế Vinh Hoa — server đang chạy');
  console.log(' Trang tuyển dụng : http://localhost:' + PORT + '/');
  console.log(' Trang dữ liệu    : http://localhost:' + PORT + '/tuyen-dung.html');
  console.log(' Landing page     : http://localhost:' + PORT + '/index.html');
  console.log('--------------------------------------------------');
});
