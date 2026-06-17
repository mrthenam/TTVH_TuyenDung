/**
 * Chatbot tuyển dụng — Node built-in, không cần dependency.
 * - KB có sẵn + so khớp gần giống (bỏ dấu, trùng từ khóa)
 * - Gemini API khi KB không có câu trả lời
 * - Human takeover: nhân viên trả lời -> bot ngưng
 * - Nhớ ngữ cảnh theo sessionId từng khách
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const conversations = new Map(); // sessionId -> { id, name, messages, humanMode, updatedAt, agentTypingAt }

function sendJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(b);
}
function readBody(req) {
  return new Promise((r) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { r(JSON.parse(raw || '{}')); } catch (e) { r(null); } });
  });
}

// Chuẩn hóa tiếng Việt: bỏ dấu, đ->d, bỏ ký tự đặc biệt
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

let KB = null, KBmtime = 0;
function loadKB() {
  try {
    const p = path.join(__dirname, 'chatbot-kb.json');
    const st = fs.statSync(p);
    if (!KB || st.mtimeMs !== KBmtime) { KB = JSON.parse(fs.readFileSync(p, 'utf8')); KBmtime = st.mtimeMs; }
  } catch (e) { KB = KB || { qa: [], greeting: '', fallback: '' }; }
  return KB;
}

// Tìm câu trả lời gần giống nhất; trả về { answer, score } hoặc null
function matchKB(text, threshold) {
  const kb = loadKB();
  const un = norm(text); if (!un) return null;
  const ut = new Set(un.split(' '));
  let best = null, bestScore = 0;
  for (const item of kb.qa || []) {
    for (const phrase of item.q || []) {
      const pn = norm(phrase); if (!pn) continue;
      let score;
      if (un.includes(pn)) score = 1;
      else { const pt = pn.split(' '); const m = pt.filter((t) => ut.has(t)).length; score = m / pt.length; }
      if (score > bestScore) { bestScore = score; best = item; }
    }
  }
  return bestScore >= (threshold || 0.5) ? { answer: best.a, score: bestScore } : null;
}

function getConv(sessionId, name) {
  let c = conversations.get(sessionId);
  if (!c) { c = { id: sessionId, name: name || 'Khách', messages: [], humanMode: false, createdAt: Date.now(), updatedAt: Date.now(), agentTypingAt: 0 }; conversations.set(sessionId, c); }
  if (name && (c.name === 'Khách' || !c.name)) c.name = name;
  return c;
}

// Gọi Gemini với toàn bộ ngữ cảnh hội thoại
async function callGemini(cfg, conv) {
  const cb = cfg.chatbot || {};
  const key = cb.geminiApiKey;
  const model = cb.geminiModel || 'gemini-2.0-flash';
  if (!key || /PASTE|YOUR_/i.test(key)) return null;
  const sys = cb.systemPrompt ||
    'Bạn là trợ lý tuyển dụng thân thiện của Thịnh Thế Vinh Hoa F&B Group (các thương hiệu MayCha, Hồng Trà Sữa Tam Hảo, Gà Giòn Sốt Ba Cô Gái, Trà Hú). ' +
    'Trả lời NGẮN GỌN, lịch sự, bằng tiếng Việt, chỉ xoay quanh tuyển dụng/việc làm. ' +
    'KHÔNG bịa số liệu lương/chính sách cụ thể; nếu không chắc, mời khách điền form "Đăng ký ứng tuyển" trên trang hoặc liên hệ HR hr@maycha.com.vn.';
  const hist = conv.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: sys }] },
    contents: hist,
    generationConfig: { temperature: 0.6, maxOutputTokens: 500 }
  });
  return new Promise((resolve) => {
    let u;
    try { u = new URL('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'); }
    catch (e) { return resolve(null); }
    u.searchParams.set('key', key);
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text;
          resolve(t ? t.trim() : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function agentAuth(url, cfg) {
  const want = (cfg.chatbot && cfg.chatbot.agentKey) || 'ttvh-agent';
  const got = url.searchParams.get('key');
  return !!got && got === want;
}

async function handleChat(req, res, url, loadConfig) {
  const p = url.pathname;
  if (!p.startsWith('/api/chat/') && !p.startsWith('/api/agent/')) return false;
  const cfg = loadConfig() || {};
  const cb = cfg.chatbot || {};

  // ---------- KHÁCH HÀNG ----------
  if (p === '/api/chat/greeting' && req.method === 'GET') {
    const kb = loadKB();
    return sendJson(res, 200, { greeting: kb.greeting || '' });
  }
  if (p === '/api/chat/send' && req.method === 'POST') {
    const b = await readBody(req) || {};
    const sid = (b.sessionId || '').toString().slice(0, 80);
    const text = (b.text || '').toString().trim().slice(0, 2000);
    if (!sid) return sendJson(res, 400, { error: 'thiếu sessionId' });
    if (!text) return sendJson(res, 400, { error: 'thiếu nội dung' });
    const conv = getConv(sid, b.name);
    const userTs = Date.now();
    conv.messages.push({ role: 'user', text, ts: userTs });
    conv.updatedAt = userTs;

    // Nhân viên đang phụ trách -> bot KHÔNG trả lời, để nhân viên trả lời
    if (conv.humanMode) return sendJson(res, 200, { ok: true, humanMode: true, userTs });

    // Bot tự trả lời: KB trước, không có thì Gemini
    let reply = null, from = null;
    const kb = matchKB(text, cb.matchThreshold || 0.5);
    if (kb) { reply = kb.answer; from = 'kb'; }
    if (!reply) { reply = await callGemini(cfg, conv); if (reply) from = 'gemini'; }
    if (!reply) { reply = (loadKB().fallback) || 'Cảm ơn bạn! HR sẽ liên hệ sớm nhất ạ.'; from = 'fallback'; }

    const botTs = Date.now();
    conv.messages.push({ role: 'bot', text: reply, ts: botTs, from });
    conv.updatedAt = botTs;
    return sendJson(res, 200, { ok: true, reply, from, ts: botTs, userTs });
  }
  if (p === '/api/chat/poll' && req.method === 'GET') {
    const sid = url.searchParams.get('sessionId') || '';
    const since = +url.searchParams.get('since') || 0;
    const conv = conversations.get(sid);
    if (!conv) return sendJson(res, 200, { messages: [], humanMode: false, agentTyping: false });
    const messages = conv.messages.filter((m) => m.ts > since).map((m) => ({ role: m.role, text: m.text, ts: m.ts }));
    const agentTyping = (Date.now() - conv.agentTypingAt) < 8000;
    return sendJson(res, 200, { messages, humanMode: conv.humanMode, agentTyping });
  }

  // ---------- NHÂN VIÊN (cần key) ----------
  if (p.startsWith('/api/agent/')) {
    if (!agentAuth(url, cfg)) return sendJson(res, 401, { error: 'Sai key nhân viên' });

    if (p === '/api/agent/conversations' && req.method === 'GET') {
      const list = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => {
        const last = c.messages[c.messages.length - 1];
        return { id: c.id, name: c.name, humanMode: c.humanMode, updatedAt: c.updatedAt, count: c.messages.length, last: last ? last.text.slice(0, 70) : '', lastRole: last ? last.role : '' };
      });
      return sendJson(res, 200, { conversations: list });
    }
    if (p === '/api/agent/messages' && req.method === 'GET') {
      const conv = conversations.get(url.searchParams.get('sessionId') || '');
      return sendJson(res, 200, { messages: conv ? conv.messages : [], humanMode: conv ? conv.humanMode : false, name: conv ? conv.name : '' });
    }
    if (p === '/api/agent/send' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const conv = conversations.get((b.sessionId || '').toString());
      if (!conv) return sendJson(res, 404, { error: 'Không thấy hội thoại' });
      const text = (b.text || '').toString().trim().slice(0, 2000);
      if (text) conv.messages.push({ role: 'agent', text, ts: Date.now() });
      conv.humanMode = true; // nhân viên vào -> ngưng bot
      conv.updatedAt = Date.now();
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/agent/mode' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const conv = conversations.get((b.sessionId || '').toString());
      if (!conv) return sendJson(res, 404, { error: 'Không thấy hội thoại' });
      conv.humanMode = !!b.humanMode;
      conv.updatedAt = Date.now();
      return sendJson(res, 200, { ok: true, humanMode: conv.humanMode });
    }
    if (p === '/api/agent/typing' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const conv = conversations.get((b.sessionId || '').toString());
      if (conv) conv.agentTypingAt = Date.now();
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'route chat không tồn tại' });
}

// Dọn hội thoại cũ (>24h không hoạt động)
setInterval(() => {
  const now = Date.now();
  for (const [k, c] of conversations) if (now - c.updatedAt > 24 * 3600 * 1000) conversations.delete(k);
}, 3600 * 1000).unref();

module.exports = { handleChat };
