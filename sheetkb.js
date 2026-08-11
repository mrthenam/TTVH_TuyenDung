/**
 * Đọc "kịch bản chatbot" (lời chào / câu trả lời mặc định / kịch bản Q&A) trực tiếp từ
 * Google Sheet công khai — để HR sửa kịch bản ngay trong Sheet mà không cần vào dashboard.
 *
 * Không cần OAuth: dùng link xuất CSV công khai của Google Sheets, nên Sheet CHỈ CẦN chia sẻ
 * ở chế độ "Bất kỳ ai có đường liên kết" — quyền "Người xem" là đủ, không cần "Người chỉnh sửa".
 * Nếu Sheet ở chế độ riêng tư (yêu cầu đăng nhập), việc đọc sẽ lỗi và code gọi module này
 * (chatbot.js) sẽ tự rơi về kịch bản đã lưu trong DB/file — chatbot không bao giờ bị "câm".
 *
 * Định dạng cột mong đợi (khớp file mẫu mình đã xuất): STT | Loại | Từ khóa | Câu trả lời | Ghi chú
 * - Loại chứa "chào"      -> dòng Lời chào
 * - Loại chứa "mặc định"  -> dòng Câu trả lời mặc định
 * - Còn lại               -> 1 kịch bản Q&A (Từ khóa cách nhau bởi " | ")
 * Thứ tự cột linh hoạt (dò theo tên cột ở dòng tiêu đề), miễn còn cột "Loại/Từ khóa/Câu trả lời".
 */
const https = require('https');

function normVi(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

// Parser CSV tối giản nhưng đúng chuẩn (xử lý field có dấu ngoặc kép chứa dấu phẩy/xuống dòng)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* bỏ qua, chờ \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => (c || '').trim() !== ''));
}

function sheetCsvUrl(id, gid) {
  return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/export?format=csv' + (gid ? '&gid=' + encodeURIComponent(gid) : '');
}

function fetchText(url, timeoutMs, redirectsLeft) {
  redirectsLeft = redirectsLeft == null ? 5 : redirectsLeft;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return fetchText(res.headers.location, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const ctype = res.headers['content-type'] || '';
      // Sheet riêng tư -> Google trả về trang đăng nhập HTML thay vì CSV
      if (ctype.indexOf('text/csv') < 0 && ctype.indexOf('text/plain') < 0) {
        res.resume();
        return reject(new Error('Sheet chưa công khai (nhận về "' + ctype.split(';')[0] + '" thay vì CSV) — kiểm tra lại quyền chia sẻ.'));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Hết thời gian chờ Google Sheets.')); });
    req.on('error', reject);
  });
}

function rowsToKb(rows) {
  if (!rows.length) throw new Error('Sheet trống.');
  const header = rows[0].map((h) => normVi(h).trim());
  const iType = header.findIndex((h) => h.indexOf('loai') >= 0);
  const iKw = header.findIndex((h) => h.indexOf('tu khoa') >= 0);
  const iAns = header.findIndex((h) => h.indexOf('cau tra loi') >= 0 && h.indexOf('mac dinh') < 0);
  if (iAns < 0) throw new Error('Không tìm thấy cột "Câu trả lời" ở dòng tiêu đề.');
  const kb = { greeting: '', fallback: '', qa: [] };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = normVi(iType >= 0 ? row[iType] : '');
    const kwRaw = (iKw >= 0 ? row[iKw] : '') || '';
    const ans = (row[iAns] || '').trim();
    if (!ans) continue;
    if (type.indexOf('chao') >= 0) kb.greeting = ans;
    else if (type.indexOf('mac dinh') >= 0) kb.fallback = ans;
    else {
      const q = kwRaw.split('|').map((s) => s.trim()).filter(Boolean);
      if (q.length) kb.qa.push({ q, a: ans });
    }
  }
  if (!kb.qa.length && !kb.fallback && !kb.greeting) throw new Error('Không đọc được dữ liệu hợp lệ (sheet đúng định dạng nhưng trống).');
  return kb;
}

let cache = null, cacheAt = 0, lastError = null, lastId = null;
const TTL = 5 * 60 * 1000; // 5 phút — đủ mới để sửa xong thấy áp dụng nhanh, không dội API liên tục

// force: bỏ qua cache, luôn lấy mới (dùng cho nút "Làm mới ngay" trên dashboard)
async function getSheetKb(cfg, force) {
  const s = (cfg && cfg.chatbot) || {};
  const id = (s.kbSheetId || '').trim();
  if (!id) return null; // chưa cấu hình sheet nguồn -> để chatbot.js tự dùng nguồn khác
  const now = Date.now();
  if (!force && cache && id === lastId && now - cacheAt < TTL) return cache;
  try {
    const csv = await fetchText(sheetCsvUrl(id, (s.kbSheetGid || '').trim()), 12000);
    const kb = rowsToKb(parseCsv(csv));
    cache = kb; cacheAt = now; lastId = id; lastError = null;
    return kb;
  } catch (e) {
    lastError = e.message || String(e);
    if (cache && id === lastId) return cache; // lỗi tạm thời -> vẫn dùng bản đọc được lần trước
    return null; // chưa từng đọc được lần nào -> để chatbot.js rơi về nguồn khác
  }
}
function sheetStatus(cfg) {
  const id = (((cfg && cfg.chatbot) || {}).kbSheetId || '').trim();
  return {
    configured: !!id,
    active: !!(cache && id && id === lastId),
    cachedAt: cacheAt || null,
    count: cache ? cache.qa.length : 0,
    error: lastError,
    url: id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : ''
  };
}

module.exports = { getSheetKb, sheetStatus, sheetCsvUrl };
