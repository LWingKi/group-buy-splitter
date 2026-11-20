// 夾單計數機 (Group Buy Splitter): a zero-dependency Node server.
// Data is kept in data.json next to this file (override with DATA_FILE).
// Identity is a Discord name sent in the X-User header; there are no passwords.
// Set ACCESS_CODE to require a shared code (sent in X-Access-Code) for every API call.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ACCESS_CODE = process.env.ACCESS_CODE || "";
if (!ACCESS_CODE) console.warn("ACCESS_CODE is not set: anyone with the link can use the site.");

// Caps so nobody can fill up storage.
const LIMITS = { users: 3000, groupbuys: 1000, openPerOrganiser: 20, items: 100, participants: 100 };

// ---------- storage ----------
let db = { users: {}, groupbuys: {} };
if (fs.existsSync(DATA_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { console.error("Could not read data file, starting empty:", e.message); }
}
db.users ||= {};
db.groupbuys ||= {};

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 50);
}

// ---------- helpers ----------
const key = (name) => String(name).trim().toLowerCase();
const newId = () => crypto.randomBytes(6).toString("base64url");

// Removes control and invisible formatting characters, collapses spaces.
function cleanText(raw) {
  return String(raw ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim().replace(/\s+/g, " ");
}
const RESERVED = new Set(["__proto__", "constructor", "prototype", "hasownproperty", "tostring", "valueof"]);

function cleanName(raw) {
  const name = cleanText(raw);
  if (!name) throw httpError(400, "請輸入 Discord 名稱。");
  if (name.length > 40) throw httpError(400, "名稱最多 40 個字元。");
  if (RESERVED.has(key(name))) throw httpError(400, "呢個名稱唔可以用，請換一個。");
  return name;
}

// Returns the canonical user record, creating it if needed. Names are unique ignoring case.
function ensureUser(raw) {
  const name = cleanName(raw);
  const k = key(name);
  if (!Object.hasOwn(db.users, k)) {
    if (Object.keys(db.users).length >= LIMITS.users) throw httpError(403, "用戶數目已達上限，請聯絡管理員。");
    db.users[k] = { name, createdAt: Date.now() }; save();
  }
  return db.users[k];
}

// Currencies offered in the dropdown. Older group buys may hold a free-text symbol such as "$".
const CURRENCIES = ["HKD", "USD", "JPY", "CNY", "KRW", "TWD", "GBP", "EUR", "AUD", "CAD", "SGD", "MYR", "THB"];
function cleanCurrency(c) {
  if (!CURRENCIES.includes(c)) throw httpError(400, "請喺清單揀一種貨幣。");
  return c;
}

function httpError(status, message, code) { const e = new Error(message); e.status = status; e.code = code; return e; }

// ---------- abuse protection ----------
// The client's IP: the last X-Forwarded-For entry is the one added by the host's proxy.
function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || "?";
}
// Fixed-window counters per IP: { bucket -> Map(ip -> {n, start}) }.
const counters = {};
function hit(bucket, ip, max, windowMs) {
  const m = (counters[bucket] ||= new Map());
  const now = Date.now();
  let c = m.get(ip);
  if (!c || now - c.start > windowMs) { c = { n: 0, start: now }; m.set(ip, c); }
  c.n++;
  return c.n > max;
}
setInterval(() => { for (const m of Object.values(counters)) m.clear(); }, 60 * 60 * 1000).unref();
const tooMany = () => httpError(429, "太多請求，請稍後再試。");

function checkAccessCode(req, ip) {
  if (!ACCESS_CODE) return;
  if ((counters.badCode?.get(ip)?.n || 0) >= 10 && Date.now() - counters.badCode.get(ip).start < 15 * 60 * 1000) {
    throw httpError(429, "通行碼錯得太多次，請 15 分鐘後再試。");
  }
  const given = Buffer.from(String(req.headers["x-access-code"] || ""));
  const want = Buffer.from(ACCESS_CODE);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    hit("badCode", ip, 10, 15 * 60 * 1000);
    throw httpError(401, "通行碼唔啱，請問返開團人。", "bad_code");
  }
}

function toCents(v, field) {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${field}必須是 0 或以上的數字。`);
  if (n > 1e7) throw httpError(400, `${field}太大。`);
  return Math.round(n * 100);
}

// Split `total` cents across weights so the parts add up exactly (largest remainder).
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || !sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let j = 0; left > 0; j = (j + 1) % order.length, left--) out[order[j][1]]++;
  return out;
}

function summarize(gb) {
  const qty = (u, itemId) => gb.quantities[key(u)]?.[itemId] || 0;
  const items = gb.items.map((it) => {
    const totalQty = gb.participants.reduce((a, u) => a + qty(u, it.id), 0);
    return { ...it, totalQty, totalCents: it.priceCents == null ? null : totalQty * it.priceCents };
  });
  const people = gb.participants.map((u) => {
    let subtotal = 0, count = 0;
    for (const it of gb.items) {
      const q = qty(u, it.id);
      count += q;
      if (it.priceCents != null) subtotal += q * it.priceCents;
    }
    return { username: u, subtotalCents: subtotal, itemCount: count };
  });

  let weights;
  if (gb.shippingSplit === "equal") {
    const buyers = people.filter((p) => p.itemCount > 0);
    weights = people.map((p) => (buyers.length ? (p.itemCount > 0 ? 1 : 0) : 1));
  } else if (gb.shippingSplit === "items") {
    weights = people.map((p) => p.itemCount);
  } else {
    weights = people.map((p) => p.subtotalCents);
  }
  // Yen and won have no cents, so split shipping in whole units for them.
  const unit = ["JPY", "KRW"].includes(gb.currency) ? 100 : 1;
  const shares = allocate(Math.round((gb.shippingCents || 0) / unit), weights).map((x) => x * unit);
  people.forEach((p, i) => { p.shippingCents = shares[i]; p.totalCents = p.subtotalCents + shares[i]; });

  const itemsCents = items.reduce((a, it) => a + (it.totalCents || 0), 0);
  const allocated = shares.reduce((a, b) => a + b, 0);
  return {
    items, people,
    itemsCents,
    shippingCents: gb.shippingCents || 0,
    unallocatedShippingCents: (gb.shippingCents || 0) - allocated,
    grandTotalCents: itemsCents + (gb.shippingCents || 0),
    pendingPrices: gb.items.filter((it) => it.priceCents == null).length,
  };
}

// Closed group buys stay in the archive for one calendar month, then are deleted.
function archiveUntil(closedAt) {
  const d = new Date(closedAt);
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}
function purgeExpired() {
  const now = Date.now();
  let n = 0;
  for (const [id, gb] of Object.entries(db.groupbuys)) {
    if (gb.closed && gb.closedAt && archiveUntil(gb.closedAt) <= now) { delete db.groupbuys[id]; n++; }
  }
  if (n) { save(); console.log(`Deleted ${n} archived group buy(s) older than one month.`); }
}

// 已交收 / 已付款: the organiser sees everyone's, a member sees only their own.
function visibleStatus(gb, me, isOrganiser, isMember) {
  const all = gb.status || {};
  if (isOrganiser) return all;
  if (isMember && all[key(me)]) return { [key(me)]: all[key(me)] };
  return {};
}

function view(gb, me) {
  const isOrganiser = key(gb.organiser) === key(me);
  const isMember = isOrganiser || gb.participants.some((u) => key(u) === key(me));
  return {
    ...gb,
    status: visibleStatus(gb, me, isOrganiser, isMember),
    deleteAt: gb.closed && gb.closedAt ? archiveUntil(gb.closedAt) : null,
    role: isOrganiser ? "organiser" : isMember ? "participant" : "viewer",
    summary: summarize(gb),
  };
}

function loadGb(id, me, { member = true } = {}) {
  const gb = db.groupbuys[id];
  if (!gb) throw httpError(404, "找不到這個團購，可能已被刪除。");
  const v = view(gb, me);
  if (member && v.role === "viewer") throw httpError(403, "只有團長和團員可以修改這個團購。");
  return { gb, role: v.role };
}

function requireOrganiser(role, what) {
  if (role !== "organiser") throw httpError(403, `只有團長可以${what}。`);
}

// ---------- API ----------
async function api(req, res, url) {
  const method = req.method;
  const ip = clientIp(req);
  if (url.pathname === "/api/config") return { accessCodeRequired: !!ACCESS_CODE };
  checkAccessCode(req, ip);
  if (hit("all", ip, 300, 60 * 1000)) throw tooMany();
  if (method !== "GET" && hit("write", ip, 60, 60 * 1000)) throw tooMany();
  purgeExpired();
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req) : {};

  if (method === "POST" && parts[0] === "login") {
    if (hit("login", ip, 20, 10 * 60 * 1000)) throw tooMany();
    const u = ensureUser(body.username);
    return { username: u.name };
  }

  const meHeader = req.headers["x-user"];
  if (!meHeader) throw httpError(401, "請先輸入你的 Discord 名稱登入。");
  let meName;
  try { meName = decodeURIComponent(meHeader); } catch { throw httpError(400, "名稱格式錯誤。"); }
  const me = ensureUser(meName).name;

  if (method === "GET" && parts[0] === "users") {
    const q = key(url.searchParams.get("q") || "");
    return Object.values(db.users).map((u) => u.name)
      .filter((n) => !q || key(n).includes(q)).sort().slice(0, 20);
  }

  if (parts[0] === "me" && parts[1] === "groupbuys" && method === "GET") {
    const all = Object.values(db.groupbuys).map((gb) => view(gb, me));
    const brief = (v) => {
      const mine = v.summary.people.find((p) => key(p.username) === key(me));
      return {
        id: v.id, name: v.name, organiser: v.organiser, createdAt: v.createdAt, currency: v.currency, closed: !!v.closed, deleteAt: v.deleteAt,
        participantCount: v.participants.length, itemCount: v.items.length,
        grandTotalCents: v.summary.grandTotalCents, myTotalCents: mine ? mine.totalCents : null,
        pendingPrices: v.summary.pendingPrices,
      };
    };
    const byNew = (a, b) => (!!a.closed - !!b.closed) || b.createdAt - a.createdAt;  // open ones first
    return {
      hosting: all.filter((v) => !v.closed && v.role === "organiser").sort(byNew).map(brief),
      joined: all.filter((v) => !v.closed && v.role === "participant").sort(byNew).map(brief),
      others: all.filter((v) => !v.closed && v.role === "viewer").sort(byNew).map(brief),
      // Closed group buys you ran or joined, soonest to be deleted first.
      archived: all.filter((v) => v.closed && v.role !== "viewer").sort((a, b) => (a.deleteAt || 0) - (b.deleteAt || 0)).map(brief),
    };
  }

  if (parts[0] !== "groupbuys") throw httpError(404, "找不到。");
  const id = parts[1];

  // Create
  if (!id && method === "POST") {
    if (Object.keys(db.groupbuys).length >= LIMITS.groupbuys) throw httpError(403, "團購數目已達上限，請先刪除舊團。");
    const openMine = Object.values(db.groupbuys).filter((g) => !g.closed && key(g.organiser) === key(me)).length;
    if (openMine >= LIMITS.openPerOrganiser) throw httpError(403, `你最多可以同時開 ${LIMITS.openPerOrganiser} 個團，請先完結舊團。`);
    const name = cleanText(body.name);
    if (!name) throw httpError(400, "請輸入團購名稱。");
    if (name.length > 80) throw httpError(400, "團購名稱最多 80 個字元。");
    const gb = {
      id: newId(), name, organiser: me, createdAt: Date.now(),
      currency: body.currency ? cleanCurrency(body.currency) : "HKD",
      shippingCents: 0, shippingSplit: "subtotal",
      items: [], participants: body.includeMe === false ? [] : [me], quantities: {},
    };
    db.groupbuys[gb.id] = gb; save();
    return view(gb, me);
  }

  if (!id) throw httpError(404, "找不到。");

  // Read (anyone with the link can view)
  if (parts.length === 2 && method === "GET") {
    const { gb } = loadGb(id, me, { member: false });
    return view(gb, me);
  }

  // Anyone can join a group buy themselves.
  if (parts[2] === "participants" && method === "POST" && key(body.username || "") === key(me)) {
    const { gb } = loadGb(id, me, { member: false });
    if (gb.closed) throw httpError(403, "呢個團已經完結，唔可以再加入。");
    if (gb.participants.some((p) => key(p) === key(me))) throw httpError(409, "你已經喺呢個團入面。");
    if (gb.participants.length >= LIMITS.participants) throw httpError(403, `每個團最多 ${LIMITS.participants} 人。`);
    gb.participants.push(me); save(); return view(gb, me);
  }

  const { gb, role } = loadGb(id, me);
  // A closed group buy is read-only; the organiser can still reopen or delete it.
  const isReopen = parts[2] === "reopen" && method === "POST";
  const isDeleteGb = parts.length === 2 && method === "DELETE";
  if (gb.closed && !isReopen && !isDeleteGb) throw httpError(403, "呢個團已經完結，唔可以再改。團長可以重新開放。");
  // The organiser, or whoever added the item, may change its price or remove it.
  const requireItemOwner = (item, what) => {
    if (role !== "organiser" && key(item.addedBy || "") !== key(me)) throw httpError(403, `只有團長或加呢件貨品嘅人可以${what}。`);
  };

  // Update group buy settings
  if (parts.length === 2 && method === "PATCH") {
    if ("name" in body) {
      requireOrganiser(role, "更改團購名稱");
      const n = cleanText(body.name);
      if (!n) throw httpError(400, "請輸入團購名稱。");
      gb.name = n.slice(0, 80);
    }
    if ("currency" in body) {
      requireOrganiser(role, "更改貨幣");
      gb.currency = cleanCurrency(body.currency);
    }
    if ("shippingCents" in body || "shipping" in body) {
      gb.shippingCents = toCents(body.shipping ?? body.shippingCents / 100, "運費") || 0;
    }
    if ("shippingSplit" in body) {
      if (!["subtotal", "equal", "items"].includes(body.shippingSplit)) throw httpError(400, "未知的運費分攤方式。");
      gb.shippingSplit = body.shippingSplit;
    }
    save(); return view(gb, me);
  }

  if (parts.length === 2 && method === "DELETE") {
    requireOrganiser(role, "刪除團購");
    delete db.groupbuys[id]; save();
    return { deleted: true };
  }

  // Close / reopen
  if (parts[2] === "close" && method === "POST") {
    requireOrganiser(role, "完結團購");
    gb.closed = true; gb.closedAt = Date.now();
    save(); return view(gb, me);
  }
  if (isReopen) {
    requireOrganiser(role, "重新開放團購");
    gb.closed = false; delete gb.closedAt;
    save(); return view(gb, me);
  }

  // 已交收 / 已付款 (organiser only)
  if (parts[2] === "status" && method === "PUT") {
    requireOrganiser(role, "更改交收同付款狀態");
    const target = gb.participants.find((p) => key(p) === key(body.username));
    if (!target) throw httpError(400, "這個人不在這個團購內。");
    const row = ((gb.status ||= {})[key(target)] ||= { paid: false, delivered: false });
    if ("paid" in body) row.paid = !!body.paid;
    if ("delivered" in body) row.delivered = !!body.delivered;
    save(); return view(gb, me);
  }

  // Items
  if (parts[2] === "items") {
    const itemId = parts[3];
    if (!itemId && method === "POST") {
      const name = cleanText(body.name);
      if (!name) throw httpError(400, "請輸入貨品名稱。");
      let priceCents = null;
      if (body.price !== undefined && body.price !== "" && body.price !== null) {
        priceCents = toCents(body.price, "價錢");
      }
      if (gb.items.length >= LIMITS.items) throw httpError(403, `每個團最多 ${LIMITS.items} 款貨品。`);
      gb.items.push({ id: newId(), name: name.slice(0, 80), priceCents, addedBy: me });
      save(); return view(gb, me);
    }
    const item = gb.items.find((it) => it.id === itemId);
    if (!item) throw httpError(404, "這件貨品已被移除。");
    if (method === "PATCH") {
      if ("price" in body) { requireItemOwner(item, "更改價錢"); item.priceCents = toCents(body.price, "價錢"); }
      if ("name" in body) {
        const n = cleanText(body.name);
        if (!n) throw httpError(400, "請輸入貨品名稱。");
        item.name = n.slice(0, 80);
      }
      save(); return view(gb, me);
    }
    if (method === "DELETE") {
      requireItemOwner(item, "移除佢");
      gb.items = gb.items.filter((it) => it.id !== itemId);
      for (const q of Object.values(gb.quantities)) delete q[itemId];
      save(); return view(gb, me);
    }
  }

  // Participants
  if (parts[2] === "participants") {
    if (method === "POST") {
      const u = ensureUser(body.username).name;
      if (gb.participants.some((p) => key(p) === key(u))) throw httpError(409, `${u} 已經在這個團購內。`);
      if (gb.participants.length >= LIMITS.participants) throw httpError(403, `每個團最多 ${LIMITS.participants} 人。`);
      gb.participants.push(u); save(); return view(gb, me);
    }
    if (method === "DELETE") {
      const target = decodeURIComponent(parts[3] || "");
      if (role !== "organiser" && key(target) !== key(me)) throw httpError(403, "你只可以將自己移除。如要移除其他人，請聯絡團長。");
      gb.participants = gb.participants.filter((p) => key(p) !== key(target));
      delete gb.quantities[key(target)];
      if (gb.status) delete gb.status[key(target)];
      save(); return view(gb, me);
    }
  }

  // Quantities
  if (parts[2] === "quantities" && method === "PUT") {
    const target = gb.participants.find((p) => key(p) === key(body.username));
    if (!target) throw httpError(400, "這個人不在這個團購內。");
    if (role !== "organiser" && key(target) !== key(me)) throw httpError(403, "你只可以更改自己的數量。");
    if (!gb.items.some((it) => it.id === body.itemId)) throw httpError(404, "這件貨品已被移除。");
    const q = Number(body.qty);
    if (!Number.isInteger(q) || q < 0 || q > 100000) throw httpError(400, "數量必須是 0 或以上的整數。");
    const row = (gb.quantities[key(target)] ||= {});
    if (q === 0) delete row[body.itemId]; else row[body.itemId] = q;
    save(); return view(gb, me);
  }

  throw httpError(404, "找不到。");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e5) { reject(httpError(413, "請求太大。")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, "資料格式錯誤。")); } });
    req.on("error", reject);
  });
}

// ---------- static files ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};
function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic(res, "/"); // SPA fallback
  }
  if (file.endsWith(".html")) {
    // Only scripts carrying this request's nonce may run, so injected <script> tags are refused.
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = fs.readFileSync(file, "utf8").replace(/<script>/g, `<script nonce="${nonce}">`);
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": TYPES[".html"],
      "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join("; "),
    });
    return res.end(html);
  }
  res.writeHead(200, { ...BASE_HEADERS, "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000);  // hourly, as well as on every request

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
  try {
    const out = await api(req, res, url);
    res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { ...BASE_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: e.status ? e.message : "伺服器出錯，請稍後再試。", code: e.code }));
  }
}).listen(PORT, () => console.log(`Group Buy Splitter running on http://localhost:${PORT}`));
