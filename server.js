require("dotenv").config();
const express = require("express");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { db, newId, file } = require("./db");
const { seedDemo } = require("./seed");
const { CATS, SURP, CROPS, HARV, FD, ROLES } = require("./constants");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production";
const DEMO_MODE = process.env.DEMO_MODE !== "false";
const SECRET = process.env.JWT_SECRET || (PROD ? null : "dev-secret-change-me");
if (!SECRET) { console.error("JWT_SECRET must be set in production."); process.exit(1); }
if (!process.env.JWT_SECRET) console.warn("! Using the development JWT secret. Set JWT_SECRET in .env before deploying.");
const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

if (!db.prepare("SELECT 1 FROM users LIMIT 1").get() && DEMO_MODE) { seedDemo(); console.log("Seeded demo data."); }

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOADS, { maxAge: "7d", setHeaders: r => r.setHeader("X-Content-Type-Options", "nosniff") }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- helpers ---------- */
const bad = (m, s = 400) => { const e = new Error(m); e.status = s; throw e; };
const h = fn => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: "Server error. Please try again." });
  }
};
// Text shown inside HTML/JS in the frontend: keep to a safe character set.
const TEXT = /^[\p{L}\p{N} .,\-()#\/:]+$/u;
const text = (v, label, max = 80) => {
  const s = String(v ?? "").trim().replace(/\s+/g, " ");
  if (!s) bad(`Enter ${label}.`);
  if (s.length > max) bad(`${label[0].toUpperCase() + label.slice(1)} is too long (max ${max} characters).`);
  if (!TEXT.test(s)) bad(`${label[0].toUpperCase() + label.slice(1)} may only contain letters, numbers, spaces and . , - ( ) # / :`);
  return s;
};
const phone = v => {
  const p = String(v ?? "").replace(/[\s-]/g, "").replace(/^(\+91|0)/, "");
  if (!/^[6-9]\d{9}$/.test(p)) bad("Enter a valid 10-digit mobile number.");
  return p;
};
const num = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad(`Enter ${label} between ${min} and ${max}.`);
  return n;
};
const ist = iso => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) bad("Choose a photo as proof of the listing.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 600 * 1024) bad("Choose a smaller photo (max 600 KB).");
  const ok = { jpeg: buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), png: buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), webp: buf.subarray(0, 4).toString() === "RIFF" };
  if (!ok[m[1]]) bad("Choose a valid image file.");
  const name = crypto.randomUUID() + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return "/uploads/" + name;
}
const rmPhoto = url => { if (url && url.startsWith("/uploads/")) fs.rmSync(path.join(UPLOADS, path.basename(url)), { force: true }); };

/* ---------- row -> frontend shape ---------- */
const sUser = u => ({ id: u.id, n: u.name, r: u.role, ph: u.phone || "" });
const sL = r => ({ id: r.id, rid: r.rid, rn: r.rn, type: r.type, cat: r.cat, kg: r.kg, loc: r.loc, time: r.time_txt, ph: r.phone || "", photo: r.photo || "", stage: r.stage, pid: r.pid, recv: r.recv, demo: r.demo });
const sP = r => ({ id: r.id, n: r.name, t: r.type, d: r.dist, cap: r.cap, cats: JSON.parse(r.cats) });
const sC = r => ({ id: r.id, pid: r.pid, n: r.name, kg: r.kg, price: r.price, doc: r.doc, demo: r.demo });
const sPr = r => ({ id: r.id, fid: r.fid, fn: r.fn, crop: r.crop, kg: r.kg, price: r.price, harvest: r.harvest, loc: r.loc, d: r.dist, status: r.status, demo: r.demo });
const sO = r => ({ id: r.id, item: r.item, kg: r.kg, total: r.total, by: r.buyer_name, bi: r.buyer_id, to: r.to_id, st: r.status });

/* ---------- auth ---------- */
const sign = u => jwt.sign({ sub: u.id }, SECRET, { expiresIn: "7d" });
const authed = (req, res, next) => {
  const t = (req.headers.authorization || "").replace(/^Bearer /, "");
  try {
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(jwt.verify(t, SECRET).sub);
    if (!u) throw new Error();
    req.user = u; next();
  } catch { res.status(401).json({ error: "Please sign in again." }); }
};
const only = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed for your account type." });
const DUMMY = bcrypt.hashSync("x", 10);

const api = express.Router();
api.get("/health", (_q, r) => r.json({ ok: true, demo: DEMO_MODE }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Try again in a few minutes." } });

api.post("/auth/register", limiter, h((req, res) => {
  const { email, password, name, role } = req.body || {};
  const e = String(email || "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(e) || e.length > 120) bad("Enter a valid email.");
  if (!ROLES.includes(role)) bad("Choose a valid account type.");
  if (typeof password !== "string" || password.length < 6 || password.length > 100) bad("Business name and a 6+ character password are required.");
  const n = text(name, "your business name");
  const ph = phone(req.body.phone);
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(e)) bad("That email is already registered.", 409);
  const id = newId(role[0].toUpperCase(), "users");
  db.transaction(() => {
    db.prepare("INSERT INTO users(id,email,pw_hash,name,role,phone,demo,created) VALUES(?,?,?,?,?,?,0,?)").run(id, e, bcrypt.hashSync(password, 10), n, role, ph, Date.now());
    if (role === "biogas" || role === "compost") db.prepare("INSERT INTO producers(id,name,type,dist,cap,cats) VALUES(?,?,?,?,?,?)").run(id, n, role, 8, 150, JSON.stringify(CATS));
  })();
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  res.status(201).json({ token: sign(u), user: sUser(u) });
}));

api.post("/auth/login", limiter, h((req, res) => {
  const e = String(req.body?.email || "").trim().toLowerCase();
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(e);
  const ok = bcrypt.compareSync(String(req.body?.password || ""), u ? u.pw_hash : DUMMY);
  if (!u || !ok || u.role !== req.body?.role) bad("Wrong email or password for the selected login type.", 401);
  res.json({ token: sign(u), user: sUser(u) });
}));

api.get("/me", authed, (req, res) => res.json({ user: sUser(req.user) }));

/* ---------- state (everything the signed-in user may see) ---------- */
api.get("/state", authed, h((req, res) => {
  const me = req.user, order = "ORDER BY created DESC, rowid DESC";
  const L = me.role === "restaurant" ? db.prepare(`SELECT * FROM listings WHERE rid=? ${order}`).all(me.id)
    : me.role === "farmer" ? [] : db.prepare(`SELECT * FROM listings WHERE pid=? AND type='waste' ${order}`).all(me.id);
  res.json({
    L: L.map(sL),
    P: db.prepare("SELECT * FROM producers").all().map(sP),
    C: db.prepare(`SELECT * FROM compost WHERE kg>0 OR pid=? ${order}`).all(me.id).map(sC),
    Pr: db.prepare(`SELECT * FROM produce WHERE fid=? OR (status='Available' AND kg>0) ${order}`).all(me.id).map(sPr),
    O: db.prepare(`SELECT * FROM orders WHERE buyer_id=? OR to_id=? ${order}`).all(me.id, me.id).map(sO),
    counts: {
      restaurants: db.prepare("SELECT COUNT(DISTINCT rid) c FROM listings").get().c,
      farmers: db.prepare("SELECT COUNT(DISTINCT fid) c FROM produce").get().c,
      completed: db.prepare("SELECT COUNT(*) c FROM orders WHERE kind='Pr' AND status='Delivered'").get().c,
    },
  });
}));

/* ---------- listings (restaurants) ---------- */
api.post("/listings", authed, only("restaurant"), h((req, res) => {
  const b = req.body || {}, type = b.type;
  if (!["waste", "surplus"].includes(type)) bad("Choose a listing type.");
  if (!(type === "waste" ? CATS : SURP).includes(b.cat)) bad("Choose a valid category.");
  const kg = num(b.kg, "the quantity in kg", 1, 1000);
  const loc = text(b.loc, "the pickup location", 120);
  const when = new Date(b.when);
  if (isNaN(when) || when < new Date() || when > new Date(Date.now() + 365 * 864e5)) bad("Enter a collection time in the future.");
  const ph = phone(b.phone);
  const photo = savePhoto(b.photo);
  const id = newId(type === "waste" ? "WP-" : "SF-", "listings");
  db.prepare("INSERT INTO listings(id,rid,rn,type,cat,kg,loc,time_txt,when_iso,phone,photo,stage,pid,demo,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,NULL,0,?)")
    .run(id, req.user.id, req.user.name, type, b.cat, kg, loc, ist(when), when.toISOString(), ph, photo, Date.now());
  res.status(201).json({ id });
}));

const own = (req, id) => {
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(id);
  if (!l || l.rid !== req.user.id) bad("Listing not found.", 404);
  return l;
};
api.delete("/listings/:id", authed, only("restaurant"), h((req, res) => {
  const l = own(req, req.params.id);
  db.prepare("DELETE FROM listings WHERE id=?").run(l.id); rmPhoto(l.photo);
  res.json({ ok: true });
}));
api.post("/listings/:id/request", authed, only("restaurant"), h((req, res) => {
  const l = own(req, req.params.id);
  if (l.type !== "waste") bad("Only waste listings can be sent to producers.");
  if (l.stage !== 0) bad("A collection has already been requested.", 409);
  if (!db.prepare("SELECT 1 FROM producers WHERE id=?").get(req.body?.pid)) bad("Choose a valid producer.");
  db.prepare("UPDATE listings SET pid=?, stage=1 WHERE id=?").run(req.body.pid, l.id);
  res.json({ ok: true });
}));

/* ---------- listings (producers) ---------- */
const mine = (req, id) => {
  const l = db.prepare("SELECT * FROM listings WHERE id=? AND type='waste'").get(id);
  if (!l || l.pid !== req.user.id) bad("Request not found.", 404);
  return l;
};
api.post("/listings/:id/advance", authed, only("biogas", "compost"), h((req, res) => {
  const l = mine(req, req.params.id), max = req.user.role === "compost" ? 7 : 6, s = Number(req.body?.stage);
  if (!(l.stage >= 1 && l.stage < max) || s !== l.stage + 1) bad("That stage is not available yet.", 409);
  let recv = l.recv;
  if (s === 4) recv = num(req.body?.recv, "the received quantity", 1, l.kg);
  db.prepare("UPDATE listings SET stage=?, recv=? WHERE id=?").run(s, recv, l.id);
  res.json({ ok: true });
}));
api.post("/listings/:id/reject", authed, only("biogas", "compost"), h((req, res) => {
  const l = mine(req, req.params.id);
  if (l.stage !== 1) bad("Only new requests can be rejected.", 409);
  db.prepare("UPDATE listings SET stage=0, pid=NULL WHERE id=?").run(l.id);
  res.json({ ok: true });
}));

/* ---------- compost (compost producers) ---------- */
api.post("/compost", authed, only("compost"), h((req, res) => {
  const b = req.body || {};
  const kg = num(b.kg, "the quantity in kg", 1, 10000), price = num(b.price, "a price per kg", 1, 500);
  const doc = b.doc ? 1 : 0, id = newId("C", "compost");
  db.prepare("INSERT INTO compost(id,pid,name,kg,price,doc,demo,created) VALUES(?,?,?,?,?,?,0,?)").run(id, req.user.id, req.user.name, kg, price, doc, Date.now());
  res.status(201).json({ id });
}));
api.delete("/compost/:id", authed, only("compost"), h((req, res) => {
  if (!db.prepare("DELETE FROM compost WHERE id=? AND pid=?").run(req.params.id, req.user.id).changes) bad("Product not found.", 404);
  res.json({ ok: true });
}));

/* ---------- produce (farmers) ---------- */
api.post("/produce", authed, only("farmer"), h((req, res) => {
  const b = req.body || {};
  if (!CROPS.includes(b.crop)) bad("Choose a valid crop.");
  if (!HARV.includes(b.harvest)) bad("Choose a valid harvest date.");
  if (!(b.loc in FD)) bad("Choose a valid location.");
  const kg = num(b.kg, "the quantity in kg", 1, 10000), price = num(b.price, "a price per kg", 1, 1000), id = newId("A", "produce");
  db.prepare("INSERT INTO produce(id,fid,fn,crop,kg,price,harvest,loc,dist,status,demo,created) VALUES(?,?,?,?,?,?,?,?,?,'Available',0,?)")
    .run(id, req.user.id, req.user.name, b.crop, kg, price, b.harvest, b.loc, FD[b.loc], Date.now());
  res.status(201).json({ id });
}));
api.patch("/produce/:id", authed, only("farmer"), h((req, res) => {
  if (!["Available", "Sold out"].includes(req.body?.status)) bad("Choose a valid status.");
  if (!db.prepare("UPDATE produce SET status=? WHERE id=? AND fid=?").run(req.body.status, req.params.id, req.user.id).changes) bad("Produce not found.", 404);
  res.json({ ok: true });
}));
api.delete("/produce/:id", authed, only("farmer"), h((req, res) => {
  if (!db.prepare("DELETE FROM produce WHERE id=? AND fid=?").run(req.params.id, req.user.id).changes) bad("Produce not found.", 404);
  res.json({ ok: true });
}));

/* ---------- orders ---------- */
api.post("/orders", authed, only("restaurant", "farmer"), h((req, res) => {
  const { kind, id } = req.body || {}, q = Number(req.body?.qty), me = req.user;
  if (kind === "C" && me.role !== "farmer") bad("Only farmers can order compost.", 403);
  if (kind === "Pr" && me.role !== "restaurant") bad("Only restaurants can order produce.", 403);
  if (!["C", "Pr"].includes(kind)) bad("Choose a valid item.");
  const oid = newId("O-", "orders");
  db.transaction(() => {
    const it = db.prepare(kind === "C" ? "SELECT * FROM compost WHERE id=?" : "SELECT * FROM produce WHERE id=?").get(id);
    if (!it || (kind === "Pr" && it.status !== "Available")) bad("That item is no longer available.", 404);
    if (!(q > 0) || q > it.kg) bad("Choose a valid quantity.");
    const left = it.kg - q;
    if (kind === "C") db.prepare("UPDATE compost SET kg=? WHERE id=?").run(left, id);
    else db.prepare("UPDATE produce SET kg=?, status=? WHERE id=?").run(left, left ? it.status : "Sold out", id);
    db.prepare("INSERT INTO orders(id,kind,item,kg,total,buyer_name,buyer_id,to_id,status,created) VALUES(?,?,?,?,?,?,?,?,'Placed',?)")
      .run(oid, kind, kind === "C" ? it.name + " compost" : `${it.crop} (${it.fn})`, q, q * it.price, me.name, me.id, kind === "C" ? it.pid : it.fid, Date.now());
  })();
  res.status(201).json({ id: oid });
}));
api.patch("/orders/:id", authed, h((req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!o || o.to_id !== req.user.id) bad("Order not found.", 404);
  const next = { Placed: "Accepted", Accepted: "Delivered" }[o.status];
  if (!next || req.body?.status !== next) bad("That status change is not allowed.", 409);
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(next, o.id);
  res.json({ ok: true });
}));

/* ---------- demo reset ---------- */
api.post("/demo/reset", h((_req, res) => {
  if (!DEMO_MODE) bad("Reset is disabled.", 403);
  seedDemo(); res.json({ ok: true });
}));

app.use("/api", api);
app.use("/api", (_q, r) => r.status(404).json({ error: "Not found." }));
app.listen(PORT, () => console.log(`BIOLOOP running at http://localhost:${PORT}  (db: ${file})`));
