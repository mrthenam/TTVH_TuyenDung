/**
 * Chatbot tuyển dụng — Node built-in + lưu trữ qua db.js (Postgres/RAM).
 * - KB có sẵn + so khớp gần giống
 * - Gemini khi KB không có câu trả lời
 * - Human takeover: nhân viên trả lời -> bot ngưng
 * - Nhớ ngữ cảnh theo sessionId; lưu chat vào Postgres
 * - Nhân viên đăng nhập tài khoản (token)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const db = require('./db');

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
function matchKB(text, threshold) {
  const kb = loadKB(); const un = norm(text); if (!un) return null;
  const ut = new Set(un.split(' '));
  let best = null, bestScore = 0;
  for (const item of kb.qa || []) for (const phrase of item.q || []) {
    const pn = norm(phrase); if (!pn) continue;
    let score; if (un.includes(pn)) score = 1;
    else { const pt = pn.split(' '); score = pt.filter((t) => ut.has(t)).length / pt.length; }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= (threshold || 0.5) ? { answer: best.a, score: bestScore } : null;
}

async function callGemini(cfg, messages) {
  const cb = cfg.chatbot || {};
  const key = cb.geminiApiKey; const model = cb.geminiModel || 'gemini-2.0-flash';
  if (!key || /PASTE|YOUR_/i.test(key)) return null;
  const sys = cb.systemPrompt ||
    'Bạn là trợ lý tuyển dụng thân thiện của Thịnh Thế Vinh Hoa F&B Group (MayCha, Hồng Trà Sữa Tam Hảo, Gà Giòn Sốt Ba Cô Gái, Trà Hú). ' +
    'Trả lời NGẮN GỌN, lịch sự, bằng tiếng Việt, chỉ về tuyển dụng/việc làm. ' +
    'KHÔNG bịa lương/chính sách cụ thể; nếu không chắc, mời khách điền form "Đăng ký ứng tuyển" trên trang hoặc liên hệ HR hr@maycha.com.vn.';
  const hist = messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  const body = JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: hist, generationConfig: { temperature: 0.6, maxOutputTokens: 500 } });
  return new Promise((resolve) => {
    let u; try { u = new URL('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent'); } catch (e) { return resolve(null); }
    u.searchParams.set('key', key);
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 25000 }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => {
        try { const j = JSON.parse(d); const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text; resolve(t ? t.trim() : null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function agentSession(url, req) {
  const token = url.searchParams.get('token') || req.headers['x-agent-token'];
  return token ? db.getSession(token) : null;
}

async function handleChat(req, res, url, loadConfig) {
  const p = url.pathname;
  if (!p.startsWith('/api/chat/') && !p.startsWith('/api/agent/')) return false;
  const cfg = loadConfig() || {};
  const cb = cfg.chatbot || {};

  try {
    // ---------- KHÁCH ----------
    if (p === '/api/chat/config' && req.method === 'GET') {
      const kb = loadKB();
      return sendJson(res, 200, { greeting: kb.greeting || '', zaloLink: cb.zaloLink || '' });
    }
    if (p === '/api/chat/send' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const sid = (b.sessionId || '').toString().slice(0, 80);
      const text = (b.text || '').toString().trim().slice(0, 2000);
      if (!sid) return sendJson(res, 400, { error: 'thiếu sessionId' });
      if (!text) return sendJson(res, 400, { error: 'thiếu nội dung' });
      await db.ensureConv(sid, b.name);
      const userTs = await db.addMessage(sid, 'user', text, null);

      const conv = await db.getConv(sid);
      if (conv && conv.human_mode) return sendJson(res, 200, { ok: true, humanMode: true, userTs });

      let reply = null, from = null;
      const kbHit = matchKB(text, cb.matchThreshold || 0.5);
      if (kbHit) { reply = kbHit.answer; from = 'kb'; }
      if (!reply) { const msgs = await db.getMessages(sid, 0); reply = await callGemini(cfg, msgs); if (reply) from = 'gemini'; }
      if (!reply) { reply = loadKB().fallback || 'Cảm ơn bạn! HR sẽ liên hệ sớm nhất ạ.'; from = 'fallback'; }

      const botTs = await db.addMessage(sid, 'bot', reply, from);
      return sendJson(res, 200, { ok: true, reply, from, ts: botTs, userTs });
    }
    if (p === '/api/chat/poll' && req.method === 'GET') {
      const sid = url.searchParams.get('sessionId') || '';
      const since = +url.searchParams.get('since') || 0;
      const conv = await db.getConv(sid);
      if (!conv) return sendJson(res, 200, { messages: [], humanMode: false, agentTyping: false });
      const messages = await db.getMessages(sid, since);
      return sendJson(res, 200, { messages, humanMode: !!conv.human_mode, agentTyping: db.isTyping(sid) });
    }

    // ---------- NHÂN VIÊN ----------
    if (p === '/api/agent/login' && req.method === 'POST') {
      const b = await readBody(req) || {};
      const a = await db.verifyAgent(b.username, b.password);
      if (!a) return sendJson(res, 401, { error: 'Sai tài khoản hoặc mật khẩu' });
      const token = db.createSession(a.username, a.displayName);
      return sendJson(res, 200, { ok: true, token, displayName: a.displayName, username: a.username });
    }
    if (p.startsWith('/api/agent/')) {
      const sess = agentSession(url, req);
      if (!sess) return sendJson(res, 401, { error: 'Chưa đăng nhập' });

      if (p === '/api/agent/me' && req.method === 'GET') return sendJson(res, 200, { username: sess.username, displayName: sess.displayName });
      if (p === '/api/agent/conversations' && req.method === 'GET') return sendJson(res, 200, { conversations: await db.listConversations() });
      if (p === '/api/agent/messages' && req.method === 'GET') {
        const sid = url.searchParams.get('sessionId') || '';
        const conv = await db.getConv(sid);
        return sendJson(res, 200, { messages: await db.getMessages(sid, 0), humanMode: conv ? !!conv.human_mode : false, name: conv ? conv.name : '' });
      }
      if (p === '/api/agent/send' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const sid = (b.sessionId || '').toString();
        const conv = await db.getConv(sid); if (!conv) return sendJson(res, 404, { error: 'Không thấy hội thoại' });
        const text = (b.text || '').toString().trim().slice(0, 2000);
        if (text) await db.addMessage(sid, 'agent', text, sess.username);
        await db.setHumanMode(sid, true); // nhân viên vào -> ngưng bot
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/agent/mode' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const sid = (b.sessionId || '').toString();
        const conv = await db.getConv(sid); if (!conv) return sendJson(res, 404, { error: 'Không thấy hội thoại' });
        await db.setHumanMode(sid, !!b.humanMode);
        return sendJson(res, 200, { ok: true, humanMode: !!b.humanMode });
      }
      if (p === '/api/agent/typing' && req.method === 'POST') {
        const b = await readBody(req) || {};
        db.setTyping((b.sessionId || '').toString());
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: 'route chat không tồn tại' });
  } catch (e) {
    return sendJson(res, 500, { error: 'Lỗi máy chủ chat: ' + e.message });
  }
}

module.exports = { handleChat, init: db.init };
