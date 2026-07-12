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
const sheet = require('./sheet');
const notify = require('./notify');
const mailer = require('./mailer');

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

/* ======================= LUỒNG "THAY ĐỔI LỊCH ĐÀO TẠO" ======================= */
const flowState = new Map(); // sid -> {step, recordId, phone, name, ts}
const FLOW_TTL = 2 * 3600 * 1000;
const NOTE_DATE = '(Lưu ý: Ngày bắt đầu lớp đào tạo là cố định Thứ 2 hoặc Thứ 5 hàng tuần, bạn vui lòng xem lịch hiện tại rồi chọn một trong hai ngày này. Ví dụ: Bạn phỏng vấn đạt vào ngày Thứ 6 - 18/12, bạn có thể chọn đào tạo vào Thứ 2 - 21/12 HOẶC Thứ 5 - 24/12 tùy theo lịch rảnh của bạn)';

function isChangeScheduleIntent(un) {
  const hasDT = un.includes('dao tao') || un.includes('lich hoc') || un.includes('buoi hoc');
  const hasChange = /(thay doi|doi lich|doi ngay|doi buoi|doi thoi gian|chuyen lich|chuyen ngay|thay lich|cap nhat lich|cap nhat ngay|dieu chinh lich)/.test(un);
  return hasDT && hasChange;
}
function isCancel(un) { return /\b(huy|thoat|bo qua|dung lai|khong can nua)\b/.test(un); }
function isYes(un) { return ['dung', 'chinh xac', 'chuan', 'phai', 'ok', 'oke', 'oki', 'yes', 'xac nhan', 'dung roi', 'chuan roi'].some((w) => un.includes(w)); }
function isNo(un) { return ['sai', 'khong dung', 'khong phai', 'chua dung', 'chua chinh xac', 'nham', 'khong chinh xac'].some((w) => un.includes(w)) || /\bkhong\b/.test(un) || /\bko\b/.test(un); }
function normPhone(p) { let d = (p || '').replace(/\D/g, ''); if (d.startsWith('84') && d.length >= 11) d = '0' + d.slice(2); return d; }
function extractPhone(text) { const d = normPhone(text); return (d.length >= 9 && d.length <= 12) ? d : null; }
function parseDmy(text) {
  const m = (text || '').match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);
  if (!m) return null;
  let dd = +m[1], mm = +m[2], yy = +m[3];
  if (yy < 100) yy += 2000;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12 || yy < 2024 || yy > 2100) return null;
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return { iso: yy + '-' + p2(mm) + '-' + p2(dd), display: p2(dd) + '/' + p2(mm) + '/' + yy };
}
function fmtDate(s) { if (!s) return '(chưa có)'; const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? (m[3] + '/' + m[2] + '/' + m[1]) : s; }
function fmtTs(ts) { const d = new Date(Number(ts)); const p2 = (n) => (n < 10 ? '0' : '') + n; return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
async function findTrainingByPhone(phone) {
  const np = normPhone(phone);
  const rows = await db.listTraining(); // đã sắp xếp mới nhất trước
  return rows.find((r) => normPhone(r.phone) === np) || null;
}

// Trả về chuỗi trả lời nếu luồng xử lý, hoặc null nếu không thuộc luồng (để KB/Gemini xử lý tiếp)
async function handleTrainingFlow(sid, text, cfg) {
  const un = norm(text);
  let st = flowState.get(sid);
  if (st && Date.now() - st.ts > FLOW_TTL) { flowState.delete(sid); st = null; }

  // Bắt đầu luồng
  if (!st) {
    if (isChangeScheduleIntent(un)) {
      flowState.set(sid, { step: 'ask_phone', ts: Date.now() });
      return 'Dạ, bạn muốn thay đổi lịch đào tạo. Bạn vui lòng cho mình xin **số điện thoại** đã dùng khi đăng ký đào tạo để mình tra cứu nhé.';
    }
    return null;
  }

  // Cho phép hủy giữa chừng
  if (isCancel(un)) { flowState.delete(sid); return 'Mình đã hủy yêu cầu thay đổi lịch đào tạo. Bạn cần hỗ trợ gì thêm không ạ?'; }
  st.ts = Date.now();

  if (st.step === 'ask_phone') {
    const phone = extractPhone(text);
    if (!phone) return 'Bạn vui lòng nhập đúng **số điện thoại** đã đăng ký (chỉ gồm chữ số, 10–11 số) để mình tra cứu giúp bạn nhé.';
    const rec = await findTrainingByPhone(phone);
    if (!rec) return 'Mình chưa tìm thấy đăng ký đào tạo nào với số điện thoại **' + phone + '**. Bạn kiểm tra lại và nhập lại **số điện thoại** đã đăng ký giúp mình nhé.';
    st.recordId = rec.id; st.phone = rec.phone; st.name = rec.name; st.step = 'confirm';
    flowState.set(sid, st);
    return 'Mình tìm thấy thông tin đăng ký của bạn:\n'
      + '• Họ và tên: ' + (rec.name || '(trống)') + '\n'
      + '• Số điện thoại: ' + (rec.phone || '(trống)') + '\n'
      + '• Ngày đào tạo đã đăng ký: ' + fmtDate(rec.sess_date) + '\n'
      + '• Thời gian đăng ký: ' + fmtTs(rec.ts) + '\n\n'
      + 'Thông tin trên đã **chính xác** chưa ạ? (trả lời "Đúng" hoặc "Sai")';
  }

  if (st.step === 'confirm') {
    if (isYes(un)) {
      st.step = 'ask_date'; flowState.set(sid, st);
      return 'Bạn muốn đổi sang **ngày đào tạo** nào? Vui lòng nhập theo định dạng ngày/tháng/năm (ví dụ 21/12/2026).\n\n' + NOTE_DATE;
    }
    if (isNo(un)) {
      st.step = 'ask_phone'; st.recordId = null; flowState.set(sid, st);
      return 'Không sao ạ. Bạn vui lòng nhập lại **số điện thoại** đã đăng ký đào tạo để mình tra cứu lại nhé.';
    }
    return 'Bạn xác nhận giúp mình nhé: thông tin trên đã chính xác chưa ạ? Trả lời "Đúng" nếu chính xác, hoặc "Sai" nếu chưa đúng.';
  }

  if (st.step === 'ask_date') {
    const d = parseDmy(text);
    if (!d) return 'Bạn vui lòng nhập **ngày mong muốn** theo định dạng ngày/tháng/năm, ví dụ 21/12/2026.\n\n' + NOTE_DATE;
    try { await db.updateTraining(st.recordId, { sess_date: d.iso }); }
    catch (e) { return 'Xin lỗi, mình chưa cập nhật được lúc này. Bạn vui lòng thử lại sau ít phút hoặc liên hệ HR giúp mình nhé.'; }
    // Cập nhật cột "Ngày Dự Kiến..." trong Excel SharePoint qua webhook (không chặn)
    sheet.pushToSheet(cfg, { action: 'update', phone: st.phone || '', name: st.name || '', sess_date: d.display, sess_date_iso: d.iso }).catch(() => {});
    // Báo Zalo: ứng viên đổi lịch đào tạo (không chặn)
    notify.notifyZalo(cfg, {
      event: 'training_reschedule', name: st.name || '', phone: st.phone || '', newDate: d.display,
      text: '🔔 Ứng viên ĐỔI LỊCH ĐÀO TẠO\n• Họ tên: ' + (st.name || '(trống)') + '\n• SĐT: ' + (st.phone || '') + '\n• Ngày đào tạo mới: ' + d.display
    }).catch(() => {});
    db.addTrainingLog({ name: st.name || '', phone: st.phone || '', action: 'reschedule', detail: 'Thay đổi lịch đào tạo sang ngày ' + d.display }).catch(() => {});
    const name = st.name; flowState.delete(sid);
    return 'Mình đã cập nhật ngày đào tạo của bạn' + (name ? ' (' + name + ')' : '') + ' sang **' + d.display + '** thành công ✅.\nBộ phận Đào tạo sẽ liên hệ xác nhận lại với bạn. Cảm ơn bạn rất nhiều!';
  }

  return null;
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

async function agentSession(url, req) {
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

      // Luồng đặc biệt: thay đổi lịch đào tạo (ưu tiên trước KB/Gemini)
      const flowReply = await handleTrainingFlow(sid, text, cfg);
      if (flowReply !== null) {
        const ts = await db.addMessage(sid, 'bot', flowReply, 'flow');
        return sendJson(res, 200, { ok: true, reply: flowReply, from: 'flow', ts, userTs });
      }

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
      const token = await db.createSession(a.username, a.displayName);
      return sendJson(res, 200, { ok: true, token, displayName: a.displayName, username: a.username });
    }
    if (p.startsWith('/api/agent/')) {
      const sess = await agentSession(url, req);
      if (!sess) return sendJson(res, 401, { error: 'Chưa đăng nhập' });
      // Quyền hiệu lực của người đang đăng nhập (admin = toàn quyền mọi khối)
      const mePerm = await db.getAgentPerms(sess.username);
      const canManageDept = (dept) => mePerm.isAdmin || mePerm.depts.indexOf(db.normDept(dept)) >= 0;

      if (p === '/api/agent/me' && req.method === 'GET') {
        return sendJson(res, 200, { username: sess.username, displayName: sess.displayName, isAdmin: mePerm.isAdmin, perms: mePerm.depts, allDepts: db.JOB_DEPTS });
      }
      if (p === '/api/agent/sheetinfo' && req.method === 'GET') return sendJson(res, 200, { viewUrl: (cfg.sheet && cfg.sheet.viewUrl) || '', googleClientId: (cfg.sheet && cfg.sheet.googleClientId) || '' });
      // Lịch sử chỉnh sửa / thông báo
      if (p === '/api/agent/log' && req.method === 'GET') return sendJson(res, 200, { rows: await db.listTrainingLog(+url.searchParams.get('limit') || 100) });

      // Việc làm (tuyển dụng)
      if (p === '/api/agent/jobs' && req.method === 'GET') return sendJson(res, 200, { rows: await db.listJobs() });
      if (p === '/api/agent/jobs' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const j = {
          title: (b.title || '').toString().trim(),
          salary: (b.salary || '').toString().trim(),
          location: (b.location || '').toString().trim(),
          deadline: (b.deadline || '').toString().trim(),
          jobtype: (b.jobtype || '').toString().trim(),
          dept: db.normDept(b.dept),
          description: (b.description || '').toString()
        };
        if (!j.title) return sendJson(res, 400, { error: 'Thiếu tên công việc' });
        // Phân quyền: nhân viên chỉ được đăng/sửa tin thuộc khối được cấp
        if (!mePerm.isAdmin) {
          if (!j.dept || db.JOB_DEPTS.indexOf(j.dept) === -1) return sendJson(res, 400, { error: 'Vui lòng chọn Khối hợp lệ cho tin tuyển dụng.' });
          if (!canManageDept(j.dept)) return sendJson(res, 403, { error: 'Bạn không có quyền đăng/sửa tin thuộc khối "' + j.dept + '".' });
        }
        if (b.id) {
          // Khi sửa: kiểm tra cả khối hiện tại của tin (tránh sửa tin ngoài quyền hoặc dời tin sang khối không được cấp)
          if (!mePerm.isAdmin) {
            const cur = await db.getJob(b.id);
            if (cur && cur.dept && !canManageDept(cur.dept)) return sendJson(res, 403, { error: 'Bạn không có quyền sửa tin thuộc khối "' + cur.dept + '".' });
          }
          await db.updateJob(b.id, j); return sendJson(res, 200, { ok: true, id: Number(b.id) });
        }
        const id = await db.addJob(j); return sendJson(res, 200, { ok: true, id });
      }
      if (p === '/api/agent/jobs/delete' && req.method === 'POST') {
        const b = await readBody(req) || {};
        if (!mePerm.isAdmin) {
          const cur = await db.getJob(b.id);
          if (cur && cur.dept && !canManageDept(cur.dept)) return sendJson(res, 403, { error: 'Bạn không có quyền xóa tin thuộc khối "' + cur.dept + '".' });
        }
        await db.deleteJob(b.id); return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/agent/jobs/reorder' && req.method === 'POST') {
        const b = await readBody(req) || {}; await db.reorderJobs(b.ids || []); return sendJson(res, 200, { ok: true });
      }

      // Cấu hình form đào tạo
      if (p === '/api/agent/trainingform' && req.method === 'GET') {
        const v = await db.getSetting('trainingform');
        return sendJson(res, 200, (v && JSON.parse(v)) || {});
      }
      if (p === '/api/agent/trainingform' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const cfg = {
          title: (b.title || '').toString(),
          desc: (b.desc || '').toString(),
          dateNote: (b.dateNote || '').toString(),
          positions: Array.isArray(b.positions) ? b.positions.map(String).map(s => s.trim()).filter(Boolean) : [],
          modes: Array.isArray(b.modes) ? b.modes.map(String).map(s => s.trim()).filter(Boolean) : []
        };
        await db.setSetting('trainingform', JSON.stringify(cfg));
        return sendJson(res, 200, { ok: true });
      }

      // Cấu hình form ứng tuyển (index.html)
      if (p === '/api/agent/applyform' && req.method === 'GET') {
        const v = await db.getSetting('applyform');
        return sendJson(res, 200, (v && JSON.parse(v)) || {});
      }
      if (p === '/api/agent/applyform' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const arr = (x) => Array.isArray(x) ? x.map(String).map(s => s.trim()).filter(Boolean) : [];
        // 3 khối là khóa CỐ ĐỊNH — điều khiển cascading + định tuyến 1Office, không nhận khóa lạ.
        const GROUPS = ['Cửa hàng', 'Khối Văn Phòng', 'Khối Kho & Xưởng Sản Xuất'];
        const posIn = (b.positions && typeof b.positions === 'object') ? b.positions : {};
        const positions = {};
        GROUPS.forEach((g) => { positions[g] = arr(posIn[g]); });
        const cfg = {
          title: (b.title || '').toString(),
          desc: (b.desc || '').toString(),
          genders: arr(b.genders),
          workareas: arr(b.workareas),
          brands: arr(b.brands),
          positions
        };
        await db.setSetting('applyform', JSON.stringify(cfg));
        return sendJson(res, 200, { ok: true });
      }

      // Cấu hình EMAIL tự động (bật/tắt, chế độ test, danh sách test, tiêu đề, nội dung)
      if (p === '/api/agent/emailcfg' && req.method === 'GET') {
        const c = await mailer.getEmailCfg();
        const st = mailer.mailStatus(cfg); // { provider, fromEmail, ready } — KHÔNG lộ khóa
        return sendJson(res, 200, Object.assign({}, c, { _provider: st.provider, _fromEmail: st.fromEmail, _ready: st.ready }));
      }
      if (p === '/api/agent/emailcfg' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const testList = String(b.testList || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
        const c = {
          enabled: !!b.enabled,
          testMode: b.testMode !== false,
          testList: testList.length ? testList : ['thenam2703@gmail.com'],
          fromName: (b.fromName || 'Thịnh Thế Vinh Hoa').toString().trim(),
          subject: (b.subject || '').toString(),
          body: (b.body || '').toString()
        };
        await db.setSetting('emailcfg', JSON.stringify(c));
        return sendJson(res, 200, { ok: true });
      }
      // Gửi email THỬ ngay tới 1 địa chỉ (bắt buộc nằm trong danh sách test để an toàn)
      if (p === '/api/agent/email/test' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const to = (b.to || '').toString().trim();
        if (!to) return sendJson(res, 400, { error: 'Vui lòng nhập email nhận thử.' });
        const c = await mailer.getEmailCfg();
        const allow = (c.testList || []).map((x) => String(x).trim().toLowerCase());
        if (allow.indexOf(to.toLowerCase()) === -1) {
          return sendJson(res, 400, { error: 'Email này chưa nằm trong danh sách test. Hãy thêm vào "Danh sách email test" và lưu trước khi gửi thử.' });
        }
        const vars = { ten: (b.demoName || '').toString().trim() || 'Nguyễn Văn A (tên mẫu)' };
        const r = await mailer.sendMail(cfg, {
          to,
          subject: mailer.applyTemplate(c.subject, vars),
          bodyText: mailer.applyTemplate(c.body, vars),
          fromName: c.fromName
        });
        return sendJson(res, 200, r);
      }

      // Khoảnh khắc Vinh Hoa (gallery)
      if (p === '/api/agent/gallery' && req.method === 'GET') return sendJson(res, 200, { rows: await db.listGallery() });
      if (p === '/api/agent/gallery' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const u = (b.url || '').toString().trim();
        if (!u) return sendJson(res, 400, { error: 'Thiếu ảnh' });
        const id = await db.addGallery(u);
        return sendJson(res, 200, { ok: true, id });
      }
      if (p === '/api/agent/gallery' && req.method === 'DELETE') {
        const id = url.searchParams.get('id');
        const n = await db.deleteGallery(id);
        return sendJson(res, 200, { ok: n > 0, deleted: n });
      }
      if (p === '/api/agent/gallery/reorder' && req.method === 'POST') {
        const b = await readBody(req) || {};
        await db.reorderGallery(Array.isArray(b.ids) ? b.ids : []);
        return sendJson(res, 200, { ok: true });
      }

      // Thông tin tuyển dụng theo thương hiệu
      if (p === '/api/agent/recruitment' && req.method === 'GET') return sendJson(res, 200, { rows: await db.listRecruitment() });
      if (p === '/api/agent/recruitment' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const brand = (b.brand || '').toString().trim();
        if (!brand) return sendJson(res, 400, { error: 'Thiếu thương hiệu' });
        await db.setRecruitment(brand, (b.name || '').toString(), (b.title || '').toString(), (b.content || '').toString());
        return sendJson(res, 200, { ok: true });
      }
      // Lưu/đọc 1 Google Sheet duy nhất (id + url) đã tạo
      if (p === '/api/agent/gsheet' && req.method === 'GET') return sendJson(res, 200, { id: await db.getSetting('gsheet_id'), url: await db.getSetting('gsheet_url') });
      if (p === '/api/agent/gsheet' && req.method === 'POST') {
        const b = await readBody(req) || {};
        await db.setSetting('gsheet_id', (b.id || '').toString());
        await db.setSetting('gsheet_url', (b.url || '').toString());
        return sendJson(res, 200, { ok: true });
      }

      // Quản lý nhân viên
      if (p === '/api/agent/staff' && req.method === 'GET') return sendJson(res, 200, { agents: await db.listAgents(), me: sess.username, myIsAdmin: mePerm.isAdmin, allDepts: db.JOB_DEPTS });
      if (p === '/api/agent/create' && req.method === 'POST') {
        if (!mePerm.isAdmin) return sendJson(res, 403, { error: 'Chỉ tài khoản quản trị mới được thêm nhân viên.' });
        const b = await readBody(req) || {};
        const username = (b.username || '').toString().trim().toLowerCase();
        const password = (b.password || '').toString();
        const displayName = (b.displayName || '').toString().trim() || username;
        const perms = Array.isArray(b.perms) ? b.perms : []; // db.createAgent tự chuẩn hóa về đúng tên khối
        if (!/^[a-z0-9._-]{3,}$/.test(username)) return sendJson(res, 400, { error: 'Tên đăng nhập tối thiểu 3 ký tự, chỉ gồm chữ thường/số/._-' });
        if (password.length < 4) return sendJson(res, 400, { error: 'Mật khẩu tối thiểu 4 ký tự' });
        const list = await db.listAgents();
        if (list.some((a) => a.username === username)) return sendJson(res, 409, { error: 'Tên đăng nhập "' + username + '" đã tồn tại' });
        await db.createAgent(username, password, displayName, { perms: perms });
        return sendJson(res, 200, { ok: true });
      }
      // Cập nhật quyền đăng/sửa tin theo khối cho 1 nhân viên (chỉ admin)
      if (p === '/api/agent/staff/perms' && req.method === 'POST') {
        if (!mePerm.isAdmin) return sendJson(res, 403, { error: 'Chỉ tài khoản quản trị mới được phân quyền.' });
        const b = await readBody(req) || {};
        const username = (b.username || '').toString().trim().toLowerCase();
        const perms = Array.isArray(b.perms) ? b.perms : []; // db.updateAgentPerms tự chuẩn hóa
        const target = await db.getAgentPerms(username);
        if (target.isAdmin) return sendJson(res, 400, { error: 'Tài khoản quản trị luôn có toàn quyền, không cần phân quyền.' });
        const n = await db.updateAgentPerms(username, perms);
        if (!n) return sendJson(res, 404, { error: 'Không tìm thấy nhân viên.' });
        return sendJson(res, 200, { ok: true });
      }

      // Quản lý chiến dịch theo thương hiệu
      if (p === '/api/agent/campaigns' && req.method === 'GET') return sendJson(res, 200, { rows: await db.listBrandCampaigns() });
      if (p === '/api/agent/campaigns' && req.method === 'POST') {
        const b = await readBody(req) || {};
        const brand = (b.brand || '').toString().trim();
        if (!brand) return sendJson(res, 400, { error: 'Thiếu tên thương hiệu' });
        await db.setBrandCampaign(brand, (b.code || '').toString().trim(), (b.name || '').toString().trim());
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/agent/campaigns' && req.method === 'DELETE') {
        const brand = url.searchParams.get('brand') || '';
        if (!brand) return sendJson(res, 400, { error: 'Thiếu tên thương hiệu' });
        const n = await db.deleteBrandCampaign(brand);
        return sendJson(res, 200, { ok: n > 0, deleted: n });
      }
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
