/**
 * Lớp lưu trữ chat — dùng PostgreSQL nếu có DATABASE_URL (+ thư viện pg),
 * ngược lại fallback bộ nhớ RAM (để chạy local không cần cài gì).
 * Trạng thái "đang gõ" của nhân viên luôn giữ trong RAM (tạm thời).
 */
const crypto = require('crypto');
let pg = null; try { pg = require('pg'); } catch (e) { /* pg chưa cài -> dùng RAM */ }

const HAS_PG = !!(pg && process.env.DATABASE_URL);
let pool = null;

// ----- fallback RAM -----
const memConv = new Map();   // id -> {id,name,human_mode,created_at,updated_at}
const memMsg = new Map();    // id -> [{role,text,from_src,ts}]
const memAgents = new Map(); // username -> {username,pass_hash,salt,display_name}
const memTraining = [];      // [{...registration, id, ts}]  (fallback RAM)
const memBrandCampaigns = new Map(); // brand -> {brand, code, name}
const memSettings = new Map();       // k -> v (fallback RAM)
const memLog = [];                   // lịch sử chỉnh sửa (fallback RAM)
const memRecruit = new Map();        // thông tin tuyển dụng theo thương hiệu (fallback RAM)
const memGallery = [];               // Khoảnh khắc Vinh Hoa: [{id,url,sort_order}] (fallback RAM)
const memJobs = [];                  // Việc làm (tuyển dụng): [{id,...,sort_order}] (fallback RAM)
// dùng chung cho cả 2 chế độ:
const typing = new Map();    // convId -> ts
const sessions = new Map();  // token -> {username, displayName, ts}

function genSalt() { return crypto.randomBytes(8).toString('hex'); }
function hashPw(pw, salt) { return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex'); }

async function init() {
  if (HAS_PG) {
    const ssl = /railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations(
      id text PRIMARY KEY, name text, human_mode boolean DEFAULT false,
      created_at bigint, updated_at bigint)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages(
      id bigserial PRIMARY KEY, conv_id text, role text, text text, from_src text, ts bigint)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, ts)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS agents(
      username text PRIMARY KEY, pass_hash text, salt text, display_name text, created_at bigint)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS training(
      id bigserial PRIMARY KEY, name text, phone text, email text, brand text,
      position text, store text, course text, sess_date text, sess_time text,
      mode text, note text, ts bigint)`);
    await pool.query(`ALTER TABLE training ADD COLUMN IF NOT EXISTS province text`);
    await pool.query(`ALTER TABLE training ADD COLUMN IF NOT EXISTS district text`);
    await pool.query(`ALTER TABLE training ADD COLUMN IF NOT EXISTS updated_at bigint`);
    await pool.query(`CREATE TABLE IF NOT EXISTS brand_campaigns(
      brand text PRIMARY KEY, code text, name text, updated_at bigint)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS settings(k text PRIMARY KEY, v text)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS training_log(
      id bigserial PRIMARY KEY, name text, phone text, action text, detail text, ts bigint)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS recruitment_info(
      brand text PRIMARY KEY, name text, title text, content text, updated_at bigint)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS gallery(
      id bigserial PRIMARY KEY, url text, sort_order int)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS jobs(
      id bigserial PRIMARY KEY, title text, salary text, location text, deadline text,
      jobtype text, dept text, description text, sort_order int)`);
    console.log(' [db] Đã kết nối PostgreSQL — lưu chat bền vững.');
  } else {
    console.log(' [db] Không có DATABASE_URL/pg — lưu chat tạm trong RAM.');
  }
  await seedAdmin();
}

async function countAgents() {
  if (HAS_PG) { const r = await pool.query('SELECT COUNT(*)::int AS n FROM agents'); return r.rows[0].n; }
  return memAgents.size;
}
async function seedAdmin() {
  if ((await countAgents()) > 0) return;
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASS || 'ttvh@2026';
  await createAgent(user, pass, 'Quản trị');
  console.log(' [db] Đã tạo tài khoản nhân viên mặc định: ' + user);
}

async function createAgent(username, password, displayName) {
  username = (username || '').trim().toLowerCase(); if (!username || !password) return false;
  const salt = genSalt(); const ph = hashPw(password, salt);
  if (HAS_PG) {
    await pool.query(
      `INSERT INTO agents(username,pass_hash,salt,display_name,created_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE SET pass_hash=$2, salt=$3, display_name=$4`,
      [username, ph, salt, displayName || username, Date.now()]);
  } else {
    memAgents.set(username, { username, pass_hash: ph, salt, display_name: displayName || username });
  }
  return true;
}
async function getAgent(username) {
  username = (username || '').trim().toLowerCase();
  if (HAS_PG) { const r = await pool.query('SELECT * FROM agents WHERE username=$1', [username]); return r.rows[0] || null; }
  return memAgents.get(username) || null;
}
async function listAgents() {
  if (HAS_PG) { const r = await pool.query('SELECT username, display_name FROM agents ORDER BY username'); return r.rows; }
  return [...memAgents.values()].map(a => ({ username: a.username, display_name: a.display_name }));
}
async function verifyAgent(username, password) {
  const a = await getAgent(username); if (!a) return null;
  if (hashPw(password, a.salt) !== a.pass_hash) return null;
  return { username: a.username, displayName: a.display_name };
}

// ----- sessions (RAM) -----
function createSession(username, displayName) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, displayName, ts: Date.now() });
  return token;
}
function getSession(token) {
  const s = sessions.get(token); if (!s) return null;
  if (Date.now() - s.ts > 7 * 24 * 3600 * 1000) { sessions.delete(token); return null; }
  return s;
}

// ----- conversations & messages -----
async function ensureConv(id, name) {
  const now = Date.now();
  if (HAS_PG) {
    await pool.query(
      `INSERT INTO conversations(id,name,human_mode,created_at,updated_at) VALUES($1,$2,false,$3,$3)
       ON CONFLICT (id) DO UPDATE SET name=CASE WHEN conversations.name IS NULL OR conversations.name='Khách' THEN COALESCE($2,conversations.name) ELSE conversations.name END`,
      [id, name || 'Khách', now]);
  } else {
    let c = memConv.get(id);
    if (!c) { c = { id, name: name || 'Khách', human_mode: false, created_at: now, updated_at: now }; memConv.set(id, c); memMsg.set(id, []); }
    if (name && (c.name === 'Khách' || !c.name)) c.name = name;
  }
}
async function addMessage(id, role, text, from) {
  const ts = Date.now();
  if (HAS_PG) {
    await pool.query('INSERT INTO messages(conv_id,role,text,from_src,ts) VALUES($1,$2,$3,$4,$5)', [id, role, text, from || null, ts]);
    await pool.query('UPDATE conversations SET updated_at=$2 WHERE id=$1', [id, ts]);
  } else {
    (memMsg.get(id) || memMsg.set(id, []).get(id)).push({ role, text, from_src: from || null, ts });
    const c = memConv.get(id); if (c) c.updated_at = ts;
  }
  return ts;
}
async function getMessages(id, since) {
  since = since || 0;
  if (HAS_PG) {
    const r = await pool.query('SELECT role,text,from_src,ts FROM messages WHERE conv_id=$1 AND ts>$2 ORDER BY ts ASC', [id, since]);
    return r.rows.map(m => ({ role: m.role, text: m.text, from: m.from_src, ts: Number(m.ts) }));
  }
  return (memMsg.get(id) || []).filter(m => m.ts > since).map(m => ({ role: m.role, text: m.text, from: m.from_src, ts: m.ts }));
}
async function setHumanMode(id, on) {
  if (HAS_PG) await pool.query('UPDATE conversations SET human_mode=$2, updated_at=$3 WHERE id=$1', [id, !!on, Date.now()]);
  else { const c = memConv.get(id); if (c) { c.human_mode = !!on; c.updated_at = Date.now(); } }
}
async function getConv(id) {
  if (HAS_PG) { const r = await pool.query('SELECT * FROM conversations WHERE id=$1', [id]); return r.rows[0] || null; }
  return memConv.get(id) || null;
}
async function listConversations() {
  if (HAS_PG) {
    const r = await pool.query(`
      SELECT c.id, c.name, c.human_mode, c.updated_at,
        (SELECT text FROM messages m WHERE m.conv_id=c.id ORDER BY ts DESC LIMIT 1) AS last,
        (SELECT role FROM messages m WHERE m.conv_id=c.id ORDER BY ts DESC LIMIT 1) AS last_role,
        (SELECT COUNT(*)::int FROM messages m WHERE m.conv_id=c.id) AS count
      FROM conversations c ORDER BY c.updated_at DESC LIMIT 200`);
    return r.rows.map(c => ({ id: c.id, name: c.name, humanMode: c.human_mode, updatedAt: Number(c.updated_at), last: (c.last || '').slice(0, 70), lastRole: c.last_role || '', count: c.count }));
  }
  return [...memConv.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, 200).map(c => {
    const ms = memMsg.get(c.id) || []; const last = ms[ms.length - 1];
    return { id: c.id, name: c.name, humanMode: c.human_mode, updatedAt: c.updated_at, last: last ? last.text.slice(0, 70) : '', lastRole: last ? last.role : '', count: ms.length };
  });
}

// typing (RAM)
function setTyping(id) { typing.set(id, Date.now()); }
function isTyping(id) { return (Date.now() - (typing.get(id) || 0)) < 8000; }

// ----- đăng ký đào tạo -----
async function addTraining(r) {
  const ts = Date.now();
  const row = {
    name: r.name || '', phone: r.phone || '', email: r.email || '',
    province: r.province || '', district: r.district || '', brand: r.brand || '',
    position: r.position || '', store: r.store || '', course: r.course || '',
    sess_date: r.sess_date || '', sess_time: r.sess_time || '', mode: r.mode || '', note: r.note || ''
  };
  if (HAS_PG) {
    const r2 = await pool.query(
      `INSERT INTO training(name,phone,email,province,district,brand,position,store,course,sess_date,sess_time,mode,note,ts,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [row.name, row.phone, row.email, row.province, row.district, row.brand, row.position, row.store, row.course, row.sess_date, row.sess_time, row.mode, row.note, ts, ts]);
    return r2.rows[0].id;
  }
  const id = memTraining.length + 1;
  memTraining.push(Object.assign({ id, ts, updated_at: ts }, row));
  return id;
}
async function listTraining() {
  if (HAS_PG) {
    const r = await pool.query('SELECT * FROM training ORDER BY ts DESC LIMIT 500');
    return r.rows.map(x => Object.assign({}, x, { ts: Number(x.ts), updated_at: Number(x.updated_at || x.ts) }));
  }
  return [...memTraining].sort((a, b) => b.ts - a.ts);
}
const TRAIN_COLS = ['name', 'phone', 'email', 'province', 'district', 'brand', 'position', 'store', 'course', 'sess_date', 'sess_time', 'mode', 'note'];
async function updateTraining(id, r) {
  const now = Date.now();
  if (HAS_PG) {
    const sets = [], vals = []; let i = 1;
    TRAIN_COLS.forEach(c => { if (c in r) { sets.push(c + '=$' + (++i)); vals.push(r[c]); } });
    if (!sets.length) return 0;
    sets.push('updated_at=$' + (++i)); vals.push(now);   // ghi mốc thời điểm sửa
    const res = await pool.query('UPDATE training SET ' + sets.join(',') + ' WHERE id=$1', [id, ...vals]);
    return res.rowCount;
  }
  const row = memTraining.find(x => String(x.id) === String(id));
  if (!row) return 0;
  TRAIN_COLS.forEach(c => { if (c in r) row[c] = r[c]; });
  row.updated_at = now;
  return 1;
}
async function deleteTraining(id) {
  if (HAS_PG) { const r = await pool.query('DELETE FROM training WHERE id=$1', [id]); return r.rowCount; }
  const idx = memTraining.findIndex(x => String(x.id) === String(id));
  if (idx >= 0) { memTraining.splice(idx, 1); return 1; }
  return 0;
}
async function getTrainingById(id) {
  if (HAS_PG) { const r = await pool.query('SELECT * FROM training WHERE id=$1', [id]); return r.rows[0] || null; }
  return memTraining.find(x => String(x.id) === String(id)) || null;
}
// ----- lịch sử chỉnh sửa -----
async function addTrainingLog(e) {
  const ts = Date.now();
  const row = { name: e.name || '', phone: e.phone || '', action: e.action || '', detail: e.detail || '' };
  if (HAS_PG) {
    const r = await pool.query('INSERT INTO training_log(name,phone,action,detail,ts) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [row.name, row.phone, row.action, row.detail, ts]);
    return r.rows[0].id;
  }
  const id = memLog.length + 1; memLog.push(Object.assign({ id, ts }, row)); return id;
}
async function listTrainingLog(limit) {
  limit = limit || 100;
  if (HAS_PG) { const r = await pool.query('SELECT * FROM training_log ORDER BY ts DESC LIMIT $1', [limit]); return r.rows.map(x => Object.assign({}, x, { ts: Number(x.ts) })); }
  return [...memLog].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

// ----- chiến dịch theo thương hiệu -----
async function listBrandCampaigns() {
  if (HAS_PG) { const r = await pool.query('SELECT brand, code, name FROM brand_campaigns ORDER BY brand'); return r.rows; }
  return [...memBrandCampaigns.values()];
}
async function setBrandCampaign(brand, code, name) {
  brand = (brand || '').trim(); if (!brand) return false;
  const now = Date.now();
  if (HAS_PG) {
    await pool.query(
      `INSERT INTO brand_campaigns(brand,code,name,updated_at) VALUES($1,$2,$3,$4)
       ON CONFLICT (brand) DO UPDATE SET code=$2, name=$3, updated_at=$4`,
      [brand, code || '', name || '', now]);
  } else { memBrandCampaigns.set(brand, { brand, code: code || '', name: name || '' }); }
  return true;
}
async function deleteBrandCampaign(brand) {
  if (HAS_PG) { const r = await pool.query('DELETE FROM brand_campaigns WHERE brand=$1', [brand]); return r.rowCount; }
  return memBrandCampaigns.delete(brand) ? 1 : 0;
}
async function getBrandCampaignMap() {
  const rows = await listBrandCampaigns(); const m = {};
  rows.forEach((r) => { m[r.brand] = { code: r.code, name: r.name }; });
  return m;
}
// Seed lần đầu từ config (chỉ khi bảng trống) — obj: { brand: {code, name} }
async function seedBrandCampaigns(obj) {
  if (!obj) return;
  const existing = await listBrandCampaigns();
  if (existing.length) return;
  for (const b in obj) {
    const v = obj[b];
    await setBrandCampaign(b, typeof v === 'string' ? v : v.code, typeof v === 'string' ? '' : v.name);
  }
}

// ----- thông tin tuyển dụng theo thương hiệu -----
async function listRecruitment() {
  if (HAS_PG) { const r = await pool.query('SELECT brand,name,title,content FROM recruitment_info ORDER BY brand'); return r.rows; }
  return [...memRecruit.values()].map(x => ({ brand: x.brand, name: x.name, title: x.title, content: x.content }));
}
async function setRecruitment(brand, name, title, content) {
  brand = (brand || '').trim(); if (!brand) return false;
  const now = Date.now();
  if (HAS_PG) {
    await pool.query(
      `INSERT INTO recruitment_info(brand,name,title,content,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (brand) DO UPDATE SET name=$2, title=$3, content=$4, updated_at=$5`,
      [brand, name || '', title || '', content || '', now]);
  } else { memRecruit.set(brand, { brand, name: name || '', title: title || '', content: content || '' }); }
  return true;
}
async function seedRecruitment(arr) {
  if (!arr) return;
  const ex = await listRecruitment();
  const cur = {}; ex.forEach(r => { cur[r.brand] = r; });
  for (const r of arr) {
    const c = cur[r.brand];
    if (!c) { await setRecruitment(r.brand, r.name, r.title, r.content); }
    else if ((!c.content || !c.content.trim()) && r.content && r.content.trim()) {
      // điền nội dung mặc định cho thương hiệu còn trống (không ghi đè nội dung đã có)
      await setRecruitment(r.brand, c.name || r.name, c.title || r.title, r.content);
    }
  }
}

// ----- Khoảnh khắc Vinh Hoa (gallery) -----
async function listGallery() {
  if (HAS_PG) { const r = await pool.query('SELECT id,url,sort_order FROM gallery ORDER BY sort_order ASC, id ASC'); return r.rows.map(x => ({ id: Number(x.id), url: x.url, sort_order: x.sort_order })); }
  return [...memGallery].sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}
async function addGallery(url) {
  url = (url || '').trim(); if (!url) return null;
  if (HAS_PG) {
    const m = await pool.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM gallery');
    const r = await pool.query('INSERT INTO gallery(url,sort_order) VALUES($1,$2) RETURNING id', [url, m.rows[0].n]);
    return Number(r.rows[0].id);
  }
  const id = memGallery.reduce((a, x) => Math.max(a, x.id), 0) + 1;
  const so = memGallery.reduce((a, x) => Math.max(a, x.sort_order), -1) + 1;
  memGallery.push({ id, url, sort_order: so }); return id;
}
async function deleteGallery(id) {
  if (HAS_PG) { const r = await pool.query('DELETE FROM gallery WHERE id=$1', [id]); return r.rowCount; }
  const i = memGallery.findIndex(x => String(x.id) === String(id)); if (i >= 0) { memGallery.splice(i, 1); return 1; } return 0;
}
async function reorderGallery(ids) {
  if (!Array.isArray(ids)) return;
  if (HAS_PG) { for (let i = 0; i < ids.length; i++) await pool.query('UPDATE gallery SET sort_order=$2 WHERE id=$1', [ids[i], i]); return; }
  ids.forEach((id, i) => { const r = memGallery.find(x => String(x.id) === String(id)); if (r) r.sort_order = i; });
}
async function seedGallery(urls) {
  if (!urls || !urls.length) return;
  const ex = await listGallery(); if (ex.length) return;
  for (let i = 0; i < urls.length; i++) await addGallery(urls[i]);
}

// ----- Việc làm (tuyển dụng) -----
const JOB_COLS = ['title', 'salary', 'location', 'deadline', 'jobtype', 'dept', 'description'];
function jobOut(x) { return { id: Number(x.id), title: x.title || '', salary: x.salary || '', location: x.location || '', deadline: x.deadline || '', jobtype: x.jobtype || '', dept: x.dept || '', description: x.description || '', sort_order: x.sort_order }; }
async function listJobs() {
  if (HAS_PG) { const r = await pool.query('SELECT * FROM jobs ORDER BY sort_order ASC, id ASC'); return r.rows.map(jobOut); }
  return [...memJobs].sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id)).map(jobOut);
}
async function getJob(id) {
  if (HAS_PG) { const r = await pool.query('SELECT * FROM jobs WHERE id=$1', [id]); return r.rows[0] ? jobOut(r.rows[0]) : null; }
  const x = memJobs.find(j => String(j.id) === String(id)); return x ? jobOut(x) : null;
}
async function addJob(j) {
  j = j || {};
  if (HAS_PG) {
    const m = await pool.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM jobs');
    const r = await pool.query(
      `INSERT INTO jobs(title,salary,location,deadline,jobtype,dept,description,sort_order)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [j.title || '', j.salary || '', j.location || '', j.deadline || '', j.jobtype || '', j.dept || '', j.description || '', m.rows[0].n]);
    return Number(r.rows[0].id);
  }
  const id = memJobs.reduce((a, x) => Math.max(a, x.id), 0) + 1;
  const so = memJobs.reduce((a, x) => Math.max(a, x.sort_order), -1) + 1;
  memJobs.push({ id, title: j.title || '', salary: j.salary || '', location: j.location || '', deadline: j.deadline || '', jobtype: j.jobtype || '', dept: j.dept || '', description: j.description || '', sort_order: so });
  return id;
}
async function updateJob(id, j) {
  j = j || {};
  if (HAS_PG) {
    const r = await pool.query(
      `UPDATE jobs SET title=$2,salary=$3,location=$4,deadline=$5,jobtype=$6,dept=$7,description=$8 WHERE id=$1`,
      [id, j.title || '', j.salary || '', j.location || '', j.deadline || '', j.jobtype || '', j.dept || '', j.description || '']);
    return r.rowCount;
  }
  const x = memJobs.find(m => String(m.id) === String(id)); if (!x) return 0;
  JOB_COLS.forEach(k => { x[k] = j[k] || ''; }); return 1;
}
async function deleteJob(id) {
  if (HAS_PG) { const r = await pool.query('DELETE FROM jobs WHERE id=$1', [id]); return r.rowCount; }
  const i = memJobs.findIndex(x => String(x.id) === String(id)); if (i >= 0) { memJobs.splice(i, 1); return 1; } return 0;
}
async function reorderJobs(ids) {
  if (!Array.isArray(ids)) return;
  if (HAS_PG) { for (let i = 0; i < ids.length; i++) await pool.query('UPDATE jobs SET sort_order=$2 WHERE id=$1', [ids[i], i]); return; }
  ids.forEach((id, i) => { const r = memJobs.find(x => String(x.id) === String(id)); if (r) r.sort_order = i; });
}
async function seedJobs(arr) {
  if (!arr || !arr.length) return;
  const ex = await listJobs(); if (ex.length) return;
  for (const j of arr) await addJob(j);
}

// ----- settings (key-value) -----
async function getSetting(k) {
  if (HAS_PG) { const r = await pool.query('SELECT v FROM settings WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; }
  return memSettings.has(k) ? memSettings.get(k) : null;
}
async function setSetting(k, v) {
  if (HAS_PG) { await pool.query('INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=$2', [k, v]); }
  else memSettings.set(k, v);
}

module.exports = {
  init, HAS_PG,
  verifyAgent, createAgent, listAgents,
  createSession, getSession,
  ensureConv, addMessage, getMessages, setHumanMode, getConv, listConversations,
  setTyping, isTyping,
  addTraining, listTraining, updateTraining, deleteTraining, getTrainingById,
  addTrainingLog, listTrainingLog,
  listBrandCampaigns, setBrandCampaign, deleteBrandCampaign, getBrandCampaignMap, seedBrandCampaigns,
  listRecruitment, setRecruitment, seedRecruitment,
  listGallery, addGallery, deleteGallery, reorderGallery, seedGallery,
  listJobs, getJob, addJob, updateJob, deleteJob, reorderJobs, seedJobs,
  getSetting, setSetting
};
