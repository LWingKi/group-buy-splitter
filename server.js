// 夾單計數機 (Group Buy Splitter): a zero-dependency Node server.
// Data is kept in data.json next to this file (override with DATA_FILE).
// Identity is a Discord name sent in the X-User header; there are no passwords.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

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

function cleanName(raw) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw httpError(400, "請輸入 Discord 名稱。");
  if (name.length > 40) throw httpError(400, "名稱最多 40 個字元。");
  return name;
}

// Returns the canonical user record, creating it if needed. Names are unique ignoring case.
function ensureUser(raw) {
  const name = cleanName(raw);
  const k = key(name);
  if (!db.users[k]) { db.users[k] = { name, createdAt: Date.now() }; save(); }
  return db.users[k];
}

// Currencies offered in the dropdown. Older group buys may hold a free-text symbol such as "$".
const CURRENCIES = ["HKD", "USD", "JPY", "CNY", "KRW", "TWD", "GBP", "EUR", "AUD", "CAD", "SGD", "MYR", "THB"];
function cleanCurrency(c) {
  if (!CURRENCIES.includes(c)) throw httpError(400, "請喺清單揀一種貨幣。");
  return c;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

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
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req) : {};

  if (method === "POST" && parts[0] === "login") {
    const u = ensureUser(body.username);
    return { username: u.name };
  }

  const meHeader = req.headers["x-user"];
  if (!meHeader) throw httpError(401, "請先輸入你的 Discord 名稱登入。");
  const me = ensureUser(decodeURIComponent(meHeader)).name;

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
        id: v.id, name: v.name, organiser: v.organiser, createdAt: v.createdAt, currency: v.currency, closed: !!v.closed,
        participantCount: v.participants.length, itemCount: v.items.length,
        grandTotalCents: v.summary.grandTotalCents, myTotalCents: mine ? mine.totalCents : null,
        pendingPrices: v.summary.pendingPrices,
      };
    };
    const byNew = (a, b) => (!!a.closed - !!b.closed) || b.createdAt - a.createdAt;  // open ones first
    return {
      hosting: all.filter((v) => v.role === "organiser").sort(byNew).map(brief),
      joined: all.filter((v) => v.role === "participant").sort(byNew).map(brief),
      others: all.filter((v) => v.role === "viewer").sort(byNew).map(brief),
    };
  }

  if (parts[0] !== "groupbuys") throw httpError(404, "找不到。");
  const id = parts[1];

  // Create
  if (!id && method === "POST") {
    const name = String(body.name || "").trim();
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
      const n = String(body.name || "").trim();
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
      const name = String(body.name || "").trim();
      if (!name) throw httpError(400, "請輸入貨品名稱。");
      let priceCents = null;
      if (body.price !== undefined && body.price !== "" && body.price !== null) {
        priceCents = toCents(body.price, "價錢");
      }
      gb.items.push({ id: newId(), name: name.slice(0, 80), priceCents, addedBy: me });
      save(); return view(gb, me);
    }
    const item = gb.items.find((it) => it.id === itemId);
    if (!item) throw httpError(404, "這件貨品已被移除。");
    if (method === "PATCH") {
      if ("price" in body) { requireItemOwner(item, "更改價錢"); item.priceCents = toCents(body.price, "價錢"); }
      if ("name" in body) {
        const n = String(body.name || "").trim();
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
function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic(res, "/"); // SPA fallback
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
  try {
    const out = await api(req, res, url);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    if (!e.status) console.error(e);
    res.writeHead(e.status || 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.status ? e.message : "伺服器出錯，請稍後再試。" }));
  }
}).listen(PORT, () => console.log(`Group Buy Splitter running on http://localhost:${PORT}`));
