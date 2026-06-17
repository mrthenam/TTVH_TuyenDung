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
      `INSERT INTO training(name,phone,email,province,district,brand,position,store,course,sess_date,sess_time,mode,note,ts)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [row.name, row.phone, row.email, row.province, row.district, row.brand, row.position, row.store, row.course, row.sess_date, row.sess_time, row.mode, row.note, ts]);
    return r2.rows[0].id;
  }
  const id = memTraining.length + 1;
  memTraining.push(Object.assign({ id, ts }, row));
  return id;
}
async function listTraining() {
  if (HAS_PG) {
    const r = await pool.query('SELECT * FROM training ORDER BY ts DESC LIMIT 500');
    return r.rows.map(x => Object.assign({}, x, { ts: Number(x.ts) }));
  }
  return [...memTraining].sort((a, b) => b.ts - a.ts);
}

module.exports = {
  init, HAS_PG,
  verifyAgent, createAgent, listAgents,
  createSession, getSession,
  ensureConv, addMessage, getMessages, setHumanMode, getConv, listConversations,
  setTyping, isTyping,
  addTraining, listTraining
};
