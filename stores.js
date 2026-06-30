/**
 * Đọc danh sách cửa hàng từ Google Sheet (CSV công khai), gom theo thương hiệu.
 * Cột: "Brand" (MC=MayCha, TH=Tam Hảo, GA=Gà) + "Tên Cửa hàng".
 * Có cache (mặc định 10 phút) để sheet cập nhật là form tự cập nhật theo, không phải deploy lại.
 * Cấu hình URL: env STORES_SHEET_CSV hoặc config.stores.sheetCsv.
 */
const https = require('https');
const { URL } = require('url');

const DEFAULT_CSV = 'https://docs.google.com/spreadsheets/d/1JorCdnX9GEWOvkg-lAyVjBkGSELThGOY1JTKdtJrTaE/export?format=csv&gid=327494494';
const BRAND_MAP = { MC: 'Trà Sữa MayCha', TH: 'Hồng Trà Sữa Tam Hảo', GA: 'Gà Giòn Sốt Ba Cô Gái' };
const TTL = 10 * 60 * 1000;
let cache = null, cacheAt = 0;

function fetchText(urlStr, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.get(u, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects < 5) {
        r.resume(); return resolve(fetchText(new URL(r.headers.location, u).toString(), redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Tách CSV (hỗ trợ dấu phẩy/ xuống dòng trong ô có ngoặc kép)
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* bỏ qua */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function brandFromName(name) {
  if (/^\s*MC/i.test(name)) return 'Trà Sữa MayCha';
  if (/^\s*BB/i.test(name)) return 'Hồng Trà Sữa Tam Hảo';
  if (/^\s*(GA|Food)/i.test(name)) return 'Gà Giòn Sốt Ba Cô Gái';
  return null;
}

async function getStores(cfg, force) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < TTL) return cache;
  const url = process.env.STORES_SHEET_CSV || (cfg && cfg.stores && cfg.stores.sheetCsv) || DEFAULT_CSV;
  try {
    const rows = parseCsv(await fetchText(url));
    // tìm hàng tiêu đề chứa cột Brand + Tên Cửa hàng
    let hi = -1, bi = -1, ni = -1;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const r = rows[i].map((c) => (c || '').replace(/\s+/g, ' ').trim().toLowerCase());
      const b = r.indexOf('brand');
      const n = r.findIndex((c) => c === 'tên cửa hàng');
      if (b >= 0 && n >= 0) { hi = i; bi = b; ni = n; break; }
    }
    const out = { 'Trà Sữa MayCha': [], 'Hồng Trà Sữa Tam Hảo': [], 'Gà Giòn Sốt Ba Cô Gái': [] };
    if (hi >= 0) {
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const name = ((r[ni] || '').replace(/\s+/g, ' ').trim());
        if (!name) continue;
        const code = (r[bi] || '').trim().toUpperCase();
        const brand = BRAND_MAP[code] || brandFromName(name);
        if (brand && out[brand]) out[brand].push(name);
      }
    }
    Object.keys(out).forEach((k) => { out[k] = [...new Set(out[k])]; }); // bỏ trùng
    cache = out; cacheAt = now; return out;
  } catch (e) {
    console.warn(' [stores] không đọc được sheet: ' + e.message);
    if (cache) return cache;
    return { 'Trà Sữa MayCha': [], 'Hồng Trà Sữa Tam Hảo': [], 'Gà Giòn Sốt Ba Cô Gái': [] };
  }
}

module.exports = { getStores };
