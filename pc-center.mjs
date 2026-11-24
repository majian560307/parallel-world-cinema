// Parallel World Cinema — central account & submission service
// Auth API is wire-compatible with the desktop App's server.mjs (/api/auth/*).
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";
import dns from "node:dns/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 3010);
const TO = "yanaranft@gmail.com";
const ADMIN_EMAIL = "yanaranft@gmail.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme";
const DB_PATH = process.env.DB_PATH || "/opt/submit/pc-center.db";
const LEGACY_JSONL = "/opt/submit/submissions.jsonl";
const RATE_MS = 10_000;
const last = new Map();

// ---- 邮箱验证与注册风控（新增）----
const PUBLIC_BASE = process.env.PC_PUBLIC_BASE || "https://app.osmaigc.com/pc-submit";
const MAIL_MODE = String(process.env.MAIL_MODE || "smtp").toLowerCase();  // smtp | outbox(只落盘, 用于验收)
const MAIL_OUTBOX = process.env.MAIL_OUTBOX || "/opt/submit/mail-outbox";
const MAIL_HOST = process.env.SMTP_HOST || "smtpdm.aliyun.com";
const MAIL_PORT = Number(process.env.SMTP_PORT || 465);
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || "noreply@osmaigc.com";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "平行世界电影院";
const VERIFY_TTL_H = Number(process.env.VERIFY_TTL_H || 24);
const SIGNUP_BONUS = Number(process.env.SIGNUP_BONUS || 5);
// REQUIRE_EMAIL_VERIFY=1：注册不发通证，点邮件确认后才发；=0：注册即发（邮件通道未就绪时的过渡态）
const REQUIRE_VERIFY = String(process.env.REQUIRE_EMAIL_VERIFY || "1") !== "0";
const RESERVED_TLDS = new Set(["invalid", "test", "local", "localhost", "example", "internal", "lan", "home", "corp", "arpa"]);
const MX_CACHE = new Map();
const signupIp = new Map();  // ip -> [ts]
const signupNet = new Map(); // /24 -> [ts]
const EMAIL_RE = /^[a-z0-9._%+\-]{1,64}@[a-z0-9][a-z0-9.\-]{0,188}\.[a-z]{2,24}$/i;

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  at TEXT, type TEXT, name TEXT, link TEXT, contact TEXT, desc TEXT, ip TEXT,
  status TEXT DEFAULT 'received',
  reply TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS game_profile (
  user_id INTEGER PRIMARY KEY,
  pass_balance INTEGER DEFAULT 0,
  pass_expires TEXT DEFAULT '',
  films_owned INTEGER DEFAULT 0,
  games_best INTEGER DEFAULT 0,
  playtime_min INTEGER DEFAULT 0,
  synced_at TEXT
);`);
db.prepare("UPDATE users SET is_admin = 1 WHERE lower(email) = ?").run(ADMIN_EMAIL);

// ---------- observability migration (additive, safe to re-run) ----------
const ensureCol = (table, col, ddl) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch { /* exists */ } };
ensureCol("sessions", "ip", "TEXT DEFAULT ''");
ensureCol("sessions", "ua", "TEXT DEFAULT ''");
ensureCol("sessions", "last_seen", "TEXT");
ensureCol("sessions", "revoked", "INTEGER DEFAULT 0");
ensureCol("users", "last_login", "TEXT");
ensureCol("users", "last_ip", "TEXT DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  kind TEXT,
  user_id INTEGER,
  email TEXT,
  ip TEXT,
  ua TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ev_kind_at ON login_events(kind, at)`);
try {
  db.exec(`UPDATE users SET last_login = (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = users.id)
           WHERE (last_login IS NULL OR last_login = '')
             AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id)`);
  db.exec(`UPDATE sessions SET last_seen = created_at WHERE last_seen IS NULL`);
  // seed the audit log from pre-existing sessions so the history is not blank on day one
  if (db.prepare("SELECT COUNT(*) c FROM login_events").get().c === 0) {
    const hist = db.prepare("SELECT s.user_id, s.created_at, u.email FROM sessions s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at").all();
    const ins = db.prepare("INSERT INTO login_events (at,kind,user_id,email,ip,ua) VALUES (?,?,?,?,?,?)");
    for (const h of hist) ins.run(h.created_at, "login", h.user_id, h.email || "", "", "history");
    if (hist.length) console.log("backfilled login_events:", hist.length);
  }
} catch (e) { console.log("backfill skip:", String(e).slice(0, 80)); }

// ── 云端主权层：账号资产（通行证 / 已购片 / 档案）──
// 口径：核心数据只在这里，客户端(桌面 App / 网页)只做缓存镜像。
ensureCol("users", "passes", "INTEGER DEFAULT 0");
ensureCol("users", "name", "TEXT DEFAULT ''");
ensureCol("users", "gender", "TEXT DEFAULT ''");
ensureCol("users", "lang", "TEXT DEFAULT 'zh'");
ensureCol("users", "attack", "INTEGER DEFAULT 0");
ensureCol("users", "defense", "INTEGER DEFAULT 0");
ensureCol("users", "spirit", "INTEGER DEFAULT 0");
ensureCol("users", "agility", "INTEGER DEFAULT 0");
ensureCol("users", "email_verified", "INTEGER DEFAULT 0");
ensureCol("users", "email_verified_at", "TEXT");
ensureCol("users", "signup_ip", "TEXT DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS email_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  kind TEXT DEFAULT 'verify',
  exp INTEGER NOT NULL,
  used_at TEXT,
  at TEXT,
  ip TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_etok_user ON email_tokens (user_id, kind);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_users_signup_ip ON users (signup_ip);
`);
// 一次性迁移：本版之前已存在的账号视为已验证（不夺走他们已有的礼包）
if (!db.prepare("SELECT 1 AS x FROM meta WHERE k = ?").get("verified_grandfather")) {
  const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
  const g = db.prepare("UPDATE users SET email_verified = 1, email_verified_at = ? WHERE COALESCE(email_verified, 0) = 0").run(bjNow());
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run("verified_grandfather", String(g.changes));
}
db.exec(`CREATE TABLE IF NOT EXISTS owned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  film_id TEXT NOT NULL,
  title TEXT DEFAULT '', plane_name TEXT DEFAULT '', director TEXT DEFAULT '',
  duration TEXT DEFAULT '', src TEXT DEFAULT '',
  first_watched TEXT, last_watched TEXT, watch_count INTEGER DEFAULT 1,
  UNIQUE(user_id, film_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS pass_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT,
  at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS pass_spends (
  key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  refunded INTEGER DEFAULT 0,
  at TEXT DEFAULT (datetime('now'))
)`);
// ---- 剧场经济与社交：与账号同等口径，核心数据只在云端 ----
db.exec(`CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL, friend_id INTEGER NOT NULL,
  at TEXT DEFAULT (datetime('now')), PRIMARY KEY (user_id, friend_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  theme TEXT DEFAULT '', title TEXT DEFAULT '', script TEXT DEFAULT '',
  fallback INTEGER DEFAULT 0, shareholder INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS show_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, show_id INTEGER NOT NULL, buyer_id INTEGER NOT NULL,
  price INTEGER NOT NULL, spend_key TEXT, at TEXT DEFAULT (datetime('now'))
)`);
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_ticket_key ON show_tickets(spend_key)"); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS show_payouts (
  show_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
  cum INTEGER DEFAULT 0, paid INTEGER DEFAULT 0, carry INTEGER DEFAULT 0, last_day TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, film_id TEXT, film_title TEXT DEFAULT '', plane_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT DEFAULT '',
  pos REAL DEFAULT 0, playing INTEGER DEFAULT 0, last_seen TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, user_id)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS whispers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  name TEXT DEFAULT '', text TEXT DEFAULT '', at INTEGER
)`);
db.exec(`CREATE TABLE IF NOT EXISTS user_saves (
  user_id INTEGER PRIMARY KEY, data TEXT DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now'))
)`);
db.exec(`CREATE TABLE IF NOT EXISTS films (
  id TEXT PRIMARY KEY,
  title TEXT DEFAULT '',
  price INTEGER DEFAULT 3,
  updated_at TEXT
)`);
// 价目以服务器为唯一真源：App/网页推 manifest 上来，扣费只认 films 表
const MANIFEST_PATH = process.env.MANIFEST_PATH || "/opt/submit/manifest.json";
function syncPricesFromManifest() {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return 0;
    const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const up = db.prepare("INSERT INTO films (id,title,price,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(id) DO UPDATE SET title=excluded.title, price=excluded.price, updated_at=datetime('now')");
    let n = 0;
    for (const s of (m.schedules || [])) {
      if (!s.id) continue;
      up.run(String(s.id), String(s.title || ""), Number.isFinite(Number(s.price)) ? Math.max(0, Math.round(Number(s.price))) : 3);
      n++;
    }
    return n;
  } catch (e) { console.log("price sync skip:", String(e).slice(0, 80)); return 0; }
}
const syncedPrices = syncPricesFromManifest();
if (syncedPrices) console.log("films priced from manifest:", syncedPrices);
const filmRow = (id) => db.prepare("SELECT * FROM films WHERE id = ?").get(String(id));
const ownedList = (uid) => db.prepare("SELECT * FROM owned WHERE user_id = ? ORDER BY last_watched DESC").all(uid)
  .map((r) => ({ id: r.film_id, title: r.title, planeName: r.plane_name, director: r.director, duration: r.duration, src: r.src, firstWatched: r.first_watched, lastWatched: r.last_watched, watchCount: r.watch_count }));
const nowStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
const currentPasses = (uid) => (db.prepare("SELECT passes FROM users WHERE id = ?").get(uid) || {}).passes || 0;
// 股东票房日结（服务端唯一）：票价1通证/张；每日应付 = floor((未结票房+滚存)/2)，余数滚存次日
const localDayStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
function settleShowPayouts(day = localDayStr()) {
  const rows = db.prepare(`SELECT p.show_id, p.user_id, p.cum, p.paid, p.carry, s.title
    FROM show_payouts p JOIN shows s ON s.id = p.show_id
    WHERE p.last_day IS NULL OR p.last_day < ?`).all(day);
  for (const r of rows) {
    const sold = db.prepare("SELECT COALESCE(SUM(price),0) AS gross FROM show_tickets WHERE show_id = ?").get(r.show_id) || { gross: 0 };
    if (r.last_day === null) { // 开账日只立基线，跨日后首次支付
      db.prepare("UPDATE show_payouts SET cum = ?, last_day = ? WHERE show_id = ?").run(sold.gross, day, r.show_id);
      continue;
    }
    const pool = (sold.gross - r.cum) + r.carry;
    const pay = Math.max(0, Math.floor(pool / 2));
    const carry = pool - pay * 2;
    db.prepare("UPDATE show_payouts SET cum = ?, paid = paid + ?, carry = ?, last_day = ? WHERE show_id = ?")
      .run(sold.gross, pay, carry, day, r.show_id);
    if (pay > 0) {
      db.prepare("UPDATE users SET passes = COALESCE(passes,0) + ? WHERE id = ?").run(pay, r.user_id);
      db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)")
        .run(r.user_id, pay, `小靡专场票房分成 ·《${r.title}》(${r.last_day || "开账"}→${day})`, nowStr());
    }
  }
  return rows.length;
}
const friendList = (uid) => db.prepare(`SELECT u.id, u.email, u.name, f.at AS friend_since
  FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY f.at DESC`).all(uid);
const roomMembers = (rid) => db.prepare(`SELECT m.user_id AS id, m.name, m.pos AS time, m.playing, m.last_seen
  FROM room_members m WHERE m.room_id = ? ORDER BY m.last_seen DESC`).all(rid).map((m) => ({ ...m, playing: !!m.playing }));
const stageList = () => db.prepare(`SELECT s.id, s.theme, s.title, s.script, s.fallback, s.created_at, s.pinned,
    s.user_id AS owner_id, COALESCE(u.name, '') AS owner_name,
    (SELECT COUNT(*) FROM show_tickets t WHERE t.show_id = s.id) AS tickets_sold,
    (SELECT COALESCE(SUM(t.price),0) FROM show_tickets t WHERE t.show_id = s.id) AS gross,
    COALESCE(p.paid,0) AS paid_out, COALESCE(p.carry,0) AS carry
  FROM shows s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN show_payouts p ON p.show_id = s.id
  WHERE s.shareholder = 1 ORDER BY s.pinned DESC, s.id DESC LIMIT 50`).all();
const PASS_PACKS = { small: { n: 5, label: "通行包·小" }, mid: { n: 12, label: "通行包·中" }, large: { n: 30, label: "通行包·大" } };

// one-time migration of legacy JSONL archive
try {
  const n = db.prepare("SELECT COUNT(*) c FROM submissions").get().c;
  if (!n && fs.existsSync(LEGACY_JSONL)) {
    for (const line of fs.readFileSync(LEGACY_JSONL, "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        db.prepare("INSERT INTO submissions (at,type,name,link,contact,desc,ip) VALUES (?,?,?,?,?,?,?)")
          .run(r.at || r.ts || "", r.type || "film", r.name || "", r.link || "", r.contact || "", r.desc || "", r.ip || "");
      } catch { /* skip bad line */ }
    }
    console.log("legacy submissions migrated");
  }
} catch (e) { console.log("migration skip:", String(e).slice(0, 80)); }

const hashPass = (pw) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
};
const verifyPass = (pw, stored) => {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
};

const transporter = nodemailer.createTransport({
  host: MAIL_HOST, port: MAIL_PORT, secure: MAIL_PORT === 465, connectionTimeout: 15000, greetingTimeout: 15000,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
// 统一发信口：MAIL_MODE=outbox 时只写文件（验收用，不依赖真实邮箱）
async function sendMail({ to, subject, html, text }) {
  const msg = { from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`, to, subject, html, text };
  if (MAIL_MODE === "outbox") {
    fs.mkdirSync(MAIL_OUTBOX, { recursive: true });
    const f = path.join(MAIL_OUTBOX, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...msg, at: nowStr() }, null, 2));
    return { outbox: f };
  }
  return transporter.sendMail(msg);
}
const TYPE_CN = { film: "放映 · FILM", game: "街区 · GAME" };
const ST = { received: ["已收到", "#d4af6a"], reviewing: ["审核中", "#9ef0e7"], scheduled: ["已排片", "#8ee28e"], rejected: ["退回", "#ff9d8a"] };

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const pubUser = (u) => ({ id: u.id, email: u.email, name: u.name || "", isAdmin: !!u.is_admin, created_at: u.created_at, lang: u.lang || "zh", passes: u.passes || 0, emailVerified: !!u.email_verified });

function userByReq(headers) {
  const token = String(headers.authorization || "").replace("Bearer ", "")
    || ((headers.cookie || "").match(/pwc_token=([a-f0-9]+)/) || [])[1] || "";
  if (!token) return null;
  const row = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND COALESCE(s.revoked,0) = 0").get(token);
  if (!row) return null;
  // heartbeat: keeps "online now" meaningful without spamming the row
  try {
    const cur = db.prepare("SELECT last_seen FROM sessions WHERE token = ?").get(token);
    if (!cur || !cur.last_seen || Date.now() - new Date(cur.last_seen.replace(" ", "T") + "Z").getTime() > 60_000)
      db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?").run(token);
  } catch { /* heartbeat is best-effort */ }
  return row;
}

// ---------- observability helpers ----------
let CUR_IP = "";
const clientIp = (h) => (String(h["x-forwarded-for"] || h["x-real-ip"] || "").split(",")[0].trim() || CUR_IP || "unknown");
const clientUa = (h) => clip(h["user-agent"] || "", 180);
function logEvent(kind, userId, email, headers) {
  try {
    db.prepare("INSERT INTO login_events (kind,user_id,email,ip,ua) VALUES (?,?,?,?,?)")
      .run(kind, userId || null, String(email || "").toLowerCase().slice(0, 120), clientIp(headers || {}), clientUa(headers || {}));
  } catch (e) { console.log("event log skip:", String(e).slice(0, 60)); }
}
const bj = (s) => {
  if (!s) return "—";
  const d = new Date(String(s).replace(" ", "T") + "Z");
  return isNaN(d) ? String(s) : new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
};
const shortUa = (ua) => {
  const s = String(ua || "");
  if (s === "history") return "历史会话";
  const os = /Windows/.test(s) ? "Windows" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iOS" : /Linux/.test(s) ? "Linux" : "?";
  if (/ParallelCinema/.test(s)) return os + " · 桌面客户端";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /Firefox\//.test(s) ? "Firefox" : /curl/.test(s) ? "curl" : "?";
  return os + " · " + br;
};

// ---------- 邮箱验证 / 反刷号 工具 ----------
function loadDisposable() {
  const cands = [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "disposable-domains.txt"),
    "/opt/submit/disposable-domains.txt",
  ];
  for (const f of cands) {
    try {
      const txt = fs.readFileSync(f, "utf8");
      const set = new Set(txt.split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter((x) => x && !x.startsWith("#")));
      console.log(`[mail] disposable domains loaded: ${set.size} from ${f}`);
      return set;
    } catch {}
  }
  console.log("[mail] disposable domain list missing (ok, skipped)");
  return new Set();
}
const DISPOSABLE = loadDisposable();

async function emailDeliverable(email) {
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "邮箱格式不对" };
  const dom = email.split("@")[1];
  if (/^\d+(\.\d+)*$/.test(dom)) return { ok: false, reason: "邮箱格式不对" };
  const tld = dom.split(".").pop();
  if (RESERVED_TLDS.has(tld)) return { ok: false, reason: "这个邮箱域名收不到信" };
  if (DISPOSABLE.has(dom) || DISPOSABLE.has(dom.replace(/^www\./, ""))) return { ok: false, reason: "请用常用邮箱，不支持一次性邮箱" };
  const hit = MX_CACHE.get(dom);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.res;
  let res;
  try {
    const mx = await dns.resolveMx(dom);
    res = mx && mx.length ? { ok: true } : { ok: false, reason: "这个邮箱域名收不到信" };
  } catch (e) {
    const soft = !["ENOTFOUND", "ENODATA", "ENODOMAIN"].includes(String(e && e.code));
    res = soft ? { ok: true, soft: true } : { ok: false, reason: "这个邮箱域名不存在" };
  }
  MX_CACHE.set(dom, { at: Date.now(), res });
  return res;
}

// 注册限流：同一 IP 每小时 5 个、每天 12 个；同一 /24 网段每小时 20 个
function signupGate(ip) {
  const now = Date.now();
  const keep = (arr, ms) => arr.filter((t) => now - t < ms);
  const net = String(ip || "").split(".").slice(0, 3).join(".") + ".";
  const h = keep(signupIp.get(ip) || [], 3600e3);
  const d = keep(signupIp.get(ip) || [], 86400e3);
  const n = keep(signupNet.get(net) || [], 3600e3);
  if (h.length >= 5) return { code: "too_many_signups", hint: "同一网络注册太频繁，请 1 小时后再试" };
  if (d.length >= 12) return { code: "too_many_signups", hint: "同一网络今天注册太多，请明天再试" };
  if (n.length >= 20) return { code: "too_many_signups", hint: "这个网络注册太频繁，请 1 小时后再试" };
  return null;
}
function noteSignup(ip) {
  const now = Date.now();
  const net = String(ip || "").split(".").slice(0, 3).join(".") + ".";
  signupIp.set(ip, [...(signupIp.get(ip) || []), now].filter((t) => now - t < 86400e3));
  signupNet.set(net, [...(signupNet.get(net) || []), now].filter((t) => now - t < 3600e3));
}

function newVerifyToken(uid, email, ip, kind = "verify") {
  const token = crypto.randomBytes(24).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + VERIFY_TTL_H * 3600;
  db.prepare("INSERT INTO email_tokens (token, user_id, email, kind, exp, at, ip) VALUES (?,?,?,?,?,?,?)")
    .run(token, uid, email, kind, exp, nowStr(), ip || "");
  return token;
}

function verifyLink(token) {
  return `${PUBLIC_BASE}/api/auth/verify?t=${token}`;
}

function verifyMailHtml(email, link) {
  return `<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#0b0d10;padding:28px;color:#e8c987">
<div style="max-width:520px;margin:0 auto;background:#12151a;border:1px solid #2a2f36;border-radius:12px;padding:26px">
<div style="font-size:12px;letter-spacing:3px;color:#8a7a55">PARALLEL WORLD CINEMA</div>
<h2 style="color:#e8c987;font-weight:600;margin:10px 0 8px">确认你的邮箱</h2>
<p style="color:#cfc6ae;line-height:1.7;font-size:14px">${email} 正在注册「平行世界电影院」。点下面的按钮完成确认，即可领取 ${SIGNUP_BONUS} 张通证。</p>
<p style="margin:22px 0"><a href="${link}" style="display:inline-block;background:#d4af6a;color:#0b0d10;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600">确认邮箱并领取通证</a></p>
<p style="color:#7d7460;font-size:12px;line-height:1.6">链接 ${VERIFY_TTL_H} 小时内有效，只能点一次。如果不是你本人操作，忽略这封邮件即可，账号不会生效任何资产。<br>如按钮无法点击，复制到浏览器打开：<br><span style="color:#9ef0e7;word-break:break-all">${link}</span></p>
</div></div>`;
}

async function issueVerifyMail(uid, email, ip) {
  const token = newVerifyToken(uid, email, ip);
  const link = verifyLink(token);
  let state = { sent: false };
  try {
    await sendMail({
      to: email,
      subject: `确认邮箱 · 领取 ${SIGNUP_BONUS} 张通证｜平行世界电影院`,
      html: verifyMailHtml(email, link),
      text: `确认你的邮箱：${link}\n链接 ${VERIFY_TTL_H} 小时内有效。`,
    });
    state = { sent: true };
  } catch (e) {
    state = { sent: false, error: String((e && e.message) || e).slice(0, 120) };
    console.log(`[mail] verify send failed for ${email}: ${state.error}`);
  }
  if (MAIL_MODE === "outbox") state.link = link; // 仅验收环境回传链接
  return state;
}

function grantVerifyBonus(uid) {
  const done = db.prepare("SELECT 1 AS x FROM pass_ledger WHERE user_id = ? AND reason = ?").get(uid, "邮箱验证赠送");
  if (done) return { granted: 0 };
  db.prepare("UPDATE users SET passes = COALESCE(passes, 0) + ? WHERE id = ?").run(SIGNUP_BONUS, uid);
  db.prepare("INSERT INTO pass_ledger (user_id, delta, reason, at) VALUES (?,?,?,?)").run(uid, SIGNUP_BONUS, "邮箱验证赠送", nowStr());
  return { granted: SIGNUP_BONUS };
}

const verifyPage = (title, body, ok) => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 平行世界电影院</title></head>
<body style="margin:0;background:#0b0d10;color:#e8c987;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:460px;padding:34px;border:1px solid #2a2f36;border-radius:14px;background:#12151a;text-align:center">
<div style="font-size:12px;letter-spacing:3px;color:#8a7a55">PARALLEL WORLD CINEMA</div>
<h1 style="font-size:22px;margin:14px 0 10px;color:${ok ? "#8ee28e" : "#ff9d8a"}">${title}</h1>
<p style="color:#cfc6ae;font-size:14px;line-height:1.8;margin:0 0 22px">${body}</p>
<a href="${PUBLIC_BASE}/" style="display:inline-block;background:#d4af6a;color:#0b0d10;text-decoration:none;padding:11px 24px;border-radius:8px;font-weight:600">回到电影院</a>
</div></body></html>`;

function obsData() {
  const users = db.prepare(`
    SELECT u.id, u.email, u.is_admin, u.created_at, u.last_login, u.last_ip,
      COALESCE(u.email_verified, 0) AS verified, u.signup_ip,
      (SELECT COUNT(*) FROM users x WHERE x.signup_ip = u.signup_ip AND COALESCE(u.signup_ip,'') <> '') AS ip_accounts,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND COALESCE(s.revoked,0) = 0) AS live,
      (SELECT COUNT(*) FROM login_events e WHERE e.user_id = u.id AND e.kind = 'login') AS logins,
      (SELECT COUNT(*) FROM submissions b WHERE b.user_id = u.id) AS subs,
      (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS seen
    FROM users u ORDER BY COALESCE(u.last_login, u.created_at) DESC`).all();
  const events = db.prepare("SELECT * FROM login_events ORDER BY id DESC LIMIT 80").all();
  const one = (q) => { try { return db.prepare(q).get().c; } catch { return 0; } };
  const stats = {
    users: users.length,
    loginsToday: one("SELECT COUNT(*) c FROM login_events WHERE kind = 'login' AND at >= datetime('now','start of day')"),
    active7: one("SELECT COUNT(DISTINCT user_id) c FROM login_events WHERE kind = 'login' AND at >= datetime('now','-7 days')"),
    verified: one("SELECT COUNT(*) c FROM users WHERE COALESCE(email_verified,0) = 1"),
    unverified: one("SELECT COUNT(*) c FROM users WHERE COALESCE(email_verified,0) = 0"),
    dupIp: one("SELECT COUNT(*) c FROM (SELECT signup_ip FROM users WHERE COALESCE(signup_ip,'') <> '' GROUP BY signup_ip HAVING COUNT(*) > 1)"),
    online: one("SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE COALESCE(revoked,0) = 0 AND last_seen >= datetime('now','-30 minutes')"),
    fails: one("SELECT COUNT(*) c FROM login_events WHERE kind = 'fail' AND at >= datetime('now','-1 day')"),
    subs: one("SELECT COUNT(*) c FROM submissions"),
  };
  return { users, events, stats };
}

const cookieFor = (token) => `pwc_token=${token}; Path=/; Domain=.osmaigc.com; Max-Age=2592000; SameSite=None; Secure; HttpOnly`;
// 管理 cookie 只放签名，不放口令本身（口令进 URL/Referer/日志 = 泄露权限面）
const adminSig = () => crypto.createHmac("sha256", "pwc-admin-v1|" + ADMIN_PASS).update("pcadmin").digest("hex").slice(0, 40);
// cookie 属性可测试放宽（生产默认 Domain=.osmaigc.com + Secure；COOKIE_DOMAIN=none / COOKIE_INSECURE=1 仅在本地验收脚本里用）
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN === "none") ? "" : `; Domain=${process.env.COOKIE_DOMAIN || ".osmaigc.com"}`;
const COOKIE_SECURE = process.env.COOKIE_INSECURE === "1" ? "" : "; Secure";
const ADMIN_COOKIE = () => `pcadmin=${adminSig()}; Path=/${COOKIE_DOMAIN}; Max-Age=43200; SameSite=Lax${COOKIE_SECURE}; HttpOnly`;
// 退出登录要把 cookie 真正清掉（HttpOnly，前端 JS 删不了），两个 cookie 一起过期
const clearCookies = () => [
  `pwc_token=; Path=/${COOKIE_DOMAIN}; Max-Age=0; SameSite=None${COOKIE_SECURE}; HttpOnly`,
  `pcadmin=; Path=/${COOKIE_DOMAIN}; Max-Age=0; SameSite=Lax${COOKIE_SECURE}; HttpOnly`,
];
const safeEq = (a, b) => {
  a = Buffer.from(String(a || "")); b = Buffer.from(String(b || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
};
const adminCookieOk = (headers) => safeEq(((headers.cookie || "").match(/pcadmin=([^;]+)/) || [])[1], adminSig());
// 统一后台（2026-11-25 合并）：账号管理员 或 运营台口令 cookie 任一即可；/admin 退化为口令入口，界面全在门户 /account
const adminGate = (user, headers) => !!((user && user.is_admin) || adminCookieOk(headers));

// CORS 白名单：旧版把请求 Origin 原样回显 + allow-credentials，等于任何网站都能带用户 cookie 读我们的 API
const ORIGIN_OK = new Set([
  "https://global.osmaigc.com", "https://app.osmaigc.com", "https://www.osmaigc.com", "https://osmaigc.com",
  "https://majian560307.github.io", "http://127.0.0.1:7420", "http://localhost:7420",
]);
function corsHeaders(origin) {
  if (!origin) return { "access-control-allow-origin": "*" };
  if (ORIGIN_OK.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === "null") {
    return { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "origin" };
  }
  return { vary: "origin" }; // 不在白名单：不回 ACAO，浏览器侧读不到
}

// 撞库/刷口令限流：10 分钟窗口内同一 IP+账号键失败 8 次即 429
const fails = new Map();
function tooManyFails(key, max = 8, winMs = 600_000) {
  const rec = fails.get(key);
  if (!rec || Date.now() - rec.at > winMs) return false;
  return rec.n >= max;
}
function noteFail(key) {
  const rec = fails.get(key);
  if (!rec || Date.now() - rec.at > 600_000) fails.set(key, { n: 1, at: Date.now() });
  else { rec.n++; rec.at = Date.now(); }
}
function clearFails(key) { fails.delete(key); }
// ---------- admin page ----------
function adminPage(rows, obs) {
  obs = obs || { users: [], events: [], stats: {} };
  const s = obs.stats || {};
  const stat = (n, lab, cls) => `<div class="st"><b class="${cls || ''}">${n ?? 0}</b><span>${lab}</span></div>`;
  const obsHtml = `<h2>台前观测 · AUDIENCE</h2>
<div class="stats">${stat(s.users, "注册用户")}${stat(s.online, "此刻在线")}${stat(s.loginsToday, "今日登录")}${stat(s.active7, "7日活跃")}${stat(s.fails, "24h 失败登录", s.fails > 0 ? "warn" : "")}${stat(s.subs, "投稿总数")}</div>
<table><thead><tr><th>#</th><th>账号</th><th>邮箱</th><th>注册</th><th>最后登录</th><th>登录次数</th><th>最后 IP</th><th>投稿</th><th>在线</th></tr></thead><tbody>
${obs.users.map((u) => `<tr${u.is_admin ? ' class="adm"' : ''}><td>${u.id}</td><td>${esc(u.email)}${u.is_admin ? ' <span class="tag">管理</span>' : ''}</td><td>${u.verified ? '<span class="tag ok">已验证</span>' : '<span class="tag warn">未验证</span>'}</td><td>${bj(u.created_at)}</td><td>${bj(u.last_login)}</td><td>${u.logins || 0}</td><td>${esc(u.last_ip || "—")}${u.ip_accounts > 1 ? ` <span class="tag warn" title="同一注册 IP 下有 ${u.ip_accounts} 个账号">同IP×${u.ip_accounts}</span>` : ""}</td><td>${u.subs || 0}</td><td>${u.live && u.seen && (Date.now() - new Date(String(u.seen).replace(" ", "T") + "Z").getTime() < 1800e3) ? '<span class="dot on"></span>在馆' : '<span class="dot"></span>—'}</td></tr>`).join("")}
${obs.users.length ? "" : '<tr><td colspan="9" class="empty">还没有注册用户</td></tr>'}
</tbody></table>
<h2>登录流水 · LAST 80 EVENTS</h2>
<table><thead><tr><th>时间</th><th>事件</th><th>账号</th><th>IP</th><th>设备</th></tr></thead><tbody>
${obs.events.map((e) => `<tr><td>${bj(e.at)}</td><td><span class="ev ev-${esc(e.kind)}">${({ login: "登录", register: "注册", logout: "退出", fail: "失败", buy: "买断", spend: "消费", refund: "退款", admin: "管理登录" }[e.kind]) || esc(e.kind)}</span></td><td>${esc(e.email || (e.user_id ? "用户#" + e.user_id : "—"))}</td><td>${esc(e.ip || "—")}</td><td>${esc(shortUa(e.ua))}</td></tr>`).join("")}
${obs.events.length ? "" : '<tr><td colspan="5" class="empty">暂无登录流水（面板上线后开始记录）</td></tr>'}
</tbody></table>`;
  const cards = rows.map((r) => {
    const [st, color] = ST[r.status] || ST.received;
    return `<div class="card">
<div class="meta">#${r.id} · ${esc(r.at)} · ${TYPE_CN[r.type] || esc(r.type)} · ${r.user_id ? "用户#" + r.user_id : "匿名投稿"}</div>
<div class="name">${esc(r.name)} <a class="ext" href="${esc(r.link)}" target="_blank">作品↗</a></div>
<div class="desc">${esc(r.desc || "").replace(/\n/g, "<br>")}</div>
<div class="links">联系：${esc(r.contact || "—")}</div>
<form method="post" action="/pc-submit/admin/set?id=${r.id}" class="ops">
  <select name="status">${Object.entries(ST).map(([k, [v]]) => `<option value="${k}" ${k === r.status ? "selected" : ""}>${v}</option>`).join("")}</select>
  <input name="reply" placeholder="给投稿人的回复（用户可见）" value="${esc(r.reply)}" style="flex:1;min-width:180px">
  <button>保存</button>
</form></div>`;
  }).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>投稿后台 · 平行世界电影院</title><style>
body{background:#0d0b08;color:#f4f0e6;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:1040px;margin:0 auto;padding:28px 18px}
h1{font-size:20px;letter-spacing:.1em;border-bottom:1px solid rgba(212,175,106,.35);padding-bottom:14px}
h1 small{float:right;font-size:12px;color:#8b8272;font-weight:400;margin-top:6px}
.card{border:1px solid rgba(212,175,106,.22);border-radius:12px;padding:16px 18px;margin:14px 0;background:rgba(255,255,255,.03)}
.meta{font-size:12px;color:#8b8272;letter-spacing:.06em}
.name{font-size:17px;color:#e8c987;margin:4px 0}.name .ext{font-size:12px;text-decoration:none}
.desc{color:#cfc6ae}.links{font-size:13px;color:#8b8272;margin-top:6px}
a{color:#d4af6a}
.ops{margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
select,input{background:rgba(255,255,255,.05);border:1px solid rgba(212,175,106,.4);border-radius:8px;padding:8px 12px;color:#f4f0e6;font:inherit;font-size:13px}
button{background:#d4af6a;color:#0d0b08;border:0;border-radius:99px;padding:8px 20px;font-size:13px;cursor:pointer}
.empty{color:#8b8272;text-align:center;padding:40px 0}
h2{font-size:13px;letter-spacing:.2em;color:#8b8272;font-weight:500;margin:30px 0 10px;border-bottom:1px solid rgba(212,175,106,.14);padding-bottom:8px}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
@media(max-width:760px){.stats{grid-template-columns:repeat(3,1fr)}}
.st{border:1px solid rgba(212,175,106,.18);border-radius:10px;padding:10px 6px;text-align:center;background:rgba(255,255,255,.02)}
.st b{display:block;font-size:20px;color:#e8c987;line-height:1.25}
.st b.warn{color:#ff9d8a}
.st span{font-size:11px;color:#8b8272;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:4px}
th{text-align:left;font-weight:500;color:#8b8272;letter-spacing:.06em;font-size:11px;border-bottom:1px solid rgba(212,175,106,.2);padding:7px 6px}
td{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.05);color:#cfc6ae;white-space:nowrap}
tr.adm td{color:#e8c987}
.tag{font-size:10px;border:1px solid rgba(212,175,106,.5);border-radius:99px;padding:1px 7px;color:#d4af6a}
.tag.ok{color:#8ee28e;border-color:rgba(142,226,142,.55)}
.tag.warn{color:#ff9d8a;border-color:rgba(255,157,138,.55)}
.dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:#3a342c;margin-right:5px;vertical-align:0}
.dot.on{background:#8ee28e;box-shadow:0 0 8px #8ee28e}
.ev{font-size:11px;border-radius:99px;padding:1.5px 8px;letter-spacing:.04em}
.ev-login{background:rgba(142,226,142,.14);color:#8ee28e}
.ev-register{background:rgba(212,175,106,.16);color:#d4af6a}
.ev-logout{background:rgba(255,255,255,.06);color:#8b8272}
.ev-fail{background:rgba(255,157,138,.14);color:#ff9d8a}
</style><h1>平行世界 · 运营台 <small>${rows.length} 份投稿 · <a href="/pc-submit/account" style="font-size:12px">用户门户→</a></small></h1>${obsHtml}<h2>投稿 · SUBMISSIONS</h2>${cards || '<p class="empty">暂无投稿</p>'}`;
}

// ---------- portal (login / register / my page) ----------
const PORTAL = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的平行世界 · 账号门户</title><style>
:root{--ink:#0a0806;--ink2:#14100b;--ivory:#ece7dc;--amber:#d4af6a;--amber-hi:#f3dca0;--dim:#8b8272;--line:rgba(212,175,106,.22);--serif:"Noto Serif SC","Songti SC","SimSun",serif;--sans:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}html{background:var(--ink)}
body{margin:0;min-height:100vh;color:var(--ivory);font:15px/1.7 var(--sans);background:radial-gradient(120% 90% at 50% 0%,rgba(26,20,12,.35) 0%,rgba(10,8,6,.85) 60%),radial-gradient(60% 50% at 85% 100%,rgba(212,175,106,.1),transparent 60%),url("https://global.osmaigc.com/assets/jm_corridor.jpg") center/cover fixed,#0a0806}
.langs{position:fixed;top:14px;right:16px;z-index:9;display:inline-flex;gap:6px;align-items:center}
.lang-btn{font-size:.82rem;letter-spacing:.06em;cursor:pointer;padding:5px 11px;border-radius:999px;color:var(--dim);opacity:.6;white-space:nowrap;background:transparent;border:1px solid transparent;transition:.25s}
.lang-btn:hover{opacity:1;color:var(--amber)}
.lang-btn.on{opacity:1;color:var(--amber-hi);border-color:rgba(232,196,118,.5);background:rgba(232,196,118,.08)}
.wrap{max-width:560px;margin:0 auto;padding:clamp(40px,9vh,90px) 22px 60px}
.brand{display:flex;align-items:baseline;gap:12px;justify-content:center;margin-bottom:6px}
.brand h1{font:600 26px/1.3 var(--serif);letter-spacing:.22em;color:var(--ivory);margin:0;text-shadow:0 0 34px rgba(212,175,106,.35)}
.brand .en{font:400 10px/1 var(--sans);letter-spacing:.34em;color:var(--dim);text-transform:uppercase}
.tag{color:var(--dim);font-size:12.5px;letter-spacing:.18em;text-align:center;margin:0 0 34px}
.tag b{color:var(--amber);font-weight:500}
.panel{background:linear-gradient(170deg,rgba(236,231,220,.055),rgba(236,231,220,.02));border:1px solid var(--line);border-radius:18px;padding:26px 26px 24px;box-shadow:0 24px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(243,220,160,.12)}
.tabs{display:flex;gap:26px;border-bottom:1px solid rgba(212,175,106,.16);margin:0 0 22px;padding:0 2px;position:relative;z-index:5}
[hidden]{display:none !important}
.tabs button{position:relative;background:none;border:0;color:var(--dim);font:15px/1 var(--sans);letter-spacing:.14em;padding:8px 2px 12px;cursor:pointer;transition:color .2s}
.tabs button.on{color:var(--amber-hi)}
.tabs button::after{content:"";position:absolute;left:8%;right:8%;bottom:-1px;height:2px;background:linear-gradient(90deg,transparent,var(--amber),transparent);opacity:0;transition:opacity .25s}
.tabs button.on::after{opacity:1}
input:focus{outline:none;border-color:rgba(212,175,106,.65);box-shadow:0 0 0 3px rgba(212,175,106,.12)}
input,select{width:100%;padding:12px 15px;background:rgba(10,8,6,.55);border:1px solid rgba(212,175,106,.3);border-radius:11px;color:var(--ivory);font:inherit;font-size:14.5px;transition:border-color .2s,box-shadow .2s}
::placeholder{color:#6d6455}
.go{margin-top:20px;width:100%;padding:13px;background:linear-gradient(180deg,var(--amber-hi),var(--amber) 55%,#b08a44);color:#241806;border:0;border-radius:11px;font:600 14.5px/1 var(--sans);letter-spacing:.28em;text-indent:.28em;cursor:pointer;box-shadow:0 6px 22px rgba(212,175,106,.28);transition:transform .15s,filter .15s}
.go:hover{filter:brightness(1.08)}.go:active{transform:translateY(1px)}
.go[disabled]{opacity:.55;pointer-events:none}
.ghost{background:none;border:0;color:var(--dim);letter-spacing:.1em;font-size:13px;cursor:pointer;text-align:center;width:100%;margin-top:14px}
.ghost:hover{color:var(--amber)}
.msg{min-height:20px;font-size:13px;color:#ff9d8a;margin-top:12px;text-align:center}
.hdr{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:18px}
.hdr .em{color:var(--dim);font-size:12.5px;letter-spacing:.05em}
.card{border:1px solid rgba(212,175,106,.18);border-radius:14px;padding:15px 17px;margin:12px 0 0;background:linear-gradient(170deg,rgba(236,231,220,.045),rgba(236,231,220,.015));animation:rise .35s ease both}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1}}
.badge{border-radius:99px;font-size:10.5px;letter-spacing:.12em;padding:2.5px 10px;color:#0d0b08;font-weight:600;display:inline-block;vertical-align:1px}
.meta{font-size:12px;color:var(--dim);letter-spacing:.04em}
.reply{margin-top:9px;border-left:2px solid var(--amber);padding-left:11px;color:#cfc6ae;font-size:14px}
.ops{margin-top:12px;display:flex;gap:9px;flex-wrap:wrap;align-items:center}
.ops input{flex:1;min-width:150px;padding:8px 12px;font-size:13px;margin:0}
.ops select{width:auto;padding:8px 10px;font-size:13px}
.ops button{background:var(--amber);color:#241806;border:0;border-radius:9px;padding:8px 18px;font-size:13px;letter-spacing:.08em;cursor:pointer}
a{color:var(--amber);text-decoration-color:rgba(212,175,106,.4)}
.empty{color:var(--dim);text-align:center;padding:44px 0 26px;letter-spacing:.08em;font-size:14px}
.skel{opacity:.45;transition:opacity .3s}
.resident{padding:16px 22px;margin-bottom:22px}
.r-cap{font:400 10px/1 var(--sans);letter-spacing:.3em;color:var(--dim);text-transform:uppercase;margin-bottom:12px}
.r-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 10px}
@media (max-width:480px){.r-grid{grid-template-columns:repeat(2,1fr)}}
.r-cell{text-align:center}
.r-num{font:600 22px/1.2 var(--serif);color:var(--amber-hi);text-shadow:0 0 22px rgba(212,175,106,.3)}
.r-lab{display:block;font-size:11px;letter-spacing:.14em;color:var(--dim);margin-top:3px}
.r-wait{color:var(--dim);text-align:center;font-size:13px;letter-spacing:.08em;grid-column:1/-1}
.r-foot{font-size:11px;color:var(--dim);letter-spacing:.06em;text-align:center;margin-top:12px;grid-column:1/-1}
.ostat{display:grid;grid-template-columns:repeat(3,1fr);gap:12px 8px;padding:6px 0 10px}
@media (max-width:480px){.ostat{grid-template-columns:repeat(2,1fr)}}
.ostat>div{text-align:center;border:1px solid rgba(212,175,106,.16);border-radius:12px;padding:12px 6px;background:rgba(236,231,220,.03)}
.ostat b{display:block;font:600 20px/1.25 var(--serif);color:var(--amber-hi)}
.ostat span{font-size:11px;letter-spacing:.1em;color:var(--dim)}
.otbl{overflow-x:auto;border:1px solid rgba(212,175,106,.16);border-radius:12px}
.otbl table{width:100%;border-collapse:collapse;font-size:12.5px;white-space:nowrap}
.otbl th{text-align:left;font-weight:500;color:var(--amber);letter-spacing:.08em;font-size:11px;padding:9px 10px;border-bottom:1px solid rgba(212,175,106,.2);background:rgba(236,231,220,.04)}
.otbl td{padding:8px 10px;border-bottom:1px solid rgba(236,231,220,.06);color:#ddd6c6}
.otbl tr:last-child td{border-bottom:0}
.tg{font-style:normal;font-size:10px;letter-spacing:.08em;padding:1.5px 7px;border-radius:99px;border:1px solid rgba(212,175,106,.45);color:var(--amber-hi)}
.tg.ok{color:#8ee28e;border-color:rgba(142,226,142,.45)}
.tg.wn{color:#ffb27a;border-color:rgba(255,157,138,.45)}
</style></head><body>
<div class="langs" id="langs"><button class="lang-btn" data-l="zh">中文</button><button class="lang-btn" data-l="en">EN</button><button class="lang-btn" data-l="ja">日本語</button><button class="lang-btn" data-l="ko">한국어</button></div>
<div class="wrap">
<div class="brand"><h1 id="brandH">我的平行世界</h1><span class="en">Parallel World Cinema</span></div>
<p class="tag" id="tagline"></p>
<div class="panel" id="auth">
<div class="tabs"><button id="t-in" class="on">登录</button><button id="t-up">注册</button></div>
<input id="email" type="email" autocomplete="email" placeholder="邮箱"><input id="pw" type="password" autocomplete="current-password" placeholder="密码（至少 6 位）" style="margin-top:12px">
<button class="go" id="goBtn">登录</button><div class="msg" id="msg"></div>
</div>
<div id="mine" hidden>
<div class="hdr"><span class="em" id="who"></span><button class="ghost" style="width:auto;margin:0" id="outBtn"></button></div>
<div class="panel resident" id="resident"><div class="r-cap" id="rcap"></div><div class="r-grid" id="rgrid"></div></div>
<div class="tabs" id="mineTabs" hidden style="margin-top:-6px"><button id="mt-mine" class="on"></button><button id="mt-all"></button></div>
<div class="tabs" id="admTabs" hidden><button id="at-ov" class="on">概览</button><button id="at-us">用户</button><button id="at-lg">登录流水</button><button id="at-sb">投稿审核</button></div>
<div id="obs" hidden></div>
<div id="plist"></div>
</div>
<p class="tag" style="margin-top:26px"><a id="backLink" href="https://global.osmaigc.com" style="letter-spacing:.14em"></a></p>
</div>
<script>
var API = location.origin + '/pc-submit';
var tok = localStorage.getItem('pwc_token') || '';
var reg = false, me = null, adminMode = false, showAll = false, cache = {};
var $ = function(id){ return document.getElementById(id); };
var I18N = {
zh:{tag:'散场的故事，<b>在这里重逢</b>',login:'登录',register:'注册',email:'邮箱',pw:'密码（至少 6 位）',goLogin:'进入影院',goReg:'注册新世界账号',out:'退出登录',
cap:'居民档案 · RESIDENT FILE',waking:'正在唤醒档案…',notSync:'你的居民档案还没上传——<br>桌面端「平行世界电影院」下次在线登录时自动同步',
passBal:'通行证余额',films:'已藏影片',best:'街区最佳',stay:'驻留时长',uMin:' 分钟',uHr:' 小时',sync:'档案同步于 ',
mine:'我的投稿',all:'全部投稿 · 管理',back:'← 返回官网',loading:'加载中…',fail:'失败了，稍后再试',saved:'已保存',work:'作品↗',
replyPh:'给投稿人的回复（用户可见）',save:'保存',contact:'联系：',official:'官方：',anon:'匿名投稿',user:'用户#',admin:'管理员',
noMine:'还没有投稿',noAll:'还没有任何投稿',toCreators:'去创作者专区交一份',adminOnly:'仅管理员可见',
st_received:'已收到',st_reviewing:'审核中',st_scheduled:'已排片',st_rejected:'退回',typeFilm:'放映',typeGame:'街区',
errBoth:'请填写邮箱和密码',errPw:'密码至少 6 位',errReg:'该邮箱已注册，直接登录即可',errCred:'邮箱或密码不对',errAuth:'请先登录'},
en:{tag:'Stories that ended <b>meet you again here</b>',login:'Log in',register:'Sign up',email:'Email',pw:'Password (min 6)',goLogin:'Enter the cinema',goReg:'Create account',out:'Sign out',
cap:'RESIDENT FILE',waking:'Waking your file…',notSync:'Your resident file hasn’t been uploaded —<br>the desktop app syncs it on its next online login',
passBal:'Pass balance',films:'Films owned',best:'Best run',stay:'Time resident',uMin:' min',uHr:' h',sync:'File synced at ',
mine:'My submissions',all:'All · Admin',back:'← Home',loading:'Loading…',fail:'Something failed — try again',saved:'Saved',work:'Work ↗',
replyPh:'Reply to this creator (visible to them)',save:'Save',contact:'Contact: ',official:'Official: ',anon:'Anonymous',user:'User #',admin:'Admin',
noMine:'No submissions yet',noAll:'No submissions yet',toCreators:'Send one from Creators',adminOnly:'Admin only',
st_received:'Received',st_reviewing:'Reviewing',st_scheduled:'Scheduled',st_rejected:'Rejected',typeFilm:'Film',typeGame:'District',
errBoth:'Email and password required',errPw:'Password needs 6+ characters',errReg:'Already registered — just sign in',errCred:'Wrong email or password',errAuth:'Please sign in first'},
ja:{tag:'終わった物語が、<b>ここで再会する</b>',login:'ログイン',register:'新規登録',email:'メール',pw:'パスワード（6文字以上）',goLogin:'映画館へ',goReg:'アカウント作成',out:'ログアウト',
cap:'レジデント・ファイル',waking:'ファイルを起動中…',notSync:'レジデントファイルは未同期です——<br>デスクトップ版が次回オンライン起動時に自動同期します',
passBal:'パス残高',films:'所蔵作品',best:'ベスト記録',stay:'滞在時間',uMin:' 分',uHr:' 時間',sync:'同期時刻：',
mine:'マイ投稿',all:'全投稿 · 管理',back:'← ホームへ',loading:'読み込み中…',fail:'失敗しました。後でもう一度',saved:'保存しました',work:'作品↗',
replyPh:'投稿者への返信（本人に表示されます）',save:'保存',contact:'連絡先：',official:'公式：',anon:'匿名投稿',user:'ユーザー#',admin:'管理者',
noMine:'まだ投稿がありません',noAll:'まだ投稿がありません',toCreators:'クリエイター专区から',adminOnly:'管理者のみ表示可',
st_received:'受付',st_reviewing:'審査中',st_scheduled:'上映決定',st_rejected:'差し戻し',typeFilm:'上映',typeGame:'街区',
errBoth:'メールとパスワードを入力してください',errPw:'パスワードは6文字以上',errReg:'登録済みです——ログインしてください',errCred:'メールまたはパスワードが違います',errAuth:'先にログインしてください'},
ko:{tag:'끝난 이야기들이,<b>여기서 다시 만납니다</b>',login:'로그인',register:'회원가입',email:'이메일',pw:'비밀번호 (6자 이상)',goLogin:'극장 입장',goReg:'계정 만들기',out:'로그아웃',
cap:'레지던트 파일',waking:'파일 깨우는 중…',notSync:'레지던트 파일이 아직 전송되지 않았습니다——<br>데스크톱 앱이 다음 온라인 실행 시 자동 동기화',
passBal:'패스 잔액',films:'소장 작품',best:'최고 기록',stay:'체류 시간',uMin:'분',uHr:'시간',sync:'동기화 시각 ',
mine:'내 투고',all:'전체 · 관리',back:'← 홈으로',loading:'불러오는 중…',fail:'실패했습니다. 잠시 후 다시',saved:'저장됨',work:'작품↗',
replyPh:'작성자에게 답글 (작성자에게도 표시됩니다)',save:'저장',contact:'연락처: ',official:'측으로부터: ',anon:'익명 투고',user:'사용자#',admin:'관리자',
noMine:'아직 투고가 없습니다',noAll:'아직 투고가 없습니다',toCreators:'크리에이터 코너에서 투고하기',adminOnly:'관리자만 표시',
st_received:'접수',st_reviewing:'심사 중',st_scheduled:'상영 확정',st_rejected:'반송',typeFilm:'상영',typeGame:'지구',
errBoth:'이메일과 비밀번호를 입력하세요',errPw:'비밀번호는 6자 이상',errReg:'이미 가입됨——로그인하세요',errCred:'이메일 또는 비밀번호가 잘못되었습니다',errAuth:'먼저 로그인하세요'}
};
var LANG = (function(){
  var m = document.cookie.match(/(?:^|; )pc_lang=([a-zA-Z]+)/);
  var l = String(m ? m[1] : (localStorage.getItem('pc_lang') || navigator.language || 'en')).slice(0, 2).toLowerCase();
  return ['zh','en','ja','ko'].indexOf(l) >= 0 ? l : 'en';
})();
function t(k){ return (I18N[LANG] || I18N.zh)[k] || I18N.zh[k] || k; }
function setLang(l){ LANG = l; localStorage.setItem('pc_lang', l); document.cookie = 'pc_lang=' + l + '; path=/; domain=.osmaigc.com; max-age=31536000; SameSite=Lax'; applyLang(); }
function applyLang(){
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : LANG;
  $('tagline').innerHTML = t('tag'); $('t-in').textContent = t('login'); $('t-up').textContent = t('register');
  $('email').placeholder = t('email'); $('pw').placeholder = t('pw');
  $('goBtn').textContent = reg ? t('goReg') : t('goLogin');
  $('outBtn').textContent = t('out'); $('rcap').textContent = t('cap');
  $('mt-mine').textContent = t('mine'); $('mt-all').textContent = t('all'); $('backLink').textContent = t('back');
  var bs = $('langs').children; for (var i = 0; i < bs.length; i++) bs[i].className = 'lang-btn' + (bs[i].getAttribute('data-l') === LANG ? ' on' : '');
  if (me) {
    $('who').innerHTML = me.email + (me.emailVerified ? '' : ' · <a href="#" data-resend="1" style="color:#ff9d8a">邮箱未验证，点此重发确认信</a>') + (adminMode ? ' · ' + t('admin') : '');
    resident(); render(true);
  }
}
$('langs').onclick = function(e){ var l = e.target.getAttribute && e.target.getAttribute('data-l'); if (l) setLang(l); };
$('t-in').onclick = function(){ tab(1); };
$('t-up').onclick = function(){ tab(0); };
if ((location.hash || '') === '#reg') { try { tab(0); } catch(e) {} }
function tab(isLogin){ reg = !isLogin; $('t-in').className = isLogin ? 'on' : ''; $('t-up').className = isLogin ? '' : 'on'; $('goBtn').textContent = isLogin ? t('goLogin') : t('goReg'); $('pw').autocomplete = isLogin ? 'current-password' : 'new-password'; }
$('mt-mine').onclick = function(){ mineTab(0); };
$('mt-all').onclick = function(){ mineTab(1); };
function mineTab(a){ showAll = !!a; $('mt-all').className = a ? 'on' : ''; $('mt-mine').className = a ? '' : 'on'; cache = {}; render(true); }
// ---- 统一后台（合并自原 /admin 运营台）：概览 / 用户 / 登录流水 / 投稿审核 ----
var admSel = 'ov', obsCache = null;
$('at-ov').onclick = function(){ admTab('ov'); };
$('at-us').onclick = function(){ admTab('us'); };
$('at-lg').onclick = function(){ admTab('lg'); };
$('at-sb').onclick = function(){ admTab('sb'); };
function admTab(k){
  admSel = k;
  try { if (location.hash !== '#adm-' + k) history.replaceState(null, '', '#adm-' + k); } catch(e) {}
  ['ov','us','lg','sb'].forEach(function(x){ $('at-' + x).className = (x === k) ? 'on' : ''; });
  $('obs').hidden = (k === 'sb');
  $('plist').hidden = (k !== 'sb');
  if (k === 'sb') { showAll = true; cache = {}; render(true); return; }
  paintObs();
}
function shortUa(ua){
  ua = String(ua || ''); if (!ua) return '—';
  var os = (ua.match(/Windows NT|Macintosh|iPhone|iPad|Android|Linux/) || ['?'])[0];
  var br = ua.indexOf('Edg') >= 0 ? 'Edge' : ua.indexOf('Chrome') >= 0 ? 'Chrome' : ua.indexOf('Firefox') >= 0 ? 'Firefox' : ua.indexOf('Safari') >= 0 ? 'Safari' : '?';
  return os.replace('Windows NT', 'Win').replace('Macintosh', 'Mac') + ' · ' + br;
}
function paintObs(){
  var box = $('obs');
  if (!obsCache) {
    box.innerHTML = '<p class="empty skel">读取中…</p>';
    api('/api/admin/users').then(function(r){
      if (r.code !== 200) { box.innerHTML = '<p class="empty">' + errText(r.j && r.j.error) + '</p>'; return; }
      obsCache = r.j; paintObs();
    });
    return;
  }
  var j = obsCache, s = j.stats || {};
  if (admSel === 'ov') {
    var cells = [['注册用户', s.users], ['此刻在线', s.online], ['今日登录', s.loginsToday], ['7 日活跃', s.active7], ['24h 失败登录', s.fails], ['投稿总数', s.subs]];
    box.innerHTML = '<div class="ostat">' + cells.map(function(c){ return '<div><b>' + (c[1] == null ? '—' : c[1]) + '</b><span>' + c[0] + '</span></div>'; }).join('') + '</div>'
      + '<p class="meta" style="text-align:center;margin:2px 0 0">数据实时取自服务器 · ' + esc(new Date().toLocaleString('zh-CN')) + '</p>';
  } else if (admSel === 'us') {
    var us = j.users || [];
    box.innerHTML = '<div class="otbl"><table><thead><tr><th>#</th><th>账号</th><th>邮箱</th><th>注册</th><th>最后登录</th><th>次数</th><th>最后 IP</th><th>投稿</th><th>在线</th></tr></thead><tbody>'
      + us.map(function(u){
        var live = u.live && u.seen && (Date.now() - new Date(String(u.seen).replace(' ', 'T') + 'Z').getTime() < 1800e3);
        return '<tr><td>' + u.id + '</td><td>' + esc(u.email) + (u.is_admin ? ' <i class="tg">管理</i>' : '') + '</td>'
          + '<td>' + (u.verified ? '<i class="tg ok">已验证</i>' : '<i class="tg wn">未验证</i>') + '</td>'
          + '<td>' + esc(u.created_at || '—') + '</td><td>' + esc(u.last_login || '—') + '</td><td>' + (u.logins || 0) + '</td>'
          + '<td>' + esc(u.last_ip || '—') + (u.ip_accounts > 1 ? ' <i class="tg wn">同IP×' + u.ip_accounts + '</i>' : '') + '</td>'
          + '<td>' + (u.subs || 0) + '</td><td>' + (live ? '● 在馆' : '—') + '</td></tr>';
      }).join('') + (us.length ? '' : '<tr><td colspan="9" style="text-align:center;color:var(--dim)">还没有注册用户</td></tr>') + '</tbody></table></div>';
  } else {
    var K = { login: '登录', register: '注册', logout: '退出', fail: '失败登录', buy: '买断', spend: '消费', refund: '退款', admin: '管理登录', verify: '邮箱验证' };
    var ev = j.events || [];
    box.innerHTML = '<div class="otbl"><table><thead><tr><th>时间</th><th>事件</th><th>账号</th><th>IP</th><th>设备</th></tr></thead><tbody>'
      + ev.map(function(e){ return '<tr><td>' + esc(e.at) + '</td><td>' + (K[e.kind] || esc(e.kind)) + '</td><td>' + esc(e.email || (e.user_id ? '用户#' + e.user_id : '—')) + '</td><td>' + esc(e.ip || '—') + '</td><td>' + esc(shortUa(e.ua)) + '</td></tr>'; }).join('')
      + (ev.length ? '' : '<tr><td colspan="5" style="text-align:center;color:var(--dim)">暂无流水</td></tr>') + '</tbody></table></div>';
  }
}
async function api(p, body, method){
  var r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().then(function(j){ return { code: r.status, j: j }; });
}
function errText(e){
  e = String(e || '');
  var exact = { 'email and password required': t('errBoth'), 'password too short (min 6)': t('errPw'), 'email already registered': t('errReg'), 'invalid email or password': t('errCred'), 'not authenticated': t('errAuth'), 'admin only': t('adminOnly') };
  if (exact[e]) return exact[e];
  if (/too short/i.test(e)) return t('errPw');
  return t('fail');
}
async function go(){
  var email = $('email').value.trim(), password = $('pw').value;
  var m = $('msg'); m.textContent = '';
  $('goBtn').disabled = true;
  var res = await api('/api/auth/' + (reg ? 'register' : 'login'), { email: email, password: password });
  $('goBtn').disabled = false;
  if (res.code === 200 && res.j.token){ tok = res.j.token; localStorage.setItem('pwc_token', tok); boot(); }
  else m.textContent = errText(res.j.error);
}
$('goBtn').onclick = go;
$('pw').addEventListener('keydown', function(e){ if (e.key === 'Enter') go(); });
$('outBtn').onclick = async function(){ await api('/api/auth/logout', {}, 'POST'); document.cookie = 'pwc_token=; Max-Age=0; path=/; domain=.osmaigc.com'; document.cookie = 'pcadmin=; Max-Age=0; path=/; domain=.osmaigc.com'; localStorage.removeItem('pwc_token'); tok = ''; me = null; cache = {}; location.reload(); };
function stBadge(s){ var c = { received: '#d4af6a', reviewing: '#9ef0e7', scheduled: '#8ee28e', rejected: '#ff9d8a' }[s] || '#d4af6a'; return '<span class="badge" style="background:' + c + '">' + t('st_' + (s || 'received')) + '</span>'; }
function stOptions(s){ return ['received','reviewing','scheduled','rejected'].map(function(k){ return '<option value="' + k + '" ' + (k === s ? 'selected' : '') + '>' + t('st_' + k) + '</option>'; }).join(''); }
function card(r){
  var mine = !showAll || !me || !me.isAdmin;
  var ops = mine ? '' :
    '<div class="ops"><select id="st-' + r.id + '">' + stOptions(r.status) + '</select>' +
    '<input id="rp-' + r.id + '" placeholder="' + esc(t('replyPh')) + '" value="' + esc(r.reply || '') + '">' +
    '<button data-save="' + r.id + '">' + t('save') + '</button><span id="sv-' + r.id + '" style="font-size:12px;color:#8ee28e"></span></div>';
  return '<div class="card"><div class="meta">#' + r.id + ' · ' + esc(r.at) + ' · ' + t(r.type === 'game' ? 'typeGame' : 'typeFilm') + ' ' + stBadge(r.status) +
    (mine ? '' : ' · ' + (r.user_id ? t('user') + r.user_id : t('anon'))) + '</div>' +
    '<div style="color:#e8c987;margin-top:2px">' + esc(r.name) + ' · <a href="' + esc(r.link) + '" target="_blank">' + t('work') + '</a></div>' +
    (r.desc ? '<div style="color:#cfc6ae;font-size:14px;margin-top:4px">' + esc(r.desc) + '</div>' : '') +
    (r.contact ? '<div class="meta" style="margin-top:5px">' + t('contact') + esc(r.contact) + '</div>' : '') +
    (r.reply ? '<div class="reply">' + t('official') + esc(r.reply) + '</div>' : '') + ops + '</div>';
}
document.addEventListener('click', function(e){
  var rs = e.target.closest && e.target.closest('[data-resend]');
  if (rs) { e.preventDefault(); rs.textContent = '发送中…'; api('/api/auth/verify/resend', {}).then(function(r){ rs.textContent = (r.j && r.j.ok) ? '确认信已发出，请查邮箱' : ((r.j && r.j.hint) || '发送失败，稍后再试'); }); return; }
  var b = e.target.closest && e.target.closest('[data-save]'); if (!b) return;
  var id = b.getAttribute('data-save');
  api('/api/submissions/set', { id: id, status: $('st-' + id).value, reply: $('rp-' + id).value }).then(function(res){
    $('sv-' + id).textContent = res.j.ok ? t('saved') : t('fail');
    if (res.j.ok) setTimeout(function(){ $('sv-' + id).textContent = ''; }, 2000);
  });
});
async function render(force){
  var key = showAll ? 'all' : 'mine';
  if (cache[key] && !force) return paint(cache[key]);
  $('plist').innerHTML = '<p class="empty skel">' + t('loading') + '</p>';
  var rows = await api(showAll ? '/api/submissions/all' : '/api/submissions/mine');
  if (rows.code !== 200) { $('plist').innerHTML = '<p class="empty">' + errText(rows.j.error) + '</p>'; return; }
  cache[key] = rows.j.submissions; paint(cache[key]);
}
function paint(list){
  $('plist').innerHTML = (list || []).map(card).join('') || '<p class="empty">' + (showAll ? t('noAll') : t('noMine') + ' — <a href="https://global.osmaigc.com/creators.html#submitform">' + t('toCreators') + '</a>') + '</p>';
}
async function resident(){
  var grid = $('rgrid'); grid.innerHTML = '<span class="r-wait">' + t('waking') + '</span>';
  var g = await api('/api/game-profile');
  if (g.code !== 200) { grid.innerHTML = '<span class="r-wait">' + errText(g.j.error) + '</span>'; return; }
  var d = g.j;
  if (d.pending) { grid.innerHTML = '<span class="r-wait">' + t('notSync') + '</span>'; return; }
  var mins = d.playtime_min || 0;
  var play = mins >= 60 ? (mins / 60).toFixed(1) + t('uHr') : mins + t('uMin');
  var cells = [[d.pass_balance, t('passBal')], [d.films_owned, t('films')], [d.games_best, t('best')], [play, t('stay')]];
  grid.innerHTML = cells.map(function(c){ return '<div class="r-cell"><span class="r-num">' + c[0] + '</span><span class="r-lab">' + c[1] + '</span></div>'; }).join('')
    + '<div class="r-foot">' + t('sync') + esc(d.synced_at || '') + '</div>';
}
async function boot(){
  if (!tok) return adminEnter();
  var m = await api('/api/user');
  if (m.code !== 200) { localStorage.removeItem('pwc_token'); tok = ''; return adminEnter(); }
  me = m.j; adminMode = !!me.isAdmin;
  $('auth').hidden = true; $('mine').hidden = false;
  $('who').textContent = me.email + (adminMode ? ' · ' + t('admin') : '');
  $('mineTabs').hidden = true;
  if (adminMode) { $('mineTabs').hidden = true; $('admTabs').hidden = false; resident(); var hk = (location.hash || '').replace('#adm-', ''); admTab(['ov','us','lg','sb'].indexOf(hk) >= 0 ? hk : 'ov'); }
  else render();
}
// 只有运营台口令、没登录居民账号时：直接进统一后台（无居民档案可看）
async function adminEnter(){
  var w = await api('/api/whoami');
  if (w.code !== 200 || !w.j.isAdmin) return;
  me = { email: w.j.email, isAdmin: true, mode: w.j.mode }; adminMode = true;
  $('auth').hidden = true; $('mine').hidden = false;
  if (w.j.mode === 'cookie') $('resident').hidden = true;
  $('who').textContent = me.email + ' · ' + t('admin');
  $('mineTabs').hidden = true; $('admTabs').hidden = false;
  admTab('ov');
}
function esc(s){ return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
applyLang();
boot();
</script></body></html>`;

http.createServer((req, res) => {
  CUR_IP = String((req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "");
  const u = new URL(req.url, "http://x");
  const corsH = corsHeaders(req.headers.origin);
  const send = (code, body, type, extra) => { res.writeHead(code, { "content-type": type || "application/json; charset=utf-8", ...corsH, ...extra }); res.end(body); };
  if (req.method === "OPTIONS") { res.writeHead(204, { ...corsH, "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-max-age": "86400" }); return res.end(); }
  if (req.method === "GET" && req.url === "/healthz") return send(200, "ok", "text/plain");

  const p = u.pathname.replace(/^\/pc-submit/, "") || "/";
  const user = userByReq(req.headers);

  // ---- API: auth (App wire-compatible) ----
  let body = null;
  const readBody = () => new Promise((done) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { body = JSON.parse(b || "{}"); } catch { body = {}; } done(); }); });

  if (p === "/api/auth/register" && req.method === "POST") {
    return readBody().then(async () => {
      const email = String(body.email || "").trim().toLowerCase().slice(0, 190), password = String(body.password || "");
      if (!email || !password) return send(400, JSON.stringify({ error: "email and password required" }));
      if (password.length < 6) return send(400, JSON.stringify({ error: "password too short (min 6)" }));
      const ip = clientIp(req.headers);
      const gate = signupGate(ip);
      if (gate) return send(429, JSON.stringify({ error: gate.code, hint: gate.hint }));
      if (db.prepare("SELECT id FROM users WHERE LOWER(email) = ?").get(email)) return send(409, JSON.stringify({ error: "email already registered" }));
      // 真邮箱体检：格式 + 域名 MX + 一次性邮箱黑名单（挡不住全部，但刷号成本从 0 变成必须持有真邮箱）
      const dl = await emailDeliverable(email);
      if (!dl.ok) return send(400, JSON.stringify({ error: "bad_email", hint: dl.reason }));
      const isAdmin = email === ADMIN_EMAIL ? 1 : 0;
      const bonusNow = REQUIRE_VERIFY ? 0 : SIGNUP_BONUS;
      const info = db.prepare("INSERT INTO users (email, pass_hash, is_admin, passes, email_verified, signup_ip) VALUES (?, ?, ?, ?, ?, ?)")
        .run(email, hashPass(password), isAdmin, bonusNow, REQUIRE_VERIFY ? 0 : 1, ip);
      const uid = Number(info.lastInsertRowid);
      if (bonusNow) db.prepare("INSERT INTO pass_ledger (user_id, delta, reason, at) VALUES (?,?,?,?)").run(uid, bonusNow, "注册赠送", nowStr());
      const token = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO sessions (token, user_id, ip, ua) VALUES (?, ?, ?, ?)").run(token, uid, ip, clientUa(req.headers));
      db.prepare("UPDATE users SET last_login = datetime('now'), last_ip = ? WHERE id = ?").run(ip, uid);
      noteSignup(ip);
      logEvent("register", uid, email, req.headers);
      let mail = null;
      if (REQUIRE_VERIFY) mail = await issueVerifyMail(uid, email, ip);
      const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
      send(200, JSON.stringify({ token, user: pubUser(fresh), need_verify: REQUIRE_VERIFY, email_verified: false, mail }), null, { "set-cookie": cookieFor(token) });
    }).catch((e) => send(500, JSON.stringify({ error: "register failed", detail: String((e && e.message) || e).slice(0, 140) })));
  }
  if (p === "/api/auth/login" && req.method === "POST") {
    return readBody().then(() => {
      const email = String(body.email || "").trim().toLowerCase();
      const rlKey = "login:" + clientIp(req.headers) + ":" + email;
      if (tooManyFails(rlKey)) return send(429, JSON.stringify({ error: "too_many_attempts", retry_after: 600 }));
      const u2 = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
      if (!u2 || !verifyPass(String(body.password || ""), u2.pass_hash)) {
        noteFail(rlKey);
        logEvent("fail", u2 ? u2.id : null, email, req.headers);
        return send(401, JSON.stringify({ error: "invalid email or password" }));
      }
      clearFails(rlKey);
      const token = crypto.randomBytes(32).toString("hex");
      const ip = clientIp(req.headers);
      db.prepare("INSERT INTO sessions (token, user_id, ip, ua) VALUES (?, ?, ?, ?)").run(token, u2.id, ip, clientUa(req.headers));
      db.prepare("UPDATE users SET last_login = datetime('now'), last_ip = ? WHERE id = ?").run(ip, u2.id);
      logEvent("login", u2.id, u2.email, req.headers);
      send(200, JSON.stringify({ token, user: pubUser(u2) }), null, { "set-cookie": cookieFor(token) });
    });
  }
  if (p === "/api/auth/logout" && req.method === "POST") {
    return readBody().then(() => {
      // 幂等：未登录也照样清 cookie 返回 200，避免「退不出去」
      if (!user) return send(200, JSON.stringify({ ok: true, already: true }), null, { "set-cookie": clearCookies() });
      const token = String(req.headers.authorization || "").replace("Bearer ", "")
        || ((req.headers.cookie || "").match(/pwc_token=([a-f0-9]+)/) || [])[1] || "";
      // keep the row for the audit trail; mark it revoked instead of deleting it
      db.prepare("UPDATE sessions SET revoked = 1, last_seen = datetime('now') WHERE token = ?").run(token);
      logEvent("logout", user.id, user.email, req.headers);
      send(200, JSON.stringify({ ok: true }), null, { "set-cookie": clearCookies() });
    });
  }
  if (p === "/api/user" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify(pubUser(user)));
  }

  // ---- API: 邮箱验证（点击即完成，注册流程不多一步）----
  if (p === "/api/auth/verify" && req.method === "GET") {
    const tk = String(u.searchParams.get("t") || "").slice(0, 80);
    const row = tk ? db.prepare("SELECT * FROM email_tokens WHERE token = ? AND kind = 'verify'").get(tk) : null;
    const html = (code, title, body, ok) => send(code, verifyPage(title, body, ok), null, { "content-type": "text/html; charset=utf-8" });
    if (!row) return html(404, "链接无效", "这个确认链接不存在，请回到电影院重新发送确认邮件。", false);
    if (row.used_at) return html(200, "邮箱已确认过", "这个链接已经用过了，直接登录即可。", true);
    if (row.exp < Math.floor(Date.now() / 1000)) return html(410, "链接已过期", "确认链接已超时，请登录后在页面顶部点“重发确认邮件”。", false);
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE token = ?").run(nowStr(), tk);
    db.prepare("UPDATE users SET email_verified = 1, email_verified_at = ? WHERE id = ?").run(nowStr(), row.user_id);
    const g = grantVerifyBonus(row.user_id);
    logEvent("verify", row.user_id, row.email, req.headers);
    return html(200, "邮箱已确认", `${esc(row.email)} 已验证。${g.granted ? `${g.granted} 张通证已到账，` : ""}回到客户端刷新即可使用。`, true);
  }
  if (p === "/api/auth/verify/resend" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    if (user.email_verified) return send(200, JSON.stringify({ ok: true, already: true }));
    return (async () => {
    const rlKey = "vmail:" + user.id;
    const recent = db.prepare("SELECT COUNT(*) AS c FROM email_tokens WHERE user_id = ? AND kind = 'verify' AND exp > ?").get(user.id, Math.floor(Date.now() / 1000) - VERIFY_TTL_H * 3600 + 300);
    if (recent && recent.c >= 5) return send(429, JSON.stringify({ error: "too_many_mails", hint: "今天发送次数用完了，明天再试" }));
    const nowS = Math.floor(Date.now() / 1000);
    const latest = db.prepare("SELECT MAX(exp) AS e FROM email_tokens WHERE user_id = ? AND kind = 'verify'").get(user.id);
    if (latest && latest.e && nowS - (latest.e - VERIFY_TTL_H * 3600) < 60) return send(429, JSON.stringify({ error: "too_many_mails", hint: "稍等一分钟再重发" }));
    noteFail(rlKey);
    const mail = await issueVerifyMail(user.id, user.email, clientIp(req.headers));
    return send(200, JSON.stringify({ ok: true, mail }));
    })();
  }

  // ---- API: 账号资产（云端唯一真源；App/网页只做缓存镜像）----
  if (p === "/api/owned" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify(ownedList(user.id)));
  }
  if (p === "/api/owned" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const film = body.film || {};
      const id = String(film.id || "");
      const f = id ? filmRow(id) : null;
      // 服务器没上架的片不认：防止客户端自造 film.id / src 白拿藏品
      if (!f) return send(404, JSON.stringify({ error: "unknown_film", film: id }));
      const now = nowStr();
      const existing = db.prepare("SELECT * FROM owned WHERE user_id = ? AND film_id = ?").get(user.id, id);
      if (existing) {
        db.prepare("UPDATE owned SET watch_count = watch_count + 1, last_watched = ?, src = CASE WHEN src = '' THEN ? ELSE src END WHERE user_id = ? AND film_id = ?")
          .run(now, String(clip(film.src, 500)), user.id, id);
      } else {
        const price = f.price | 0;
        const bal = (db.prepare("SELECT passes FROM users WHERE id = ?").get(user.id) || {}).passes || 0;
        if (bal < price) return send(402, JSON.stringify({ error: "insufficient_passes", passes: bal, price }));
        if (price > 0) {
          db.prepare("UPDATE users SET passes = COALESCE(passes,0) - ? WHERE id = ?").run(price, user.id);
          db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)").run(user.id, -price, `买断《${f.title || id}》`, now);
        }
        db.prepare("INSERT INTO owned (user_id,film_id,title,plane_name,director,duration,src,first_watched,last_watched,watch_count) VALUES (?,?,?,?,?,?,?,?,?,1)")
          .run(user.id, id, f.title || clip(film.title, 120), clip(film.planeName, 80), clip(film.director, 80), clip(film.duration, 40), clip(film.src, 500), now, now);
        logEvent("buy", user.id, user.email, req.headers);
      }
      const passes = (db.prepare("SELECT passes FROM users WHERE id = ?").get(user.id) || {}).passes || 0;
      send(200, JSON.stringify({ isNew: !existing, passes, owned: ownedList(user.id) }));
    });
  }
  if (p === "/api/passes" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const row = db.prepare("SELECT passes FROM users WHERE id = ?").get(user.id);
    const ledger = db.prepare("SELECT delta, reason, at AS created_at FROM pass_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 20").all(user.id);
    const owned = db.prepare("SELECT film_id FROM owned WHERE user_id = ?").all(user.id).map((r) => r.film_id);
    return send(200, JSON.stringify({ passes: (row && row.passes) || 0, owned, ledger }));
  }
  if (p === "/api/passes/recharge" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const pack = PASS_PACKS[body.pack];
      if (!pack) return send(400, JSON.stringify({ error: "unknown pack", packs: Object.keys(PASS_PACKS) }));
      // 支付通道未接：加卡只允许管理员（旧本地版免费充值是权限漏洞，已封）
      if (!user.is_admin && !adminCookieOk(req.headers)) return send(402, JSON.stringify({ error: "payment_required", packs: Object.keys(PASS_PACKS) }));
      db.prepare("UPDATE users SET passes = COALESCE(passes,0) + ? WHERE id = ?").run(pack.n, user.id);
      db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)").run(user.id, pack.n, `充值 · ${pack.label}`, nowStr());
      const row = db.prepare("SELECT passes FROM users WHERE id = ?").get(user.id);
      send(200, JSON.stringify({ passes: row.passes, added: pack.n, label: pack.label }));
    });
  }
  // 游戏内消耗（观测/私语/按摩…）：带 key 幂等扣费；同 key 可退一次，杜绝客户端无限退款
  if (p === "/api/passes/spend" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    if (!user.email_verified) return send(403, JSON.stringify({ error: "email_not_verified", hint: "请先点邮箱里的确认链接，确认后即可消费通证" }));
    return readBody().then(() => {
      const amount = Math.max(1, Math.min(999, Math.round(Number(body.amount) || 1)));
      const key = String(body.key || "").slice(0, 80);
      if (!key) return send(400, JSON.stringify({ error: "key required" }));
      const prior = db.prepare("SELECT * FROM pass_spends WHERE key = ?").get(key);
      const bal = (db.prepare("SELECT passes FROM users WHERE id = ?").get(user.id) || {}).passes || 0;
      if (prior) {
        if (prior.user_id !== user.id) return send(409, JSON.stringify({ error: "key collision" }));
        return send(200, JSON.stringify({ passes: bal, key, deduped: true }));
      }
      if (bal < amount) return send(402, JSON.stringify({ error: "insufficient_passes", passes: bal, price: amount }));
      db.prepare("UPDATE users SET passes = COALESCE(passes,0) - ? WHERE id = ?").run(amount, user.id);
      db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)").run(user.id, -amount, String(body.reason || "消费").slice(0, 60), nowStr());
      db.prepare("INSERT INTO pass_spends (key,user_id,amount,reason,at) VALUES (?,?,?,?,?)").run(key, user.id, amount, String(body.reason || "").slice(0, 60), nowStr());
      logEvent("spend", user.id, user.email, req.headers);
      send(200, JSON.stringify({ passes: bal - amount, key }));
    });
  }
  if (p === "/api/passes/refund" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const key = String(body.key || "").slice(0, 80);
      const s = key ? db.prepare("SELECT * FROM pass_spends WHERE key = ? AND user_id = ?").get(key, user.id) : null;
      if (!s) return send(404, JSON.stringify({ error: "spend not found" }));
      if (s.refunded) return send(200, JSON.stringify({ passes: currentPasses(user.id), key, deduped: true }));
      db.prepare("UPDATE users SET passes = COALESCE(passes,0) + ? WHERE id = ?").run(s.amount, user.id);
      db.prepare("UPDATE pass_spends SET refunded = 1 WHERE key = ?").run(key);
      db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)").run(user.id, s.amount, `退回 · ${s.reason || ""}`.slice(0, 60), nowStr());
      send(200, JSON.stringify({ passes: currentPasses(user.id), key }));
    });
  }

  if (p === "/api/profile" && req.method === "PUT") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const nm = String(body.name || "").trim().slice(0, 24);
      const gd = String(body.gender || "").trim().slice(0, 4);
      const lg = String(body.lang || "");
      const hasLang = ["zh", "en", "ja", "ko"].includes(lg);
      if (!nm && !hasLang) return send(400, JSON.stringify({ error: "name required" }));
      if (nm) db.prepare("UPDATE users SET name = ?, gender = ? WHERE id = ?").run(nm, gd, user.id);
      if (hasLang) db.prepare("UPDATE users SET lang = ? WHERE id = ?").run(lg, user.id);
      const row = db.prepare("SELECT name, gender, lang FROM users WHERE id = ?").get(user.id);
      send(200, JSON.stringify({ ok: true, name: row.name, gender: row.gender, lang: row.lang || "zh" }));
    });
  }
  // ---- API: 社交 · 好友（账号级关系，云端唯一；换机/网页/App 一致）----
  if (p === "/api/friends" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify({ friends: friendList(user.id) }));
  }
  if (p === "/api/friends" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return send(400, JSON.stringify({ error: "email required" }));
      const target = db.prepare("SELECT id, email FROM users WHERE LOWER(email) = ?").get(email);
      if (!target) return send(404, JSON.stringify({ error: "user not found" }));
      if (target.id === user.id) return send(400, JSON.stringify({ error: "cannot add yourself" }));
      // 双向：同看需要彼此可见
      db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)").run(user.id, target.id);
      db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)").run(target.id, user.id);
      send(200, JSON.stringify({ friends: friendList(user.id) }));
    });
  }
  let mFr = p.match(/^\/api\/friends\/(\d+)$/);
  if (mFr && req.method === "DELETE") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const fid = Number(mFr[1]);
    db.prepare("DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)").run(user.id, fid, fid, user.id);
    return send(200, JSON.stringify({ ok: true, friends: friendList(user.id) }));
  }

  // ---- API: 剧场经济 · 小靡专场（票款/票房/分成只由服务端改）----
  if (p === "/api/shows/mine" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const row = db.prepare("SELECT id, theme, title, script, fallback, shareholder, pinned, created_at FROM shows WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
    return send(200, JSON.stringify({ show: row || null, reused: !!row }));
  }
  if (p === "/api/shows" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const theme = String(body.theme || "").slice(0, 40) || "日常生活";
      const script = String(body.script || "").slice(0, 8000);
      const title = String(body.title || "").slice(0, 40) || (theme + "之夜");
      if (script.length < 20) return send(400, JSON.stringify({ error: "script required" }));
      const info = db.prepare("INSERT INTO shows (user_id, theme, title, script, fallback, shareholder, created_at) VALUES (?,?,?,?,?,0,?)")
        .run(user.id, theme, title, script, body.fallback ? 1 : 0, nowStr());
      const show = db.prepare("SELECT id, theme, title, script, fallback, shareholder, pinned, created_at FROM shows WHERE id = ?").get(info.lastInsertRowid);
      send(200, JSON.stringify({ show, reused: false }));
    });
  }
  let mSh = p.match(/^\/api\/shows\/(\d+)\/shareholder$/);
  if (mSh && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const id = Number(mSh[1]);
      const on = !!body.on;
      const any = db.prepare("SELECT id, user_id FROM shows WHERE id = ?").get(id);
      if (!any) return send(404, JSON.stringify({ error: "show not found" }));
      if (any.user_id !== user.id) return send(403, JSON.stringify({ error: "not your show" }));
      db.prepare("UPDATE shows SET shareholder = ? WHERE id = ?").run(on ? 1 : 0, id);
      // 签约即开分账账本（幂等）；解约再签不重置累计票房
      if (on) db.prepare("INSERT OR IGNORE INTO show_payouts (show_id, user_id) VALUES (?, ?)").run(id, user.id);
      send(200, JSON.stringify({ ok: true, shareholder: on }));
    });
  }
  if (p === "/api/stage/shows" && req.method === "GET") {
    settleShowPayouts();
    return send(200, JSON.stringify({ shows: stageList(), day: localDayStr() }));
  }
  if (p === "/api/stage/buy" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    if (!user.email_verified) return send(403, JSON.stringify({ error: "email_not_verified", hint: "请先确认邮箱再购票" }));
    return readBody().then(() => {
      const id = Number(body.show_id);
      const key = String(body.key || "").slice(0, 80);
      if (!key) return send(400, JSON.stringify({ error: "key required" }));
      const show = db.prepare("SELECT id, title FROM shows WHERE id = ? AND shareholder = 1").get(id);
      if (!show) return send(404, JSON.stringify({ error: "show not found" }));
      const soldNow = () => (db.prepare("SELECT COUNT(*) AS n FROM show_tickets WHERE show_id = ?").get(id) || { n: 0 }).n;
      const prior = db.prepare("SELECT * FROM show_tickets WHERE spend_key = ?").get(key);
      if (prior) {
        if (prior.buyer_id !== user.id) return send(409, JSON.stringify({ error: "key collision" }));
        return send(200, JSON.stringify({ ok: true, passes: currentPasses(user.id), tickets_sold: soldNow(), deduped: true }));
      }
      settleShowPayouts();
      const bal = currentPasses(user.id);
      if (bal < 1) return send(402, JSON.stringify({ error: "insufficient_passes", passes: bal, price: 1 }));
      db.prepare("UPDATE users SET passes = COALESCE(passes,0) - 1 WHERE id = ?").run(user.id);
      db.prepare("INSERT INTO pass_ledger (user_id,delta,reason,at) VALUES (?,?,?,?)").run(user.id, -1, `购买小靡专场门票 #${id}`, nowStr());
      db.prepare("INSERT INTO show_tickets (show_id, buyer_id, price, spend_key, at) VALUES (?,?,?,?,?)").run(id, user.id, 1, key, nowStr());
      logEvent("buy", user.id, user.email, req.headers);
      send(200, JSON.stringify({ ok: true, passes: bal - 1, tickets_sold: soldNow(), key }));
    });
  }

  // ---- API: 放映房间（跨机同看：房间与进度在云端，客户端轮询 state）----
  if (p === "/api/rooms/join" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const filmId = String(body.filmId || "");
      if (!filmId) return send(400, JSON.stringify({ error: "filmId required" }));
      const fresh = db.prepare("SELECT * FROM rooms WHERE film_id = ? AND created_at > datetime('now','-6 hours') ORDER BY created_at DESC LIMIT 1").get(filmId);
      let room = fresh;
      if (!room) {
        const rid = crypto.randomBytes(4).toString("hex");
        db.prepare("INSERT INTO rooms (id, film_id, film_title, plane_name) VALUES (?,?,?,?)")
          .run(rid, filmId, String(body.filmTitle || "").slice(0, 120), String(body.planeName || "").slice(0, 60));
        room = { id: rid };
      }
      const nm = String(user.name || String(user.email).split("@")[0]).slice(0, 24);
      db.prepare("INSERT OR REPLACE INTO room_members (room_id,user_id,name,pos,playing,last_seen) VALUES (?,?,?,COALESCE((SELECT pos FROM room_members WHERE room_id=? AND user_id=?),0),0,?)")
        .run(room.id, user.id, nm, room.id, user.id, nowStr());
      send(200, JSON.stringify({ roomId: room.id, members: roomMembers(room.id) }));
    });
  }
  if (p === "/api/rooms/progress" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const rid = String(body.roomId || "");
      const mem = db.prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?").get(rid, user.id);
      if (!mem) return send(403, JSON.stringify({ error: "not in room" }));
      db.prepare("UPDATE room_members SET pos = ?, playing = ?, last_seen = ? WHERE room_id = ? AND user_id = ?")
        .run(Math.max(0, Number(body.time) || 0), body.playing ? 1 : 0, nowStr(), rid, user.id);
      send(200, JSON.stringify({ ok: true }));
    });
  }
  if (p === "/api/rooms/leave" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const rid = String(body.roomId || "");
      db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").run(rid, user.id);
      const left = db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?").get(rid) || { n: 0 };
      if (!left.n) { db.prepare("DELETE FROM rooms WHERE id = ?").run(rid); db.prepare("DELETE FROM whispers WHERE room_id = ?").run(rid); }
      send(200, JSON.stringify({ ok: true }));
    });
  }
  if (p === "/api/rooms/whisper" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const rid = String(body.roomId || "");
      const text = String(body.text || "").slice(0, 120);
      if (!rid || !text) return send(400, JSON.stringify({ error: "roomId and text required" }));
      const mem = db.prepare("SELECT 1 AS x FROM room_members WHERE room_id = ? AND user_id = ?").get(rid, user.id);
      if (!mem) return send(403, JSON.stringify({ error: "not in room" }));
      const nm = String(user.name || String(user.email).split("@")[0]).slice(0, 24);
      const info = db.prepare("INSERT INTO whispers (room_id,user_id,name,text,at) VALUES (?,?,?,?,?)").run(rid, user.id, nm, text, Date.now());
      send(200, JSON.stringify({ ok: true, id: info.lastInsertRowid }));
    });
  }
  let mRm = p.match(/^\/api\/rooms\/([a-z0-9]+)\/state$/);
  if (mRm && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const rid = mRm[1];
    const since = Number(u.searchParams.get("since") || 0);
    // 2 分钟无心跳视为离场（浏览器崩了也不会留幽灵观众）
    db.prepare("DELETE FROM room_members WHERE room_id = ? AND last_seen < ?").run(rid, new Date(Date.now() + 8 * 3600e3 - 120e3).toISOString().slice(0, 19).replace("T", " "));
    const whispers = db.prepare("SELECT id,user_id,name,text,at FROM whispers WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 50").all(rid, since);
    return send(200, JSON.stringify({ roomId: rid, members: roomMembers(rid), whispers, serverTime: Date.now() }));
  }

  // ---- API: 存档快照（游戏进度上云；本地仍是缓存，换机可恢复）----
  if (p === "/api/save" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const row = db.prepare("SELECT data, updated_at FROM user_saves WHERE user_id = ?").get(user.id);
    let data = null;
    try { data = row ? JSON.parse(row.data) : null; } catch { data = null; }
    return send(200, JSON.stringify({ data, updated_at: row ? row.updated_at : null }));
  }
  if (p === "/api/save" && req.method === "PUT") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return readBody().then(() => {
      const blob = JSON.stringify(body.data || {});
      if (blob.length > 400000) return send(413, JSON.stringify({ error: "save too large" }));
      const cur = db.prepare("SELECT updated_at FROM user_saves WHERE user_id = ?").get(user.id);
      const clientTs = String(body.client_ts || "");
      if (cur && clientTs && String(cur.updated_at) > clientTs) {
        // 云端更新：拒绝覆盖，把云端那份还给客户端
        let server = null;
        try { server = JSON.parse((db.prepare("SELECT data FROM user_saves WHERE user_id = ?").get(user.id) || {}).data || "null"); } catch {}
        return send(409, JSON.stringify({ error: "stale_save", updated_at: cur.updated_at, data: server }));
      }
      db.prepare("INSERT INTO user_saves (user_id,data,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
        .run(user.id, blob, nowStr());
      send(200, JSON.stringify({ ok: true, updated_at: nowStr() }));
    });
  }

  // 价目同步：只允许管理员推 manifest（价目决定扣费，普通客户端不能改）
  if (p === "/api/admin/manifest" && req.method === "POST") {
    if (!user || !user.is_admin) {
      if (!adminCookieOk(req.headers)) return send(403, JSON.stringify({ error: "admin only" }));
    }
    return readBody().then(() => {
      try {
        const json = JSON.stringify(body);
        if (!Array.isArray(body.schedules)) return send(400, JSON.stringify({ error: "schedules required" }));
        fs.writeFileSync(MANIFEST_PATH, json);
        const n = syncPricesFromManifest();
        send(200, JSON.stringify({ ok: true, films: n }));
      } catch (e) { send(500, JSON.stringify({ error: String(e).slice(0, 120) })); }
    });
  }

  // ---- API: game profile (App pushes; portal reads) ----
  if (p === "/api/game-profile" && req.method === "POST") {
    if (!user) return send(401, JSON.stringify({ error: "app session required" }));
    return readBody().then(() => {
      const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
      db.prepare(`INSERT INTO game_profile (user_id,pass_balance,pass_expires,films_owned,games_best,playtime_min,synced_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET pass_balance=excluded.pass_balance, pass_expires=excluded.pass_expires,
          films_owned=excluded.films_owned, games_best=excluded.games_best, playtime_min=excluded.playtime_min, synced_at=excluded.synced_at`)
        .run(user.id, num(body.pass_balance), clip(body.pass_expires, 40), num(body.films_owned), num(body.games_best), num(body.playtime_min),
            new Date().toISOString().replace("T", " ").slice(0, 19));
      send(200, JSON.stringify({ ok: true }));
    });
  }
  if (p === "/api/game-profile" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    const row = db.prepare("SELECT * FROM game_profile WHERE user_id = ?").get(user.id);
    return send(200, JSON.stringify(row || { pending: true }));
  }

  // ---- API: submissions ----
  if (p === "/api/submissions" && req.method === "POST") {
    const ip = req.headers["x-forwarded-for"] || "unknown";
    if (!user) {
      if (last.has(ip) && Date.now() - last.get(ip) < RATE_MS) return send(429, JSON.stringify({ ok: false, err: "slow down" }));
      last.set(ip, Date.now());
    }
    return readBody().then(() => {
      const rec = {
        at: new Date().toISOString().replace("T", " ").slice(0, 19),
        type: body.type === "game" ? "game" : "film",
        name: clip(body.name, 120), link: clip(body.link, 500),
        contact: clip(body.contact, 200), desc: clip(body.desc, 4000), ip: String(ip).split(",")[0],
      };
      if (!rec.name || !rec.link) return send(400, JSON.stringify({ ok: false, err: "name & link required" }));
      const info = db.prepare("INSERT INTO submissions (user_id,at,type,name,link,contact,desc,ip) VALUES (?,?,?,?,?,?,?,?)")
        .run(user ? user.id : null, rec.at, rec.type, rec.name, rec.link, rec.contact, rec.desc, rec.ip);
      send(200, JSON.stringify({ ok: true, id: Number(info.lastInsertRowid), signed: !!user }));
      console.log("submission:", rec.name, user ? "user#" + user.id : "anon", "from", rec.ip);
    });
  }
  if (p === "/api/submissions/mine" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify({ submissions: db.prepare("SELECT * FROM submissions WHERE user_id = ? ORDER BY id DESC").all(user.id) }));
  }
  if (p === "/api/submissions/all" && req.method === "GET") {
    if (!adminGate(user, req.headers)) return send(403, JSON.stringify({ error: "admin only" }));
    return send(200, JSON.stringify({ submissions: db.prepare("SELECT * FROM submissions ORDER BY id DESC").all() }));
  }
  if (p === "/api/submissions/set" && req.method === "POST") {
    if (!adminGate(user, req.headers)) return send(403, JSON.stringify({ error: "admin only" }));
    return readBody().then(() => {
      const id = Number(body.id);
      const status = ST[body.status] ? body.status : "received";
      const reply = String(body.reply || "").slice(0, 1000);
      db.prepare("UPDATE submissions SET status = ?, reply = ? WHERE id = ?").run(status, reply, id);
      send(200, JSON.stringify({ ok: true }));
    });
  }

  // ---- API: admin observability (users + login history) ----
  if (p === "/api/admin/users" && req.method === "GET") {
    if (!adminGate(user, req.headers)) return send(403, JSON.stringify({ error: "admin only" }));
    const obs = obsData();
    return send(200, JSON.stringify({ ok: true, stats: obs.stats, users: obs.users, events: obs.events }));
  }
  // 门户自检：账号登录 或 运营台口令（合并后唯一后台的两条入口）
  if (p === "/api/whoami" && req.method === "GET") {
    if (user) return send(200, JSON.stringify({ ok: true, email: user.email, isAdmin: !!user.is_admin, mode: "account" }));
    if (adminCookieOk(req.headers)) return send(200, JSON.stringify({ ok: true, email: "运营台口令", isAdmin: true, mode: "cookie" }));
    return send(401, JSON.stringify({ error: "not authenticated" }));
  }

  // ---- portal page ----
  if (p === "/account" && req.method === "GET") return send(200, PORTAL, "text/html; charset=utf-8", { "cache-control": "no-cache" });

  // ---- 运营台登录：POST 口令 → 只下发签名 cookie（口令绝不进 URL / 访问日志 / Referer）----
  const loginErrHtml = (msg) => `<meta http-equiv="refresh" content="1.6"><body style="background:#0d0b08;color:#ff9d8a;font:16px sans-serif;text-align:center;padding-top:40vh">${msg}<script>setTimeout(()=>location.href="/pc-submit/admin",1600)</script>`;
  if (p === "/admin" && req.method === "POST") {
    return formBody((f) => {
      const pw = String(f.get("pass") || "");
      const key = "admin:" + clientIp(req.headers);
      if (tooManyFails(key)) return send(429, loginErrHtml("尝试过于频繁，请十分钟后再试"), "text/html; charset=utf-8");
      if (!safeEq(pw, ADMIN_PASS)) { noteFail(key); return send(200, loginErrHtml("口令不对，请重试"), "text/html; charset=utf-8"); }
      clearFails(key);
      logEvent("admin", null, "运营台口令登录", req.headers);
      res.writeHead(302, { location: "/pc-submit/account", "set-cookie": ADMIN_COOKIE() });
      res.end();
    });
  }
  if (p === "/admin/logout") {
    res.writeHead(302, { location: "/pc-submit/admin", "set-cookie": "pcadmin=; Path=/; Domain=.osmaigc.com; Max-Age=0; Secure; HttpOnly" });
    return res.end();
  }
  if (p.startsWith("/admin")) {
    if (!adminGate(user, req.headers)) {
      return send(200, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>运营台</title><body style="background:#0d0b08;color:#f4f0e6;font:16px sans-serif;display:grid;place-items:center;height:100vh"><form method="post" action="/pc-submit/admin" style="text-align:center"><p style="letter-spacing:.2em;color:#d4af6a">平行世界 · 运营台</p><input name="pass" type="password" autocomplete="current-password" placeholder="管理口令" style="background:transparent;border:1px solid #d4af6a;border-radius:8px;padding:10px 16px;color:#f4f0e6;font-size:16px"><button style="margin-left:8px;padding:10px 20px;background:#d4af6a;border:0;border-radius:8px;font-size:15px">进入</button></form></body></html>`, "text/html; charset=utf-8", { "cache-control": "no-store" });
    }
    if (p === "/admin/set") {
      const id = Number(u.searchParams.get("id"));
      return formBody((f) => {
        const status = ST[f.get("status")] ? f.get("status") : "received";
        const reply = String(f.get("reply") || "").slice(0, 1000);
        db.prepare("UPDATE submissions SET status = ?, reply = ? WHERE id = ?").run(status, reply, id);
        res.writeHead(302, { location: "/pc-submit/account" });
        return res.end();
      });
    }
    // 合并后：/admin 不再渲染独立运营台，统一跳门户（界面只剩一套）
    res.writeHead(302, { location: "/pc-submit/account", "cache-control": "no-store" });
    return res.end();
  }

  // 未匹配路径：只有投稿入口才走匿名收集，其余一律 404
  //（否则任何打错的 POST 都会被当成投稿，还会撞上投稿限流回一个莫名其妙的 429）
  if (req.method !== "POST" || (p !== "/" && p !== "/submit")) {
    return send(404, JSON.stringify({ error: "not found", path: p }));
  }
  return handleAnonPost();

  function handleAnonPost() {
    const ip = req.headers["x-forwarded-for"] || "unknown";
    if (last.has(ip) && Date.now() - last.get(ip) < RATE_MS) return send(429, JSON.stringify({ ok: false, err: "slow down" }));
    last.set(ip, Date.now());
    return readBody().then(() => {
      const rec = {
        at: new Date().toISOString().replace("T", " ").slice(0, 19),
        type: body.type === "game" ? "game" : "film",
        name: clip(body.name, 120), link: clip(body.link, 500),
        contact: clip(body.contact, 200), desc: clip(body.desc, 4000), ip: String(ip).split(",")[0],
      };
      if (!rec.name || !rec.link) return send(400, JSON.stringify({ ok: false, err: "name & link required" }));
      const info = db.prepare("INSERT INTO submissions (user_id,at,type,name,link,contact,desc,ip) VALUES (null,?,?,?,?,?,?,?)")
        .run(rec.at, rec.type, rec.name, rec.link, rec.contact, rec.desc, rec.ip);
      const subject = `[平行世界投稿] ${TYPE_CN[rec.type]} · ${rec.name}`;
      const html = `<h3>${esc(rec.name)}</h3><p>类型：${TYPE_CN[rec.type]}<br>时间：${rec.at}<br>链接：<a href="${esc(rec.link)}">${esc(rec.link)}</a><br>联系：${esc(rec.contact || "—")}</p><hr>${esc(rec.desc || "").replace(/\n/g, "<br>")}`;
      transporter.sendMail({ from: `"平行世界投稿" <${process.env.SMTP_USER}>`, to: TO, subject, html })
        .catch((e) => console.log("mail fail (recorded anyway):", String(e).slice(0, 100)));
      console.log("submission(anon):", rec.name, "from", rec.ip);
      send(200, JSON.stringify({ ok: true, id: Number(info.lastInsertRowid), signed: false }));
    });
  }

  function formBody(cb) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => cb(new URLSearchParams(raw)));
  }
}).listen(PORT, "127.0.0.1", () => console.log("pc-center on :" + PORT));
