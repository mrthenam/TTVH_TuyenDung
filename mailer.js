/**
 * Gửi email tự động cho ứng viên đăng ký đào tạo — SMTP qua TLS (module built-in 'tls').
 * KHÔNG cần thư viện ngoài.
 *
 * Cấu hình tài khoản gửi (ưu tiên biến môi trường khi deploy):
 *   - user: SMTP_USER  hoặc  config.email.user  (mặc định thinhthevinhhoa@gmail.com)
 *   - pass: SMTP_PASS  hoặc  config.email.pass  (App Password 16 ký tự của Gmail — KHÔNG phải mật khẩu thường)
 *
 * Bật/tắt + nội dung + chế độ test: lưu ở settings key 'emailcfg' (chỉnh trong dashboard).
 * Fire-and-forget: mọi lỗi được nuốt, KHÔNG làm hỏng luồng đăng ký.
 */
const tls = require('tls');
const https = require('https');
const db = require('./db');

const EMAIL_DEFAULTS = {
  enabled: false,          // gửi email tự động khi có đăng ký mới
  testMode: true,          // CHỈ gửi tới các email trong testList (an toàn khi thử nghiệm)
  testList: ['thenam2703@gmail.com'],
  fromName: 'Thịnh Thế Vinh Hoa',
  subject: 'Thư mời tham gia Khóa Đào Tạo Đầu Vào — Thịnh Thế Vinh Hoa',
  body: [
    'Dear {{ten}},',
    '',
    'Chúc mừng các bạn đã phỏng vấn thành công và chuẩn bị gia nhập đại gia đình Thịnh Thế Vinh Hoa với các thương hiệu như: MayCha, Tam Hảo, Trà Hú, Gà Giòn Sốt Ba Cô Gái, …',
    '',
    'Như đã trao đổi với các bạn, trước khi bắt đầu công việc tại cửa hàng, các bạn cần tham gia khóa đào tạo đầu vào để có thể nắm bắt những nội dung cần thiết và đảm bảo chất lượng dịch vụ khi làm việc tại cửa hàng.',
    'Khóa đào tạo dự kiến kéo dài khoảng 02 ngày, cố định là Thứ 2 + Thứ 3 VÀ Thứ 5 + Thứ 6 hàng tuần (Các bạn chỉ cần tham gia một trong hai khóa này, không cần tham gia cả hai). Ngày Thứ 2 và Thứ 5 là học về Lý Thuyết, ngày Thứ 3 và Thứ 6 sẽ học về Thực Hành.',
    '',
    'Chi tiết về Lịch học Khóa đào tạo tiếp theo như sau:',
    '',
    '1. Đối với các bạn học Trực tiếp tại Phòng Đào Tạo (Các bạn ở TP. HCM):',
    '* Địa điểm: Cửa Hàng MayCha tại số 21 Rạch Bùng Binh, Phường Nhiêu Lộc (Quận 3), TP. HCM (Tầng trệt là cửa hàng, tầng 2 và tầng 3 là phòng học)',
    '* Ngày bắt đầu học: Thứ 5 – 02/07/2026',
    '* Thời gian học: Dự kiến từ 9h sáng đến 17h chiều (Nghỉ trưa 1h và buổi chiều có thể kết thúc sớm hơn)',
    '* Địa điểm gửi xe: Bạn có thể gửi xe tại Tòa Nhà Viettel Tower (Số 285 Cách Mạng Tháng Tám) hoặc Bãi giữ xe của Ga Xe Lửa (Số 1 Nguyễn Thông) rồi đi bộ đến Cửa hàng (Cách bãi xe khoảng 200m)',
    '* Hướng dẫn: Khi đến cửa hàng bạn cứ đi thẳng vào trong rồi đi theo cầu theo lên lầu 2 để vào phòng học.',
    '* Người hỗ trợ: Khi cần hỗ trợ, các bạn có thể liên hệ anh / chị nhân sự đang trao đổi công việc hoặc liên hệ Chị Thảo – 0846.013.017 / Anh Nhơn – 0933.871.658',
    '',
    '2. Đối với các bạn học Online (Các bạn ở khu vực Tỉnh hoặc ở các Quận/Huyện xa):',
    '* Link tham gia: https://teams.microsoft.com/meet/41339908778497?p=oO3OTbVhaIdMelI7FZ',
    '* Ngày bắt đầu học: Thứ 5 – 02/07/2026',
    '* Thời gian học: Dự kiến từ 9h sáng đến 17h chiều (Nghỉ trưa 1h và buổi chiều có thể kết thúc sớm hơn)',
    '',
    '3. Các thông tin cần lưu ý:',
    '* Trong thời gian học, các bạn vẫn được tính lương, mong các bạn tham gia đầy đủ và cố gắng tập trung.',
    '* Sau khi hoàn thành chương trình học, các bạn hãy chủ động liên hệ với anh chị Quản lý (Người phỏng vấn các bạn tại cửa hàng) để hẹn lịch nhận việc ở cửa hàng.',
    '* Khi đến cửa hàng nhận việc ngày đầu tiên, các bạn hãy chủ động nhờ anh chị Quản lý chấm bù hai ngày công mà các bạn đã tham gia đào tạo (Thao tác chấm bù công trên App 1Office).',
    '* Sau khi nhờ Quản lý chấm bù công, các bạn nhớ chủ động chấm công khi làm việc tại cửa hàng để được ghi nhận đầy đủ bảng công và tránh ảnh hưởng tiền lương của mình.',
    '* Thao tác chấm công trên App 1Office sẽ được hướng dẫn trong buổi đào tạo, nhưng nếu chưa rõ bạn có thể nhờ Quản lý hướng dẫn lại. Hãy chủ động để đảm bảo “Đủ công = Đủ lương”',
    '',
    'Chúc các bạn học tập hiệu quả và nhiều niềm vui!'
  ].join('\n')
};

async function getEmailCfg() {
  let saved = {};
  try { const v = await db.getSetting('emailcfg'); if (v) saved = JSON.parse(v); } catch (e) {}
  const c = Object.assign({}, EMAIL_DEFAULTS, saved);
  if (!Array.isArray(c.testList)) c.testList = EMAIL_DEFAULTS.testList.slice();
  return c;
}

function smtpCreds(cfg) {
  const e = (cfg && cfg.email) || {};
  const user = process.env.SMTP_USER || e.user || 'thinhthevinhhoa@gmail.com';
  const pass = process.env.SMTP_PASS || e.pass || '';
  return { user, pass, host: process.env.SMTP_HOST || e.host || 'smtp.gmail.com', port: +(process.env.SMTP_PORT || e.port || 465) };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function linkify(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#c69320;text-decoration:underline">$1</a>');
}
const GOLD = '#c69320';
// Chuyển văn bản thường (viết trong dashboard) -> HTML có định dạng:
//  - dòng bắt đầu "* " -> gạch đầu dòng
//  - dòng dạng "1. ..." / "A. ..." (không có "* ") -> tiêu đề mục, in đậm màu vàng đồng
//  - dòng trống -> khoảng cách đoạn
//  - còn lại -> đoạn văn thường
function bodyToHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  let html = '', ulOpen = false;
  function closeUl() { if (ulOpen) { html += '</ul>'; ulOpen = false; } }
  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) { closeUl(); html += '<div style="height:12px"></div>'; return; }
    if (/^\*\s+/.test(line)) {
      if (!ulOpen) { html += '<ul style="margin:4px 0 14px;padding-left:22px">'; ulOpen = true; }
      html += '<li style="margin-bottom:6px">' + linkify(esc(line.replace(/^\*\s+/, ''))) + '</li>';
      return;
    }
    closeUl();
    if (/^(\d+|[A-ZĐ])\.\s+\S/.test(line)) {
      html += '<div style="font-weight:700;color:' + GOLD + ';margin:18px 0 8px;font-size:16px">' + linkify(esc(line)) + '</div>';
      return;
    }
    html += '<p style="margin:0 0 8px">' + linkify(esc(line)) + '</p>';
  });
  closeUl();
  return html;
}
// Bọc nội dung trong khung email có thương hiệu (banner logo + footer).
function textToHtml(text) {
  const logoUrl = 'https://vieclamthinhthevinhhoa.com.vn/images/logo-ttvh.jpg';
  return '<div style="background:#fbf7ef;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(198,147,32,.15)">'
    + '<div style="background:linear-gradient(135deg,#e6c34d 0%,#c69320 100%);padding:26px 32px;text-align:center">'
    + '<img src="' + logoUrl + '" width="52" height="52" style="border-radius:12px;display:block;margin:0 auto 10px;border:2px solid rgba(255,255,255,.6)" alt="Thịnh Thế Vinh Hoa" />'
    + '<div style="color:#ffffff;font-weight:800;font-size:19px;letter-spacing:.02em">THỊNH THẾ VINH HOA</div>'
    + '<div style="color:rgba(255,255,255,.85);font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;margin-top:2px">F&amp;B Group</div>'
    + '</div>'
    + '<div style="padding:30px 32px;color:#2a1810;font-size:15px;line-height:1.7">' + bodyToHtml(text) + '</div>'
    + '<div style="padding:18px 32px;border-top:1px solid #eadfce;background:#fff8f0;color:#8b7060;font-size:12px;text-align:center">'
    + 'Email tự động từ hệ thống tuyển dụng Thịnh Thế Vinh Hoa F&amp;B Group.<br>'
    + '<a href="https://vieclamthinhthevinhhoa.com.vn" style="color:' + GOLD + ';text-decoration:none">vieclamthinhthevinhhoa.com.vn</a>'
    + '</div></div></div>';
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }
function encHeader(s) { return '=?UTF-8?B?' + b64(s) + '?='; }

// Client SMTP tối giản: đọc reply {code, text}; reject rõ ràng khi lỗi/đóng kết nối.
function smtpConnect(host, port) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = tls.connect({ host, port, servername: host });
    sock.setEncoding('utf8');
    sock.setTimeout(25000);
    let buf = '';
    let waiter = null; // { res, rej }
    function flush() {
      if (!waiter) return;
      const m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/);
      if (m) {
        const code = parseInt(m[1], 10);
        const text = buf.slice(0, m[0].length).replace(/\s+/g, ' ').trim();
        buf = buf.slice(m[0].length);
        const w = waiter; waiter = null; w.res({ code, text });
      }
    }
    function fail(err) {
      if (waiter) { const w = waiter; waiter = null; w.rej(err); }
      if (!settled) { settled = true; reject(err); }
    }
    sock.on('data', (d) => { buf += d; flush(); });
    sock.on('timeout', () => { sock.destroy(); fail(new Error('timeout (' + host + ':' + port + ') — có thể nhà cung cấp chặn cổng SMTP ra ngoài')); });
    sock.on('error', (e) => fail(new Error('kết nối lỗi: ' + (e.code || e.message))));
    sock.on('close', () => { if (waiter) { const w = waiter; waiter = null; w.rej(new Error('kết nối bị đóng đột ngột')); } });
    const api = {
      sock,
      read() { return new Promise((res, rej) => { waiter = { res, rej }; flush(); }); },
      cmd(line) { sock.write(line + '\r\n'); return api.read(); },
      write(raw) { sock.write(raw); },
      close() { try { sock.end(); } catch (e) {} }
    };
    sock.once('secureConnect', () => { settled = true; resolve(api); });
  });
}

// ---- SMTP (fallback; KHÔNG dùng được trên Railway vì bị chặn cổng SMTP) ----
async function smtpSend(cfg, { to, subject, html, fromName }) {
  const { user, pass, host, port } = smtpCreds(cfg);
  if (!pass) return { ok: false, error: 'Chưa cấu hình mật khẩu SMTP.' };
  const headers = [
    'From: ' + encHeader(fromName || 'Thịnh Thế Vinh Hoa') + ' <' + user + '>',
    'To: <' + to + '>',
    'Subject: ' + encHeader(subject || '(không tiêu đề)'),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Date: ' + new Date().toUTCString()
  ].join('\r\n');
  const message = headers + '\r\n\r\n' + wrap76(b64(html));
  const safe = message.replace(/\r\n\./g, '\r\n..'); // dot-stuffing
  let c, stage = 'connect';
  try {
    c = await smtpConnect(host, port);
    let r;
    stage = 'greeting'; r = await c.read(); if (r.code !== 220) throw new Error(r.text);
    stage = 'EHLO'; r = await c.cmd('EHLO ttvh.local'); if (r.code !== 250) throw new Error(r.text);
    stage = 'AUTH'; r = await c.cmd('AUTH LOGIN'); if (r.code !== 334) throw new Error(r.text);
    stage = 'user'; r = await c.cmd(b64(user)); if (r.code !== 334) throw new Error(r.text);
    stage = 'pass'; r = await c.cmd(b64(pass)); if (r.code !== 235) throw new Error('sai mật khẩu? ' + r.text);
    stage = 'MAIL FROM'; r = await c.cmd('MAIL FROM:<' + user + '>'); if (r.code !== 250) throw new Error(r.text);
    stage = 'RCPT TO'; r = await c.cmd('RCPT TO:<' + to + '>'); if (r.code !== 250 && r.code !== 251) throw new Error(r.text);
    stage = 'DATA'; r = await c.cmd('DATA'); if (r.code !== 354) throw new Error(r.text);
    stage = 'send'; c.write(safe + '\r\n.\r\n'); r = await c.read(); if (r.code !== 250) throw new Error(r.text);
    c.close();
    return { ok: true };
  } catch (e) {
    if (c) c.close();
    return { ok: false, error: '[' + stage + '] ' + (e && (e.message || e.code) ? (e.message || e.code) : 'lỗi không xác định') };
  }
}

// ---- Resend (API HTTPS — dùng được trên Railway) ----
function resendSend({ apiKey, from, to, subject, html }) {
  return new Promise((resolve) => {
    if (!apiKey) return resolve({ ok: false, error: 'Resend: thiếu API key.' });
    let body;
    try { body = JSON.stringify({ from, to: [to], subject: subject || '(không tiêu đề)', html }); }
    catch (e) { return resolve({ ok: false, error: 'Resend: lỗi tạo nội dung — ' + e.message }); }
    let req;
    try {
      req = https.request('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + String(apiKey).trim(), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 20000
      }, (res) => {
        let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null; try { j = JSON.parse(d); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && j && j.id) return resolve({ ok: true, id: j.id });
          const msg = (j && (j.message || (j.error && (j.error.message || j.error)) || j.name)) || ('HTTP ' + res.statusCode + ' ' + (d ? d.slice(0, 250) : '(rỗng)'));
          resolve({ ok: false, error: 'Resend: ' + msg });
        });
      });
    } catch (e) {
      return resolve({ ok: false, error: 'Resend: lỗi tạo request — ' + (e && (e.message || e.code) || 'không rõ') });
    }
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Resend: timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: 'Resend: ' + (e && (e.message || e.code) || 'lỗi kết nối không rõ') }));
    req.write(body); req.end();
  });
}

// Chọn nhà cung cấp: có RESEND_API_KEY -> Resend (HTTPS); ngược lại -> SMTP.
function mailProvider(cfg) {
  const e = (cfg && cfg.email) || {};
  const resendKey = process.env.RESEND_API_KEY || e.resendKey || '';
  const fromEmail = process.env.EMAIL_FROM || e.fromEmail || 'admin@vieclamthinhthevinhhoa.com.vn';
  if (resendKey) return { name: 'Resend', fromEmail, ready: true, resendKey };
  const cr = smtpCreds(cfg);
  return { name: 'SMTP', fromEmail: cr.user, ready: !!cr.pass };
}
function mailStatus(cfg) {
  const p = mailProvider(cfg);
  return { provider: p.name, fromEmail: p.fromEmail, ready: p.ready };
}

// Gửi 1 email (HTML). Trả { ok, error }. KHÔNG throw.
async function sendMail(cfg, { to, subject, bodyText, fromName }) {
  if (!to) return { ok: false, error: 'Thiếu email người nhận.' };
  const html = textToHtml(bodyText || '');
  const dispName = fromName || 'Thịnh Thế Vinh Hoa';
  const p = mailProvider(cfg);
  if (p.name === 'Resend') {
    return resendSend({ apiKey: p.resendKey, from: dispName + ' <' + p.fromEmail + '>', to, subject, html });
  }
  return smtpSend(cfg, { to, subject, html, fromName: dispName });
}

// Thay placeholder {{ten}}... trong tiêu đề/nội dung bằng dữ liệu thật của người đăng ký.
function applyTemplate(text, vars) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m));
}

// Gửi email chào mừng khi có đăng ký đào tạo mới (tôn trọng bật/tắt + chế độ test).
async function maybeSendTrainingEmail(cfg, form) {
  try {
    const s = await getEmailCfg();
    const to0 = (form.email || '').trim();
    console.log(' [mail] Kích hoạt sau đăng ký — enabled=' + s.enabled + ', testMode=' + s.testMode + ', testList=' + JSON.stringify(s.testList) + ', email form=' + JSON.stringify(to0));
    if (!s.enabled) { console.log(' [mail] Bỏ qua: chưa bật gửi tự động (enabled=false).'); return { ok: false, skipped: 'disabled' }; }
    const to = to0;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { console.log(' [mail] Bỏ qua: email không hợp lệ hoặc trống.'); return { ok: false, skipped: 'no-email' }; }
    if (s.testMode) {
      const allow = (s.testList || []).map((x) => String(x).trim().toLowerCase());
      if (allow.indexOf(to.toLowerCase()) === -1) { console.log(' [mail] Bỏ qua: "' + to + '" không nằm trong danh sách test ' + JSON.stringify(allow) + '.'); return { ok: false, skipped: 'not-in-testlist' }; }
    }
    const p = mailProvider(cfg);
    console.log(' [mail] Chuẩn bị gửi qua ' + p.name + ' (ready=' + p.ready + ', from=' + p.fromEmail + ') tới ' + to);
    const vars = { ten: (form.name || '').trim() || 'các bạn Nhân Viên Mới' };
    const subject = applyTemplate(s.subject, vars);
    const bodyText = applyTemplate(s.body, vars);
    const r = await sendMail(cfg, { to, subject, bodyText, fromName: s.fromName });
    if (r.ok) console.log(' [mail] Đã gửi email đào tạo tới ' + to + ' — kết quả: ' + JSON.stringify(r));
    else console.warn(' [mail] Gửi thất bại tới ' + to + ' — kết quả đầy đủ: ' + JSON.stringify(r));
    return r;
  } catch (e) { console.error(' [mail] Exception ngoài dự kiến:', e && e.stack); return { ok: false, error: (e && e.message) || 'lỗi không xác định' }; }
}

module.exports = { EMAIL_DEFAULTS, getEmailCfg, sendMail, maybeSendTrainingEmail, mailStatus, applyTemplate };
