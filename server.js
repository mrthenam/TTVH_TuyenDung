/**
 * Proxy + static server cho trang tuyển dụng Thịnh Thế Vinh Hoa.
 * Chỉ dùng module built-in của Node (http, https, fs, path, url) — KHÔNG cần npm install.
 *
 * Chạy:   node server.js
 * Mở:     http://localhost:3000/tuyen-dung.html
 *
 * Trình duyệt KHÔNG bao giờ thấy token: nó chỉ gọi /api/<key>,
 * server này mới gắn token và gọi tới 1Office.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const chatbot = require("./chatbot");
const db = require("./db");
const sheet = require("./sheet");
const notify = require("./notify");
const stores = require("./stores");
const mailer = require("./mailer");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");

function loadConfig() {
  let cfg = null;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    // Khi deploy (vd Railway) không có config.json (đã gitignore) -> dùng config.example.json làm nền
    try {
      cfg = JSON.parse(
        fs.readFileSync(path.join(ROOT, "config.example.json"), "utf8"),
      );
    } catch (e2) {
      console.error(
        "Không đọc được config.json/config.example.json:",
        e2.message,
      );
      return null;
    }
  }
  // Overlay biến môi trường (cho deploy) — token & các giá trị nhạy cảm KHÔNG nằm trong git
  const o = cfg.oneOffice || (cfg.oneOffice = {});
  if (process.env.ONEOFFICE_TOKEN) o.token = process.env.ONEOFFICE_TOKEN;
  if (process.env.ONEOFFICE_BASEURL) o.baseUrl = process.env.ONEOFFICE_BASEURL;
  if (o.create) {
    if (process.env.ONEOFFICE_WRITE_TOKEN)
      o.create.token = process.env.ONEOFFICE_WRITE_TOKEN;
    o.create.extra = o.create.extra || {};
    if (process.env.APPLY_SOURCE)
      o.create.extra.source = process.env.APPLY_SOURCE;
    if (process.env.APPLY_CAMPAIGN)
      o.create.extra.campaign_current_id = process.env.APPLY_CAMPAIGN;
  }
  // Sheet (Power Automate webhook)
  const sh = cfg.sheet || (cfg.sheet = {});
  if (process.env.SHEET_WEBHOOK_URL)
    sh.webhookUrl = process.env.SHEET_WEBHOOK_URL;
  if (process.env.SHEET_VIEW_URL) sh.viewUrl = process.env.SHEET_VIEW_URL;
  if (process.env.GOOGLE_CLIENT_ID)
    sh.googleClientId = process.env.GOOGLE_CLIENT_ID;
  // Báo Zalo khi đổi lịch đào tạo
  const zl = cfg.zalo || (cfg.zalo = {});
  if (process.env.ZALO_NOTIFY_URL) zl.notifyUrl = process.env.ZALO_NOTIFY_URL;
  if (process.env.ZALO_APP_ID) zl.appId = process.env.ZALO_APP_ID;
  if (process.env.ZALO_APP_SECRET) zl.appSecret = process.env.ZALO_APP_SECRET;
  if (process.env.ZALO_REFRESH_TOKEN)
    zl.refreshToken = process.env.ZALO_REFRESH_TOKEN;
  if (process.env.ZALO_RECIPIENT_ID)
    zl.recipientId = process.env.ZALO_RECIPIENT_ID;
  if (process.env.ZALO_OA_TOKEN) zl.oaToken = process.env.ZALO_OA_TOKEN;
  // Chatbot
  const cb = cfg.chatbot || (cfg.chatbot = {});
  if (process.env.GEMINI_API_KEY) cb.geminiApiKey = process.env.GEMINI_API_KEY;
  if (process.env.GEMINI_MODEL) cb.geminiModel = process.env.GEMINI_MODEL;
  if (process.env.AGENT_KEY) cb.agentKey = process.env.AGENT_KEY;
  return cfg;
}

// Bỏ dấu tiếng Việt để so khớp thương hiệu linh hoạt
function normVi(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Lấy mã từ giá trị map (có thể là chuỗi code hoặc object {code,name})
function codeOf(v) {
  return v == null ? null : (typeof v === "string" ? v : v.code) || null;
}
// Chọn mã chiến dịch theo thương hiệu ứng tuyển (khớp không dấu/hoa thường)
function pickBrandCampaign(map, brand) {
  if (!map || !brand) return null;
  if (map[brand]) return codeOf(map[brand]);
  const nb = normVi(brand);
  for (const k in map) {
    if (normVi(k) === nb) return codeOf(map[k]);
  }
  if (nb.includes("maycha") || nb.includes("may cha"))
    return codeOf(map["MayCha"]);
  if (nb.includes("tam hao")) return codeOf(map["Hồng Trà Sữa Tam Hảo"]);
  if (
    nb.includes("ga gion") ||
    nb.includes("ba co gai") ||
    nb.includes("ga ran")
  )
    return codeOf(map["Gà Giòn Sốt Ba Cô Gái"]);
  return null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

// Lấy mảng dữ liệu từ JSON trả về của 1Office (cấu trúc có thể khác nhau).
function extractArray(payload, dataPath) {
  if (dataPath) {
    let cur = payload;
    for (const part of dataPath.split(".")) {
      if (cur == null) break;
      cur = cur[part];
    }
    if (Array.isArray(cur)) return cur;
    if (cur && typeof cur === "object") return [cur];
  }
  if (Array.isArray(payload)) return payload;
  // Tự dò: tìm mảng đầu tiên trong các key phổ biến rồi tới mọi key.
  const prefer = ["data", "rows", "results", "items", "list", "records"];
  if (payload && typeof payload === "object") {
    for (const k of prefer) {
      if (Array.isArray(payload[k])) return payload[k];
      if (payload[k] && Array.isArray(payload[k].rows)) return payload[k].rows;
      if (payload[k] && Array.isArray(payload[k].data)) return payload[k].data;
    }
    for (const k of Object.keys(payload)) {
      if (Array.isArray(payload[k])) return payload[k];
    }
  }
  return null;
}

function proxyTo1Office(key, cfg, res, clientParams) {
  const o = cfg.oneOffice || {};
  const endpoint = (o.endpoints || {})[key];
  if (!endpoint) {
    return sendJson(res, 400, {
      error: 'Chưa cấu hình endpoint cho "' + key + '" trong config.json',
    });
  }

  // Token: ưu tiên token riêng của mục, nếu trống thì dùng token mặc định.
  const perKey = (o.endpointTokens || {})[key];
  const token = perKey && !/^PASTE_/i.test(perKey) ? perKey : o.token;
  if (!token || /PASTE_|YOUR_/i.test(token)) {
    return sendJson(res, 428, {
      error:
        'Mục "' +
        key +
        '" chưa có token hợp lệ. Hãy tạo API token cho object này trong 1Office rồi dán vào config.json (endpointTokens.' +
        key +
        ").",
    });
  }

  // Cho phép endpoint là URL đầy đủ hoặc chỉ path.
  let targetUrl;
  try {
    targetUrl = /^https?:\/\//i.test(endpoint)
      ? new URL(endpoint)
      : new URL(endpoint.replace(/^\//, "/"), o.baseUrl);
  } catch (e) {
    return sendJson(res, 500, {
      error: "baseUrl/endpoint không hợp lệ: " + e.message,
    });
  }

  // Chuyển tiếp tham số phân trang / lọc từ client (limit, page, ...).
  if (clientParams) {
    for (const [k, v] of clientParams) {
      if (k === "access_token") continue;
      targetUrl.searchParams.set(k, v);
    }
  }
  if (!targetUrl.searchParams.has("limit") && o.pageLimit) {
    targetUrl.searchParams.set("limit", String(o.pageLimit));
  }

  const headers = { Accept: "application/json" };
  if ((o.tokenMode || "query") === "header") {
    headers[o.headerName || "Authorization"] = (o.headerPrefix || "") + token;
  } else {
    targetUrl.searchParams.set(o.tokenParam || "access_token", token);
  }

  const lib = targetUrl.protocol === "http:" ? http : https;
  const reqOpts = {
    method: "GET",
    headers,
    timeout: 20000,
  };

  const upstream = lib.request(targetUrl, reqOpts, (up) => {
    let raw = "";
    up.setEncoding("utf8");
    up.on("data", (c) => (raw += c));
    up.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 502, {
          error:
            "1Office không trả về JSON hợp lệ (HTTP " + up.statusCode + ").",
          preview: raw.slice(0, 400),
        });
      }
      // 1Office báo lỗi nghiệp vụ ngay trong JSON (error:true) dù HTTP 200.
      if (payload && payload.error === true) {
        return sendJson(res, 200, {
          ok: false,
          key,
          error:
            "1Office: " +
            (payload.message || payload.code || "lỗi không xác định"),
          code: payload.code,
        });
      }
      const rows = extractArray(payload, o.dataPath);
      sendJson(res, 200, {
        ok: true,
        key,
        count: rows ? rows.length : 0,
        total:
          payload &&
          (payload.total_item != null ? payload.total_item : payload.total),
        rows: rows || [],
        raw: rows ? undefined : payload, // nếu không tìm thấy mảng, trả raw để bạn xem cấu trúc
      });
    });
  });

  upstream.on("timeout", () => {
    upstream.destroy();
    sendJson(res, 504, { error: "Hết thời gian chờ khi gọi 1Office." });
  });
  upstream.on("error", (e) =>
    sendJson(res, 502, { error: "Lỗi gọi 1Office: " + e.message }),
  );
  upstream.end();
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(
    new URL(req.url, "http://localhost").pathname,
  );
  if (pathname === "/") pathname = "/index.html";
  // Đường dẫn thân thiện cho trang quản trị: /admin (và /agent, /agent.html cũ) -> admin.html
  const lp = pathname.replace(/\/$/, "").toLowerCase();
  if (lp === "/admin" || lp === "/agent" || lp === "/agent.html")
    pathname = "/admin.html";
  // chặn path traversal
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Không tìm thấy: " + safe);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

// Đọc body (JSON) của request POST. Giới hạn nới rộng để chấp nhận CV đính kèm (base64).
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 8e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// Chuẩn hóa SĐT để so khớp (bỏ mọi ký tự không phải số).
function normPhone(s) {
  return String(s == null ? "" : s).replace(/\D/g, "");
}

// Tra cứu ứng viên trên 1Office theo SĐT (dùng bộ lọc keyword "s"). Trả về mảng bản ghi TRÙNG khớp SĐT.
function oneOfficeFindByPhone(phoneRaw, cfg) {
  return new Promise((resolve) => {
    const o = cfg.oneOffice || {};
    const phone = normPhone(phoneRaw);
    if (!phone) return resolve([]);
    const et = (o.endpointTokens && o.endpointTokens.candidates) || "";
    const token = et && !/^PASTE_|^$/.test(et) ? et : o.token;
    if (!token || /PASTE_|YOUR_/i.test(token)) return resolve([]);
    const path =
      (o.endpoints && o.endpoints.candidates) ||
      "/api/recruitment/candidate/gets";
    let u;
    try {
      u = /^https?:\/\//i.test(path) ? new URL(path) : new URL(path, o.baseUrl);
    } catch (e) {
      return resolve([]);
    }
    u.searchParams.set(o.tokenParam || "access_token", token);
    u.searchParams.set("limit", "20");
    u.searchParams.set("filters", JSON.stringify([{ s: phoneRaw }]));
    const lib = u.protocol === "http:" ? http : https;
    const rq = lib.get(u, (up) => {
      let raw = "";
      up.setEncoding("utf8");
      up.on("data", (d) => (raw += d));
      up.on("end", () => {
        let arr = [];
        try {
          const j = JSON.parse(raw);
          if (Array.isArray(j.data)) arr = j.data;
        } catch (e) {}
        resolve(arr.filter((x) => normPhone(x.phone) === phone));
      });
    });
    rq.on("error", () => resolve([]));
    rq.setTimeout(15000, () => {
      rq.destroy();
      resolve([]);
    });
  });
}

// Gửi 1 payload tới 1Office (insert/update). Trả Promise { ok, error, result, sent }.
function oneOfficeSend(endpointPath, payload, cfg, token) {
  return new Promise((resolve) => {
    const o = cfg.oneOffice || {};
    let targetUrl;
    try {
      targetUrl = /^https?:\/\//i.test(endpointPath)
        ? new URL(endpointPath)
        : new URL(endpointPath, o.baseUrl);
    } catch (e) {
      return resolve({
        ok: false,
        error: "endpoint không hợp lệ: " + e.message,
      });
    }
    targetUrl.searchParams.set(o.tokenParam || "access_token", token);
    const clean = {};
    for (const k in payload) {
      if (payload[k] !== "" && payload[k] != null) clean[k] = payload[k];
    }
    const body = new URLSearchParams(clean).toString();
    const lib = targetUrl.protocol === "http:" ? http : https;
    const upstream = lib.request(
      targetUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
        timeout: 20000,
      },
      (up) => {
        let raw = "";
        up.setEncoding("utf8");
        up.on("data", (d) => (raw += d));
        up.on("end", () => {
          let j;
          try {
            j = JSON.parse(raw);
          } catch (e) {
            j = null;
          }
          if (j && j.error === true)
            return resolve({
              ok: false,
              error: "1Office: " + (j.message || j.code),
              raw: j,
            });
          resolve({
            ok: true,
            result: j || raw.slice(0, 300),
            sent: Object.keys(clean),
          });
        });
      },
    );
    upstream.on("timeout", () => {
      upstream.destroy();
      resolve({ ok: false, error: "Hết thời gian chờ khi gọi 1Office." });
    });
    upstream.on("error", (e) =>
      resolve({ ok: false, error: "Lỗi gọi 1Office: " + e.message }),
    );
    upstream.write(body);
    upstream.end();
  });
}

// Nhận hồ sơ ứng tuyển: chặn nếu SĐT nằm trong Blacklist; đã có hồ sơ thì CẬP NHẬT (cho đăng ký lại), chưa có thì TẠO MỚI.
async function createCandidate(form, cfg, res) {
  const o = cfg.oneOffice || {};
  const c = o.create || {};
  if (!c.endpoint) {
    return sendJson(res, 501, {
      error:
        "Chưa cấu hình endpoint tạo ứng viên (oneOffice.create.endpoint) trong config.json.",
    });
  }
  const token = c.token && !/^PASTE_|^$/.test(c.token) ? c.token : o.token;
  if (!token || /PASTE_|YOUR_/i.test(token)) {
    return sendJson(res, 428, {
      error:
        "Chưa có token GHI hợp lệ để tạo ứng viên (oneOffice.create.token).",
    });
  }

  // 1) Tra cứu theo SĐT: chặn Blacklist (status = 'Blacklist'); phát hiện hồ sơ đã tồn tại.
  //    Nếu tra cứu lỗi/timeout -> KHÔNG chặn nhầm, vẫn cho nộp bình thường.
  let existing = null;
  try {
    const matches = await oneOfficeFindByPhone(form.phone, cfg);
    if (matches.some((x) => (x.status || "").trim() === "Blacklist")) {
      return sendJson(res, 200, {
        ok: false,
        blacklisted: true,
        error:
          "Số điện thoại này hiện nằm trong danh sách hạn chế tiếp nhận hồ sơ. Vui lòng liên hệ phòng Nhân sự (hr@maycha.com.vn) để được hỗ trợ.",
      });
    }
    existing = matches.find((x) => x.code) || null;
  } catch (e) {
    existing = null;
  }

  // 2) Map field form -> field 1Office theo cấu hình; gộp thêm các field cố định (vd campaign).
  const map = c.fieldMap || {};
  const payload = Object.assign({}, c.extra || {});
  for (const k in form) {
    if (form[k] == null || form[k] === "") continue;
    const target = map[k];
    if (target) payload[target] = form[k];
  }
  // Định tuyến CHIẾN DỊCH: ưu tiên theo thương hiệu ứng tuyển (Cửa hàng); nếu không có (Văn phòng/Sản xuất)
  // thì định tuyến theo Khối công việc. Ưu tiên cấu hình trong DB, fallback config.
  let dbMap = null;
  try {
    dbMap = await db.getBrandCampaignMap();
  } catch (e) {
    dbMap = null;
  }
  const brandCode =
    pickBrandCampaign(dbMap || {}, form.brand) ||
    pickBrandCampaign(c.brandCampaigns, form.brand) ||
    pickBrandCampaign(dbMap || {}, form.jobgroup) ||
    pickBrandCampaign(c.brandCampaigns, form.jobgroup);
  if (brandCode) payload.campaign_current_id = brandCode;

  // Ngày sinh: input HTML là yyyy-mm-dd -> 1Office cần dd/mm/YYYY
  if (payload.birthday && /^\d{4}-\d{2}-\d{2}$/.test(payload.birthday)) {
    const p = payload.birthday.split("-");
    payload.birthday = p[2] + "/" + p[1] + "/" + p[0];
  }

  // Ngày nộp hồ sơ (date_filing): tự điền ngày hôm nay (dd/mm/YYYY) nếu chưa có
  if (!payload.date_filing) {
    const n = new Date();
    const p2 = (x) => (x < 10 ? "0" : "") + x;
    payload.date_filing =
      p2(n.getDate()) + "/" + p2(n.getMonth() + 1) + "/" + n.getFullYear();
  }

  // CV đính kèm (nếu có) -> field "files" của 1Office: JSON [{name, file: base64}] (chỉ nhận 1 file duy nhất)
  if (form.cv_base64 && form.cv_name) {
    payload.files = JSON.stringify([
      { name: form.cv_name, file: form.cv_base64 },
    ]);
  }

  // 3) Đã có hồ sơ (không blacklist) -> CẬP NHẬT hồ sơ cũ theo code (đăng ký lại, tránh lỗi trùng SĐT).
  //    Chưa có -> TẠO MỚI với code tự sinh (duy nhất).
  let r;
  if (existing) {
    const updateEndpoint =
      c.updateEndpoint || c.endpoint.replace(/\/insert(?=$|\?|#)/, "/update");
    r = await oneOfficeSend(
      updateEndpoint,
      Object.assign({}, payload, { code: existing.code }),
      cfg,
      token,
    );
    if (r.ok)
      return sendJson(res, 200, { ok: true, updated: true, result: r.result });
    return sendJson(res, 200, { ok: false, error: r.error });
  }
  r = await oneOfficeSend(
    c.endpoint,
    Object.assign({}, payload, {
      code: payload.code || (c.codePrefix || "WEB") + Date.now(),
    }),
    cfg,
    token,
  );
  if (r.ok)
    return sendJson(res, 200, {
      ok: true,
      updated: false,
      result: r.result,
      sent: r.sent,
    });
  return sendJson(res, 200, { ok: false, error: r.error });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Zalo OA: nhận code cấp quyền -> đổi lấy refresh_token (lưu DB)
  if (url.pathname === "/zalo/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (!code)
      return res.end(
        "<h2>Thiếu tham số code. Hãy mở lại link cấp quyền OA.</h2>",
      );
    const cfg = loadConfig() || {};
    const r = await notify.exchangeZaloCode(cfg, code);
    return res.end(
      r.ok
        ? "<h2>✅ Đã kết nối Zalo OA thành công!</h2><p>Hệ thống đã lưu refresh_token. Bạn có thể đóng tab này.</p>"
        : "<h2>❌ Kết nối Zalo OA thất bại</h2><p>" +
            String(r.error || "").replace(/</g, "&lt;") +
            "</p>",
    );
  }

  // Đăng ký lịch đào tạo (lưu DB / RAM)
  if (url.pathname === "/api/training" && req.method === "POST") {
    const form = await readBody(req);
    if (!form || !(form.name || "").trim() || !(form.phone || "").trim()) {
      return sendJson(res, 400, { error: "Thiếu họ tên hoặc số điện thoại." });
    }
    try {
      const id = await db.addTraining(form);
      db.addTrainingLog({
        name: form.name,
        phone: form.phone,
        action: "create",
        detail:
          "Đăng ký mới lịch đào tạo" +
          (form.sess_date ? " ngày " + sheet.isoToDmy(form.sess_date) : ""),
      }).catch(() => {});
      // Đẩy sang Excel SharePoint qua webhook (không chặn phản hồi)
      const cfg = loadConfig();
      const now = new Date();
      const p2 = (n) => (n < 10 ? "0" : "") + n;
      sheet
        .pushToSheet(cfg, {
          action: "create",
          id: id,
          name: form.name || "",
          phone: form.phone || "",
          email: form.email || "",
          province: form.province || "",
          district: form.district || "",
          position: form.position || "",
          mode: form.mode || "",
          sess_date: sheet.isoToDmy(form.sess_date || ""),
          sess_date_iso: form.sess_date || "",
          store: form.store || "",
          submitted_at:
            p2(now.getDate()) +
            "/" +
            p2(now.getMonth() + 1) +
            "/" +
            now.getFullYear() +
            " " +
            p2(now.getHours()) +
            ":" +
            p2(now.getMinutes()),
        })
        .catch(() => {});
      // Báo Zalo (qua webhook n8n) khi có đăng ký đào tạo mới
      const dDmy = sheet.isoToDmy(form.sess_date || "");
      notify
        .notifyZalo(cfg, {
          event: "training_register",
          name: form.name || "",
          phone: form.phone || "",
          email: form.email || "",
          position: form.position || "",
          store: form.store || "",
          date: dDmy,
          text:
            "✅ ĐĂNG KÝ ĐÀO TẠO MỚI\n• Họ tên: " +
            (form.name || "") +
            "\n• SĐT: " +
            (form.phone || "") +
            (form.position ? "\n• Vị trí: " + form.position : "") +
            (dDmy ? "\n• Ngày đào tạo: " + dDmy : "") +
            (form.store ? "\n• Cửa hàng: " + form.store : ""),
        })
        .catch(() => {});
      // Gửi email chào mừng cho ứng viên (tôn trọng bật/tắt + chế độ test trong dashboard)
      mailer.maybeSendTrainingEmail(cfg, form).catch(() => {});
      return sendJson(res, 200, { ok: true, id });
    } catch (e) {
      return sendJson(res, 500, {
        error: "Không lưu được đăng ký: " + e.message,
      });
    }
  }
  // Danh sách đăng ký đào tạo cho nhân viên (cần token đăng nhập agent)
  if (url.pathname === "/api/training" && req.method === "GET") {
    const token =
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      url.searchParams.get("token");
    if (!(await db.getSession(token)))
      return sendJson(res, 401, { error: "Cần đăng nhập nhân viên." });
    try {
      return sendJson(res, 200, { ok: true, rows: await db.listTraining() });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  // Sửa / xóa đăng ký đào tạo (cần token đăng nhập agent)
  if (
    url.pathname.startsWith("/api/training/") &&
    (req.method === "PUT" || req.method === "DELETE")
  ) {
    const token =
      (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "") ||
      url.searchParams.get("token");
    if (!(await db.getSession(token)))
      return sendJson(res, 401, { error: "Cần đăng nhập nhân viên." });
    const id = decodeURIComponent(url.pathname.slice("/api/training/".length));
    if (req.method === "DELETE") {
      try {
        const old = await db.getTrainingById(id);
        const n = await db.deleteTraining(id);
        if (n > 0)
          db.addTrainingLog({
            name: old && old.name,
            phone: old && old.phone,
            action: "delete",
            detail: "Xóa đăng ký đào tạo",
          }).catch(() => {});
        return sendJson(res, 200, { ok: n > 0, deleted: n });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    const form = await readBody(req);
    if (!form) return sendJson(res, 400, { error: "Dữ liệu không hợp lệ." });
    try {
      const oldRow = await db.getTrainingById(id);
      const old = oldRow ? Object.assign({}, oldRow) : null; // chụp ảnh trước khi cập nhật
      const n = await db.updateTraining(id, form);
      if (n > 0) {
        const labels = {
          name: "Họ tên",
          phone: "SĐT",
          email: "Email",
          province: "Tỉnh thành",
          district: "Quận huyện",
          position: "Vị trí",
          mode: "Hình thức đào tạo",
          store: "Cửa hàng",
        };
        const changes = [];
        if (old) {
          if (
            "sess_date" in form &&
            (old.sess_date || "") !== (form.sess_date || "")
          )
            changes.push(
              "đổi lịch đào tạo sang ngày " + sheet.isoToDmy(form.sess_date),
            );
          for (const k in labels) {
            if (k in form && (old[k] || "") !== (form[k] || ""))
              changes.push("đổi " + labels[k] + " → " + form[k]);
          }
        }
        db.addTrainingLog({
          name: form.name || (old && old.name),
          phone: form.phone || (old && old.phone),
          action: "update",
          detail: changes.length ? changes.join("; ") : "Cập nhật thông tin",
        }).catch(() => {});
      }
      return sendJson(res, 200, { ok: n > 0, updated: n });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Nhận hồ sơ ứng tuyển từ form -> tạo ứng viên trên 1Office
  if (url.pathname === "/api/apply" && req.method === "POST") {
    const cfg = loadConfig();
    if (!cfg)
      return sendJson(res, 500, { error: "Không đọc được config.json" });
    const form = await readBody(req);
    if (!form)
      return sendJson(res, 400, { error: "Dữ liệu form không hợp lệ." });
    return createCandidate(form, cfg, res);
  }

  // Thông tin tuyển dụng theo thương hiệu (công khai cho popup trang chủ)
  if (url.pathname === "/api/recruitment" && req.method === "GET") {
    try {
      return sendJson(res, 200, { rows: await db.listRecruitment() });
    } catch (e) {
      return sendJson(res, 200, { rows: [] });
    }
  }
  // Danh sách cửa hàng theo thương hiệu (đọc từ Google Sheet, cache) — cho form đào tạo
  if (url.pathname === "/api/stores" && req.method === "GET") {
    try {
      return sendJson(
        res,
        200,
        await stores.getStores(
          loadConfig(),
          url.searchParams.get("refresh") === "1",
        ),
      );
    } catch (e) {
      return sendJson(res, 200, {});
    }
  }
  // Danh sách việc làm (công khai cho trang tuyen-dung.html)
  if (url.pathname === "/api/jobs" && req.method === "GET") {
    try {
      return sendJson(res, 200, { rows: await db.listJobs() });
    } catch (e) {
      return sendJson(res, 200, { rows: [] });
    }
  }
  // Cấu hình form đào tạo (công khai cho trang dao-tao.html)
  if (url.pathname === "/api/trainingform" && req.method === "GET") {
    try {
      const v = await db.getSetting("trainingform");
      return sendJson(res, 200, (v && JSON.parse(v)) || TRAININGFORM_DEFAULTS);
    } catch (e) {
      return sendJson(res, 200, TRAININGFORM_DEFAULTS);
    }
  }
  // Cấu hình form ứng tuyển (công khai cho trang index.html)
  if (url.pathname === "/api/applyform" && req.method === "GET") {
    try {
      const v = await db.getSetting("applyform");
      return sendJson(res, 200, (v && JSON.parse(v)) || APPLYFORM_DEFAULTS);
    } catch (e) {
      return sendJson(res, 200, APPLYFORM_DEFAULTS);
    }
  }
  // Ảnh thương hiệu ở các thẻ "Cửa hàng" (công khai cho trang index.html)
  if (url.pathname === "/api/brandimages" && req.method === "GET") {
    try {
      const v = await db.getSetting("brandimages");
      return sendJson(res, 200, (v && JSON.parse(v)) || BRANDIMAGES_DEFAULTS);
    } catch (e) {
      return sendJson(res, 200, BRANDIMAGES_DEFAULTS);
    }
  }
  // Khoảnh khắc Vinh Hoa (công khai cho carousel trang chủ)
  if (url.pathname === "/api/gallery" && req.method === "GET") {
    try {
      return sendJson(res, 200, { rows: await db.listGallery() });
    } catch (e) {
      return sendJson(res, 200, { rows: [] });
    }
  }

  // Chatbot (khách + nhân viên)
  if (
    url.pathname.startsWith("/api/chat/") ||
    url.pathname.startsWith("/api/agent/")
  ) {
    return chatbot.handleChat(req, res, url, loadConfig);
  }

  if (url.pathname.startsWith("/api/")) {
    const key = url.pathname.slice("/api/".length).replace(/\/$/, "");
    const cfg = loadConfig();
    if (!cfg)
      return sendJson(res, 500, { error: "Không đọc được config.json" });
    return proxyTo1Office(key, cfg, res, url.searchParams);
  }
  serveStatic(req, res);
});

const cfg = loadConfig() || { port: 3000 };
const PORT = process.env.PORT || cfg.port || 3000;
const GARAN_CONTENT = [
  "A. Thông tin vị trí tuyển dụng:",
  "",
  "1. Store Manager/ Quản lý cửa hàng: https://drive.google.com/file/d/194pu5EhOvQ4ZYBZO9qsOR27YSoYIvjyi/view",
  "",
  "2. Nhân viên cửa hàng toàn thời gian/Captain/Tổ trưởng: https://drive.google.com/file/d/1mLiasQTcoDN2I4YTCaXzQ-_6-qxbOjav/view",
  "- Có kinh nghiệm làm việc tại các cửa hàng đồ ăn, uống (F&B) từ 6 tháng đến 1 năm.",
  "- Vận hành cửa hàng cùng cửa hàng trưởng, sắp xếp ca làm.",
  "- Là đội ngũ tiềm năng thăng tiến lên vị trí Trưởng ca, Quản lý cửa hàng.",
  "",
  "3. Nhân viên cửa hàng bán thời gian:",
  "- Đảm nhận các công việc về tư vấn bán hàng (Order); thanh toán, ...",
  "- Đảm bảo vệ sinh Cửa hàng.",
  "- Các công việc khác theo sự phân công của Quản lý cửa hàng.",
  "",
  "B. Quyền lợi:",
  "",
  "1. Cấp quản lý",
  "- Thu nhập:",
  "+ Quản lý cửa hàng: 10.000.000 - 11.200.000 + thưởng BSC từ 700.000 đến 2.000.000/tháng + thưởng doanh thu",
  "+ Trưởng ca: 7.500.000 - 8.500.000 + thưởng BSC từ 700.000 đến 2.000.000/tháng + thưởng doanh thu",
  "+ Tổ trưởng/Captain: 6.500.000 - 7.000.000 + thưởng BSC từ 700.000 đến 2.000.000/tháng + thưởng doanh thu",
  "- Phúc lợi:",
  "+ Thử việc 100% lương",
  "+ Tham gia BHXH sau 2 tháng thử việc",
  "+ Được đào tạo lên các vị trí cao hơn. Lộ trình đào tạo và phát triển rõ ràng, cụ thể",
  "+ Xét tăng lương, cấp bậc định kỳ 3 - 6 tháng",
  "+ Bảo hiểm sức khỏe 24/7 PVI",
  "+ Lương tháng 13",
  "+ Chính sách ưu đãi nội bộ",
  "+ Các hoạt động truyền thông nội bộ",
  "",
  "2. Nhân viên cửa hàng:",
  "- Toàn thời gian:",
  "+ Toàn thời gian chưa có kinh nghiệm, sẽ được đào tạo: 5.800.000đ/tháng đến 6.000.000đ/tháng.",
  "+ Thời gian làm việc: xoay ca fulltime (Ca 8 tiếng), cửa hàng mở từ 08:30 - 23:00, off 1 ngày/tuần.",
  "- Bán thời gian:",
  "+ Mức lương dao động từ 24.000đ đến 25.500đ/giờ + thưởng BSC từ 300.000đ đến 1.300.000đ/tháng",
  "+ Thời gian làm việc linh hoạt theo lịch đăng ký: 4-6 ca/tuần, 6-8 tiếng/ca, đăng ký trong khung giờ:",
  "Ca 8 tiếng: 08h00 - 16h00 & 16h00 - 23h00",
  "Ca 6 tiếng: 18h00 - 23h00 & 10h00 - 16h00",
  "+ Môi trường làm việc thân thiện, ưu tiên bố trí gần nhà.",
  "+ Được đào tạo lên các vị trí cao hơn. Lộ trình đào tạo và phát triển rõ ràng, cụ thể",
  "+ Xét tăng lương, cấp bậc định kỳ 3 - 6 tháng",
].join("\n");
function brandContent(brandDrink) {
  return [
    "A. Thông tin vị trí tuyển dụng:",
    "",
    "1. Quản lý cửa hàng / Trưởng ca:",
    "- Vận hành cửa hàng, sắp xếp ca làm, quản lý nhân sự & doanh thu.",
    "- Ưu tiên có kinh nghiệm F&B từ 6 tháng đến 1 năm.",
    "- Lộ trình thăng tiến lên Quản lý khu vực.",
    "",
    "2. Nhân viên pha chế & phục vụ (toàn thời gian):",
    "- Pha chế " + brandDrink + ", đồ uống theo công thức chuẩn.",
    "- Phục vụ, order, vệ sinh khu vực; được đào tạo bài bản từ đầu.",
    "",
    "3. Nhân viên bán thời gian:",
    "- Tư vấn bán hàng (Order), thanh toán, đảm bảo vệ sinh cửa hàng.",
    "- Ca linh hoạt, phù hợp với sinh viên.",
    "",
    "B. Quyền lợi:",
    "- Thử việc 100% lương; tham gia BHXH theo quy định.",
    "- Lộ trình thăng tiến rõ ràng: Nhân viên → Trưởng ca → Quản lý cửa hàng.",
    "- Xét tăng lương, cấp bậc định kỳ 3 - 6 tháng.",
    "- Lương tháng 13, chính sách ưu đãi nội bộ, các hoạt động truyền thông nội bộ.",
    "- Môi trường trẻ trung, thân thiện; ưu tiên bố trí gần nhà.",
  ].join("\n");
}
function deptContent(role, place) {
  return [
    "Mô tả công việc:",
    "- " + role,
    "- Làm việc " + (place || "tại văn phòng TP.HCM") + ", toàn thời gian.",
    "",
    "Quyền lợi:",
    "- Lương thỏa thuận theo năng lực; thử việc 100% lương.",
    "- Tham gia BHXH; lương tháng 13; xét tăng lương định kỳ.",
    "- Lộ trình đào tạo & phát triển rõ ràng.",
    "- Chính sách ưu đãi nội bộ; các hoạt động truyền thông nội bộ.",
  ].join("\n");
}
const DEPT_OFFICE = [
  {
    brand: "marketing",
    name: "Marketing",
    role: "Lập kế hoạch & triển khai truyền thông thương hiệu, content, chạy quảng cáo.",
  },
  {
    brand: "hr",
    name: "Nhân sự (HR)",
    role: "Tuyển dụng, đào tạo, vận hành đội ngũ; xây dựng chính sách nhân sự.",
  },
  {
    brand: "it",
    name: "IT",
    role: "Vận hành, hỗ trợ hệ thống, phần mềm và hạ tầng công nghệ.",
  },
  {
    brand: "finance",
    name: "Tài chính – Kế toán",
    role: "Quản lý sổ sách, báo cáo tài chính, kiểm soát chi phí.",
  },
];
const DEPT_PROD = [
  {
    brand: "sanxuat",
    name: "Sản xuất / Vận hành",
    role: "Tham gia quy trình sản xuất, vận hành dây chuyền theo tiêu chuẩn.",
    place: "tại nhà máy",
  },
  {
    brand: "qaqc",
    name: "QA / QC",
    role: "Kiểm soát chất lượng nguyên liệu & thành phẩm theo tiêu chuẩn ATVSTP.",
    place: "tại nhà máy",
  },
  {
    brand: "khovan",
    name: "Kho vận",
    role: "Quản lý kho, xuất nhập hàng, điều phối giao vận.",
    place: "tại kho/nhà máy",
  },
  {
    brand: "kythuat",
    name: "Kỹ thuật / Bảo trì",
    role: "Bảo trì, sửa chữa máy móc thiết bị; đảm bảo vận hành ổn định.",
    place: "tại nhà máy",
  },
];
const RECRUIT_DEFAULTS = [
  {
    brand: "maycha",
    name: "MayCha",
    title: "Thông tin tuyển dụng — MayCha",
    content: brandContent("trà sữa"),
  },
  {
    brand: "tamhao",
    name: "Hồng Trà Sữa Tam Hảo",
    title: "Thông tin tuyển dụng — Hồng Trà Sữa Tam Hảo",
    content: brandContent("hồng trà sữa"),
  },
  {
    brand: "gagion",
    name: "Gà Giòn Sốt Ba Cô Gái",
    title: "🍗 Tụi mình tìm đồng đội cho Gà rán",
    content: GARAN_CONTENT,
  },
  {
    brand: "trahu",
    name: "Trà Hú",
    title: "Thông tin tuyển dụng — Trà Hú",
    content: brandContent("trà"),
  },
]
  .concat(
    DEPT_OFFICE.map(function (d) {
      return {
        brand: d.brand,
        name: d.name,
        title: "Thông tin tuyển dụng — " + d.name,
        content: deptContent(d.role, "tại văn phòng TP.HCM"),
      };
    }),
  )
  .concat(
    DEPT_PROD.map(function (d) {
      return {
        brand: d.brand,
        name: d.name,
        title: "Thông tin tuyển dụng — " + d.name,
        content: deptContent(d.role, d.place),
      };
    }),
  );

const TRAININGFORM_DEFAULTS = {
  title: "Maycha - Thông Tin Đăng Ký Tham Gia Lớp Đào Tạo Đầu Vào",
  desc: "Khi bạn gửi biểu mẫu này, nó sẽ không tự động thu thập các chi tiết của bạn như tên và địa chỉ email trừ khi bạn tự cung cấp nó.",
  dateNote:
    "(Lưu ý: Ngày bắt đầu lớp đào tạo là cố định Thứ 2 hoặc Thứ 5 hàng tuần, bạn vui lòng xem lịch hiện tại rồi chọn một trong hai ngày này. Ví dụ: Bạn phỏng vấn đạt vào ngày Thứ 6 - 18/12, bạn có thể chọn đào tạo vào Thứ 2 - 21/12 HOẶC Thứ 5 - 24/12 tùy theo lịch rảnh của bạn)",
  positions: [
    "Quản Lý (SM)",
    "Giám Sát (SL)",
    "Tổ Trưởng (ASF)",
    "Nhân Viên Full-time (SF)",
    "Nhân Viên Part-time (Staff)",
  ],
  modes: [
    "Tham gia trực tiếp toàn bộ",
    "Tham gia Online ngày đầu - trực tiếp ngày thứ hai",
    "Tham gia Online toàn bộ",
  ],
  brands: ["Trà Sữa MayCha", "Hồng Trà Sữa Tam Hảo", "Gà Giòn Sốt Ba Cô Gái"],
};

// Cấu hình mặc định form ứng tuyển (trang index.html). 3 khối là KHÓA CỐ ĐỊNH
// điều khiển cascading (brand/CV) + định tuyến chiến dịch 1Office — không đổi tên.
const APPLYFORM_DEFAULTS = {
  title: "Ứng tuyển ngay",
  desc: "Ứng tuyển nhanh không cần CV. Phòng nhân sự sẽ kết nối và hẹn lịch phỏng vấn với bạn trong 24-48 giờ làm việc.",
  genders: ["Nam", "Nữ", "Khác"],
  brands: ["MayCha", "Hồng Trà Sữa Tam Hảo", "Gà Giòn Sốt Ba Cô Gái"],
  positions: {
    "Cửa hàng": [
      "Quản lý cửa hàng", "Trưởng ca",
      "Nhân viên Full-time (có > 6 tháng kinh nghiệm)",
      "Nhân viên Part-time (có > 6 tháng kinh nghiệm)",
      "Nhân viên Part-time (chưa có kinh nghiệm)",
      "Nhân viên Full-time (chưa có kinh nghiệm nhưng làm được 8 tiếng)",
      "Nhân viên thời vụ Tết", "Nhân viên Part-time (ca đêm)",
    ],
    "Khối Văn Phòng": [
      "Marketing / Truyền thông", "Nhân sự (HR)", "IT", "Tài chính - Kế toán",
      "Media Production (Kênh TikTok)", "Marcom Executive", "Senior Marcom Executive",
      "Social Media & TikTok Content Executive", "Senior Social Content (TikTok)",
      "Senior Trade Online & Partnership", "Nhân Viên Tuyển Dụng Mass",
      "Chuyên Viên Tuyển Dụng", "Cộng Tác Viên Tuyển Dụng", "Cộng Tác Viên Tuyển Dụng (Mass)",
      "Chuyên Viên Đào Tạo", "Chuyên Viên Đào Tạo Nghiệp Vụ", "Chuyên Viên Đào Tạo Vận Hành",
      "Kế Toán Chi Phí", "Kế Toán Tài Sản", "Finance Control Executive", "Finance Analyst Intern",
      "Kiểm Soát Tuân Thủ Nội Bộ (Internal Control)", "Chuyên Viên Mua Hàng",
      "Thực Tập Sinh IT Hỗ Trợ", "Thực Tập Sinh Hỗ Trợ Trực Tuyến",
    ],
    "Khối Kho & Xưởng Sản Xuất": [
      "Sản xuất / Vận hành", "QA / QC", "Kho vận", "Kỹ thuật / Bảo trì",
      "Nhân Viên Kho/Soạn Hàng Không Yêu Cầu Kinh Nghiệm",
      "Thực Tập Sinh Admin Xưởng Sản Xuất", "Thực Tập Sinh Kiểm Soát Chất Lượng",
    ],
  },
};

// Ảnh mặc định 4 thẻ thương hiệu ở tab "Cửa hàng" trang chủ (khớp đúng ảnh đang gắn cứng trong index.html)
const BRANDIMAGES_DEFAULTS = {
  maycha: "images/ảnh tuyển dụng/ảnh tuyển dụng maycha.jpg",
  tamhao: "images/ảnh tuyển dụng/ảnh tuyển dụng ba cô gái.jpg",
  gagion: "images/ảnh tuyển dụng/ảnh tuyển dụng gà rán.jpg",
  trahu: "images/ảnh tuyển dụng/ảnh tuyển dụng trà hú.jpg",
};

chatbot
  .init()
  .then(() => {
    const bc =
      cfg.oneOffice &&
      cfg.oneOffice.create &&
      cfg.oneOffice.create.brandCampaigns;
    if (bc) return db.seedBrandCampaigns(bc);
  })
  .then(() => db.seedRecruitment(RECRUIT_DEFAULTS))
  .then(() =>
    db.seedGallery([
      "images/anh vinh danh/1.jpg",
      "images/anh vinh danh/2.jpg",
      "images/anh vinh danh/3.jpg",
      "images/anh vinh danh/4.jpg",
      "images/anh vinh danh/5.jpg",
    ]),
  )
  .then(async () => {
    if (!(await db.getSetting("trainingform")))
      await db.setSetting(
        "trainingform",
        JSON.stringify(TRAININGFORM_DEFAULTS),
      );
  })
  .then(async () => {
    if (!(await db.getSetting("applyform")))
      await db.setSetting("applyform", JSON.stringify(APPLYFORM_DEFAULTS));
  })
  .then(async () => {
    if (!(await db.getSetting("brandimages")))
      await db.setSetting(
        "brandimages",
        JSON.stringify(BRANDIMAGES_DEFAULTS),
      );
  })
  .then(async () => {
    if (!(await db.getSetting("emailcfg")))
      await db.setSetting("emailcfg", JSON.stringify(mailer.EMAIL_DEFAULTS));
  })
  .then(() => {
    try {
      return db.seedJobs(
        JSON.parse(
          fs.readFileSync(path.join(__dirname, "jobs-seed.json"), "utf8"),
        ),
      );
    } catch (e) {
      console.warn(" [jobs] seed lỗi:", e.message);
    }
  })
  .catch((e) => console.error(" [db] init lỗi:", e.message));
server.listen(PORT, () => {
  console.log("--------------------------------------------------");
  console.log(" Thịnh Thế Vinh Hoa — server đang chạy");
  console.log(" Trang tuyển dụng : http://localhost:" + PORT + "/");
  console.log(" Trang quản trị   : http://localhost:" + PORT + "/admin");
  console.log(" Đăng ký đào tạo  : http://localhost:" + PORT + "/dao-tao.html");
  console.log("--------------------------------------------------");
});
