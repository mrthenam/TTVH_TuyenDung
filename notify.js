/**
 * Gửi thông báo Zalo khi ứng viên đổi lịch đào tạo.
 * Thứ tự ưu tiên:
 *  A) Webhook trung gian: config.zalo.notifyUrl (env ZALO_NOTIFY_URL)
 *  B) Zalo OA trực tiếp + TỰ REFRESH token:
 *     config.zalo.appId + appSecret + recipientId (+ refreshToken khởi tạo lần đầu)
 *     env: ZALO_APP_ID / ZALO_APP_SECRET / ZALO_REFRESH_TOKEN / ZALO_RECIPIENT_ID
 *     -> refresh_token được xoay vòng và lưu vào DB (settings: zalo_refresh_token)
 *  C) Zalo OA token tĩnh (cũ): config.zalo.oaToken + recipientId
 *
 * Fire-and-forget: lỗi/không cấu hình KHÔNG làm hỏng luồng chatbot.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const db = require('./db');

function request(target, method, headers, body, maxRedirect) {
  return new Promise((resolve) => {
    const lib = target.protocol === 'http:' ? http : https;
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request(target, { method, headers: h, timeout: 15000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && maxRedirect > 0) {
        let loc; try { loc = new URL(r.headers.location, target); } catch (e) { return resolve({ ok: false }); }
        r.resume();
        return resolve(request(loc, 'GET', headers, null, maxRedirect - 1));
      }
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c));
      r.on('end', () => {
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        if (!ok) console.warn(' [zalo] HTTP ' + r.statusCode + ' ' + d.slice(0, 160));
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ ok, status: r.statusCode, body: d, json: j });
      });
    });
    req.on('timeout', () => { req.destroy(); console.warn(' [zalo] timeout'); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => { console.warn(' [zalo] lỗi: ' + e.message); resolve({ ok: false, error: e.message }); });
    if (body) req.write(body); req.end();
  });
}

// Lấy access_token mới từ refresh_token (Zalo xoay vòng refresh_token mỗi lần -> phải lưu lại)
async function getZaloAccessToken(z) {
  const stored = await db.getSetting('zalo_refresh_token');
  const rt = stored || z.refreshToken;
  if (!rt || !z.appId || !z.appSecret) return null;
  const body = 'refresh_token=' + encodeURIComponent(rt) + '&app_id=' + encodeURIComponent(z.appId) + '&grant_type=refresh_token';
  const res = await request(new URL('https://oauth.zaloapp.com/v4/oa/access_token'), 'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': z.appSecret }, body, 0);
  const j = res.json || {};
  if (j.access_token) {
    if (j.refresh_token) await db.setSetting('zalo_refresh_token', j.refresh_token); // lưu token mới
    return j.access_token;
  }
  console.warn(' [zalo] không lấy được access_token: ' + (res.body || '').slice(0, 160));
  return null;
}

async function sendOA(token, recipientId, text) {
  const body = JSON.stringify({ recipient: { user_id: recipientId }, message: { text: text } });
  return request(new URL('https://openapi.zalo.me/v3.0/oa/message/cs'), 'POST',
    { 'Content-Type': 'application/json', 'access_token': token }, Buffer.from(body, 'utf8'), 0);
}

async function notifyZalo(cfg, payload) {
  const z = (cfg && cfg.zalo) || {};
  // A) webhook trung gian
  if (z.notifyUrl && !/PASTE|YOUR_|example\.com/i.test(z.notifyUrl)) {
    let t; try { t = new URL(z.notifyUrl); } catch (e) { return { ok: false, error: 'notifyUrl không hợp lệ' }; }
    return request(t, 'POST', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify(payload), 'utf8'), 3);
  }
  // B) Zalo OA + tự refresh token
  if (z.appId && z.appSecret && z.recipientId && !/PASTE|YOUR_/i.test(z.appId)) {
    const token = await getZaloAccessToken(z);
    if (token) return sendOA(token, z.recipientId, payload.text);
    return { ok: false, error: 'không lấy được access_token' };
  }
  // C) token tĩnh (cũ)
  if (z.oaToken && z.recipientId && !/PASTE|YOUR_/i.test(z.oaToken)) {
    return sendOA(z.oaToken, z.recipientId, payload.text);
  }
  return { ok: false, skipped: true };
}

// Đổi authorization code -> refresh_token (gọi 1 lần khi cấp quyền OA), lưu vào DB
async function exchangeZaloCode(cfg, code) {
  const z = (cfg && cfg.zalo) || {};
  if (!z.appId || !z.appSecret) return { ok: false, error: 'Chưa cấu hình ZALO_APP_ID / ZALO_APP_SECRET' };
  const body = 'code=' + encodeURIComponent(code) + '&app_id=' + encodeURIComponent(z.appId) + '&grant_type=authorization_code';
  const res = await request(new URL('https://oauth.zaloapp.com/v4/oa/access_token'), 'POST',
    { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': z.appSecret }, body, 0);
  const j = res.json || {};
  if (j.refresh_token) { await db.setSetting('zalo_refresh_token', j.refresh_token); return { ok: true }; }
  return { ok: false, error: (res.body || 'không nhận được refresh_token').slice(0, 200) };
}

module.exports = { notifyZalo, exchangeZaloCode };
