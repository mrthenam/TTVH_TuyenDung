/**
 * Gửi thông báo Zalo khi ứng viên đổi lịch đào tạo.
 * 2 cách (ưu tiên A nếu có cấu hình):
 *  A) Webhook trung gian: ZALO_NOTIFY_URL (hoặc config.zalo.notifyUrl)
 *     -> POST JSON { text, event, name, phone, newDate } tới URL đó
 *        (URL này do bạn dựng: Make/Zapier có connector Zalo, hoặc Apps Script gọi Zalo OA…)
 *  B) Zalo OA trực tiếp: ZALO_OA_TOKEN + ZALO_RECIPIENT_ID
 *     -> POST tới openapi.zalo.me (message/cs) với header access_token
 *
 * Fire-and-forget: lỗi/không cấu hình KHÔNG làm hỏng luồng chatbot.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(target, method, headers, body, maxRedirect) {
  return new Promise((resolve) => {
    const lib = target.protocol === 'http:' ? http : https;
    const h = Object.assign({}, headers || {});
    if (body) h['Content-Length'] = body.length;
    const req = lib.request(target, { method, headers: h, timeout: 15000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && maxRedirect > 0) {
        let loc; try { loc = new URL(r.headers.location, target); } catch (e) { return resolve({ ok: false }); }
        r.resume();
        return resolve(request(loc, 'GET', headers, null, maxRedirect - 1));
      }
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c));
      r.on('end', () => {
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        if (!ok) console.warn(' [zalo] HTTP ' + r.statusCode + ' ' + d.slice(0, 120));
        resolve({ ok, status: r.statusCode, body: d });
      });
    });
    req.on('timeout', () => { req.destroy(); console.warn(' [zalo] timeout'); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => { console.warn(' [zalo] lỗi: ' + e.message); resolve({ ok: false, error: e.message }); });
    if (body) req.write(body); req.end();
  });
}

function notifyZalo(cfg, payload) {
  const z = (cfg && cfg.zalo) || {};
  // A) webhook trung gian
  const url = z.notifyUrl;
  if (url && !/PASTE|YOUR_|example\.com/i.test(url)) {
    let t; try { t = new URL(url); } catch (e) { return Promise.resolve({ ok: false, error: 'notifyUrl không hợp lệ' }); }
    return request(t, 'POST', { 'Content-Type': 'application/json' }, Buffer.from(JSON.stringify(payload), 'utf8'), 3);
  }
  // B) Zalo OA trực tiếp
  const token = z.oaToken, rid = z.recipientId;
  if (token && rid && !/PASTE|YOUR_/i.test(token)) {
    let t; try { t = new URL('https://openapi.zalo.me/v3.0/oa/message/cs'); } catch (e) { return Promise.resolve({ ok: false }); }
    const body = Buffer.from(JSON.stringify({ recipient: { user_id: rid }, message: { text: payload.text } }), 'utf8');
    return request(t, 'POST', { 'Content-Type': 'application/json', 'access_token': token }, body, 0);
  }
  return Promise.resolve({ ok: false, skipped: true });
}

module.exports = { notifyZalo };
