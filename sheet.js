/**
 * Đẩy dữ liệu đăng ký đào tạo sang Excel SharePoint qua webhook Power Automate.
 * Cấu hình URL webhook: biến môi trường SHEET_WEBHOOK_URL (hoặc config.sheet.webhookUrl).
 *
 * Power Automate (gợi ý):
 *  - Trigger: "When an HTTP request is received" -> lấy URL POST.
 *  - action == "create": "Add a row into a table" (Excel Online Business) map các trường.
 *  - action == "update": "List rows" lọc theo phone -> "Update a row" cột
 *    "Ngày Dự Kiến Bạn Có Thể Tham Gia Đào Tạo" = sess_date.
 *
 * Hàm gọi là "fire-and-forget": lỗi/không cấu hình sẽ KHÔNG làm hỏng luồng chính.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');

function webhookUrl(cfg) {
  const s = (cfg && cfg.sheet) || {};
  const u = process.env.SHEET_WEBHOOK_URL || s.webhookUrl || '';
  if (!u || /PASTE|YOUR_|example\.com/i.test(u)) return null;
  return u;
}

function isoToDmy(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? (m[3] + '/' + m[2] + '/' + m[1]) : (s || ''); }

// Gọi 1 request; tự đi theo tối đa `maxRedirect` lần chuyển hướng
// (Apps Script trả 302 cho POST -> phải GET tới Location mới đọc được JSON kết quả).
function doRequest(target, method, body, maxRedirect) {
  return new Promise((resolve) => {
    const lib = target.protocol === 'http:' ? http : https;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    const req = lib.request(target, { method, headers, timeout: 15000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && maxRedirect > 0) {
        let loc; try { loc = new URL(r.headers.location, target); } catch (e) { return resolve({ ok: false, error: 'redirect lỗi' }); }
        r.resume();
        return resolve(doRequest(loc, 'GET', null, maxRedirect - 1)); // đọc kết quả ở Location
      }
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c));
      r.on('end', () => {
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        if (!ok) console.warn(' [sheet] webhook trả về HTTP ' + r.statusCode);
        resolve({ ok, status: r.statusCode, body: d });
      });
    });
    req.on('timeout', () => { req.destroy(); console.warn(' [sheet] webhook timeout'); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => { console.warn(' [sheet] webhook lỗi: ' + e.message); resolve({ ok: false, error: e.message }); });
    if (body) req.write(body); req.end();
  });
}

function pushToSheet(cfg, payload) {
  const u = webhookUrl(cfg);
  if (!u) return Promise.resolve({ ok: false, skipped: true });
  let target; try { target = new URL(u); } catch (e) { return Promise.resolve({ ok: false, error: 'url không hợp lệ' }); }
  return doRequest(target, 'POST', Buffer.from(JSON.stringify(payload), 'utf8'), 3);
}

module.exports = { pushToSheet, webhookUrl, isoToDmy };
