// Parallel World Cinema — central account & submission service
// Auth API is wire-compatible with the desktop App's server.mjs (/api/auth/*).
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";

const PORT = Number(process.env.PORT || 3010);
const TO = "yanaranft@gmail.com";
const ADMIN_EMAIL = "yanaranft@gmail.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme";
const DB_PATH = process.env.DB_PATH || "/opt/submit/pc-center.db";
const LEGACY_JSONL = "/opt/submit/submissions.jsonl";
const RATE_MS = 10_000;
const last = new Map();

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
  host: "smtp.qq.com", port: 465, secure: true, connectionTimeout: 15000, greetingTimeout: 15000,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const TYPE_CN = { film: "放映 · FILM", game: "街区 · GAME" };
const ST = { received: ["已收到", "#d4af6a"], reviewing: ["审核中", "#9ef0e7"], scheduled: ["已排片", "#8ee28e"], rejected: ["退回", "#ff9d8a"] };

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const pubUser = (u) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin, created_at: u.created_at });

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
const clientIp = (h) => (String(h["x-forwarded-for"] || h["x-real-ip"] || "").split(",")[0].trim() || "unknown");
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
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /Firefox\//.test(s) ? "Firefox" : /curl/.test(s) ? "curl" : "?";
  return os + " · " + br;
};

function obsData() {
  const users = db.prepare(`
    SELECT u.id, u.email, u.is_admin, u.created_at, u.last_login, u.last_ip,
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
    online: one("SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE COALESCE(revoked,0) = 0 AND last_seen >= datetime('now','-30 minutes')"),
    fails: one("SELECT COUNT(*) c FROM login_events WHERE kind = 'fail' AND at >= datetime('now','-1 day')"),
    subs: one("SELECT COUNT(*) c FROM submissions"),
  };
  return { users, events, stats };
}

const cookieFor = (token) => `pwc_token=${token}; Path=/; Domain=.osmaigc.com; Max-Age=2592000; SameSite=None; Secure`;
const ADMIN_COOKIE = (pw) => `pcadmin=${pw}; Path=/; Domain=.osmaigc.com; Max-Age=86400; SameSite=None; Secure`;

// ---------- admin page ----------
function adminPage(rows, obs) {
  obs = obs || { users: [], events: [], stats: {} };
  const s = obs.stats || {};
  const stat = (n, lab, cls) => `<div class="st"><b class="${cls || ''}">${n ?? 0}</b><span>${lab}</span></div>`;
  const obsHtml = `<h2>台前观测 · AUDIENCE</h2>
<div class="stats">${stat(s.users, "注册用户")}${stat(s.online, "此刻在线")}${stat(s.loginsToday, "今日登录")}${stat(s.active7, "7日活跃")}${stat(s.fails, "24h 失败登录", s.fails > 0 ? "warn" : "")}${stat(s.subs, "投稿总数")}</div>
<table><thead><tr><th>#</th><th>账号</th><th>注册</th><th>最后登录</th><th>登录次数</th><th>最后 IP</th><th>投稿</th><th>在线</th></tr></thead><tbody>
${obs.users.map((u) => `<tr${u.is_admin ? ' class="adm"' : ''}><td>${u.id}</td><td>${esc(u.email)}${u.is_admin ? ' <span class="tag">管理</span>' : ''}</td><td>${bj(u.created_at)}</td><td>${bj(u.last_login)}</td><td>${u.logins || 0}</td><td>${esc(u.last_ip || "—")}</td><td>${u.subs || 0}</td><td>${u.live && u.seen && (Date.now() - new Date(String(u.seen).replace(" ", "T") + "Z").getTime() < 1800e3) ? '<span class="dot on"></span>在馆' : '<span class="dot"></span>—'}</td></tr>`).join("")}
${obs.users.length ? "" : '<tr><td colspan="8" class="empty">还没有注册用户</td></tr>'}
</tbody></table>
<h2>登录流水 · LAST 80 EVENTS</h2>
<table><thead><tr><th>时间</th><th>事件</th><th>账号</th><th>IP</th><th>设备</th></tr></thead><tbody>
${obs.events.map((e) => `<tr><td>${bj(e.at)}</td><td><span class="ev ev-${esc(e.kind)}">${({ login: "登录", register: "注册", logout: "退出", fail: "失败" }[e.kind]) || esc(e.kind)}</span></td><td>${esc(e.email || (e.user_id ? "用户#" + e.user_id : "—"))}</td><td>${esc(e.ip || "—")}</td><td>${esc(shortUa(e.ua))}</td></tr>`).join("")}
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
.tabs{display:flex;gap:26px;border-bottom:1px solid rgba(212,175,106,.16);margin:0 0 22px;padding:0 2px}
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
</style></head><body>
<div class="langs" id="langs"><button class="lang-btn" data-l="zh">中文</button><button class="lang-btn" data-l="en">EN</button><button class="lang-btn" data-l="ja">日本語</button><button class="lang-btn" data-l="ko">한국어</button></div>
<div class="wrap">
<div class="brand"><h1 id="brandH">我的平行世界</h1><span class="en">Parallel World Cinema</span></div>
<p class="tag" id="tagline"></p>
<div class="panel" id="auth">
<div class="tabs"><button id="t-in" class="on"></button><button id="t-up"></button></div>
<input id="email" type="email" autocomplete="email"><input id="pw" type="password" autocomplete="current-password" style="margin-top:12px">
<button class="go" id="goBtn"></button><div class="msg" id="msg"></div>
</div>
<div id="mine" hidden>
<div class="hdr"><span class="em" id="who"></span><button class="ghost" style="width:auto;margin:0" id="outBtn"></button></div>
<div class="panel resident" id="resident"><div class="r-cap" id="rcap"></div><div class="r-grid" id="rgrid"></div></div>
<div class="tabs" id="mineTabs" hidden style="margin-top:-6px"><button id="mt-mine" class="on"></button><button id="mt-all"></button></div>
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
  if (me) { $('who').textContent = me.email + (adminMode ? ' · ' + t('admin') : ''); resident(); render(true); }
}
$('langs').onclick = function(e){ var l = e.target.getAttribute && e.target.getAttribute('data-l'); if (l) setLang(l); };
$('t-in').onclick = function(){ tab(1); };
$('t-up').onclick = function(){ tab(0); };
function tab(isLogin){ reg = !isLogin; $('t-in').className = isLogin ? 'on' : ''; $('t-up').className = isLogin ? '' : 'on'; $('goBtn').textContent = isLogin ? t('goLogin') : t('goReg'); $('pw').autocomplete = isLogin ? 'current-password' : 'new-password'; }
$('mt-mine').onclick = function(){ mineTab(0); };
$('mt-all').onclick = function(){ mineTab(1); };
function mineTab(a){ showAll = !!a; $('mt-all').className = a ? 'on' : ''; $('mt-mine').className = a ? '' : 'on'; cache = {}; render(true); }
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
$('outBtn').onclick = async function(){ await api('/api/auth/logout', {}, 'POST'); document.cookie = 'pwc_token=; Max-Age=0; path=/; domain=.osmaigc.com'; localStorage.removeItem('pwc_token'); tok = ''; me = null; cache = {}; location.reload(); };
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
document.addEventListener('click', function(e){ var b = e.target.closest && e.target.closest('[data-save]'); if (!b) return;
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
  if (!tok) return;
  var m = await api('/api/user');
  if (m.code !== 200) { localStorage.removeItem('pwc_token'); tok = ''; return; }
  me = m.j; adminMode = !!me.isAdmin;
  $('auth').hidden = true; $('mine').hidden = false;
  $('who').textContent = me.email + (adminMode ? ' · ' + t('admin') : '');
  $('mineTabs').hidden = !adminMode;
  render();
  resident();
}
function esc(s){ return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
applyLang();
boot();
</script></body></html>`;

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const corsH = req.headers.origin
    ? { "access-control-allow-origin": req.headers.origin, "access-control-allow-credentials": "true" }
    : { "access-control-allow-origin": "*" };
  const send = (code, body, type, extra) => { res.writeHead(code, { "content-type": type || "application/json; charset=utf-8", ...corsH, ...extra }); res.end(body); };
  if (req.method === "OPTIONS") { res.writeHead(204, { ...corsH, "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400" }); return res.end(); }
  if (req.method === "GET" && req.url === "/healthz") return send(200, "ok", "text/plain");

  const p = u.pathname.replace(/^\/pc-submit/, "") || "/";
  const user = userByReq(req.headers);

  // ---- API: auth (App wire-compatible) ----
  let body = null;
  const readBody = () => new Promise((done) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { body = JSON.parse(b || "{}"); } catch { body = {}; } done(); }); });

  if (p === "/api/auth/register" && req.method === "POST") {
    return readBody().then(() => {
      const email = String(body.email || "").trim().toLowerCase(), password = String(body.password || "");
      if (!email || !password) return send(400, JSON.stringify({ error: "email and password required" }));
      if (password.length < 6) return send(400, JSON.stringify({ error: "password too short (min 6)" }));
      if (db.prepare("SELECT id FROM users WHERE LOWER(email) = ?").get(email)) return send(409, JSON.stringify({ error: "email already registered" }));
      const info = db.prepare("INSERT INTO users (email, pass_hash, is_admin) VALUES (?, ?, ?)").run(email, hashPass(password), email === ADMIN_EMAIL ? 1 : 0);
      const token = crypto.randomBytes(32).toString("hex");
      const ip = clientIp(req.headers);
      db.prepare("INSERT INTO sessions (token, user_id, ip, ua) VALUES (?, ?, ?, ?)").run(token, info.lastInsertRowid, ip, clientUa(req.headers));
      db.prepare("UPDATE users SET last_login = datetime('now'), last_ip = ? WHERE id = ?").run(ip, info.lastInsertRowid);
      logEvent("register", info.lastInsertRowid, email, req.headers);
      send(200, JSON.stringify({ token, user: pubUser({ id: info.lastInsertRowid, email, is_admin: email === ADMIN_EMAIL }) }), null, { "set-cookie": cookieFor(token) });
    });
  }
  if (p === "/api/auth/login" && req.method === "POST") {
    return readBody().then(() => {
      const email = String(body.email || "").trim().toLowerCase();
      const u2 = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
      if (!u2 || !verifyPass(String(body.password || ""), u2.pass_hash)) {
        logEvent("fail", u2 ? u2.id : null, email, req.headers);
        return send(401, JSON.stringify({ error: "invalid email or password" }));
      }
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
      if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
      const token = String(req.headers.authorization || "").replace("Bearer ", "")
        || ((req.headers.cookie || "").match(/pwc_token=([a-f0-9]+)/) || [])[1] || "";
      // keep the row for the audit trail; mark it revoked instead of deleting it
      db.prepare("UPDATE sessions SET revoked = 1, last_seen = datetime('now') WHERE token = ?").run(token);
      logEvent("logout", user.id, user.email, req.headers);
      send(200, JSON.stringify({ ok: true }));
    });
  }
  if (p === "/api/user" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify(pubUser(user)));
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
    if (!user || !user.is_admin) return send(403, JSON.stringify({ error: "admin only" }));
    return send(200, JSON.stringify({ submissions: db.prepare("SELECT * FROM submissions ORDER BY id DESC").all() }));
  }
  if (p === "/api/submissions/set" && req.method === "POST") {
    if (!user || !user.is_admin) return send(403, JSON.stringify({ error: "admin only" }));
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
    if (!user || !user.is_admin) return send(403, JSON.stringify({ error: "admin only" }));
    const obs = obsData();
    return send(200, JSON.stringify({ ok: true, stats: obs.stats, users: obs.users, events: obs.events }));
  }

  // ---- portal page ----
  if (p === "/account" && req.method === "GET") return send(200, PORTAL, "text/html; charset=utf-8", { "cache-control": "no-cache" });

  // ---- legacy pass-based admin ----
  const pass = u.searchParams.get("pass") || ((req.headers.cookie || "").match(/pcadmin=([^;]+)/) || [])[1] || "";
  if (p === "/admin" && req.method === "POST") {
    return formBody((f) => {
      const pw = f.get("pass");
      if (pw !== ADMIN_PASS) return send(200, `<meta http-equiv="refresh" content="1.2"><body style="background:#0d0b08;color:#ff9d8a;font:16px sans-serif;text-align:center;padding-top:40vh">口令不对，请重试<script>setTimeout(()=>location.href="/pc-submit/admin",1200)</script>`, "text/html");
      res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS), "set-cookie": ADMIN_COOKIE(pw) });
      res.end();
    });
  }
  if (p.startsWith("/admin")) {
    if (pass !== ADMIN_PASS && !(user && user.is_admin)) {
      return send(200, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>投稿后台</title><body style="background:#0d0b08;color:#f4f0e6;font:16px sans-serif;display:grid;place-items:center;height:100vh"><form method="post" action="/pc-submit/admin" style="text-align:center"><p style="letter-spacing:.2em;color:#d4af6a">平行世界 · 投稿后台</p><input name="pass" type="password" placeholder="管理口令" style="background:transparent;border:1px solid #d4af6a;border-radius:8px;padding:10px 16px;color:#f4f0e6;font-size:16px"><button style="margin-left:8px;padding:10px 20px;background:#d4af6a;border:0;border-radius:8px;font-size:15px">进入</button></form></body></html>`, "text/html");
    }
    if (p === "/admin/set") {
      const id = Number(u.searchParams.get("id"));
      return formBody((f) => {
        const status = ST[f.get("status")] ? f.get("status") : "received";
        const reply = String(f.get("reply") || "").slice(0, 1000);
        db.prepare("UPDATE submissions SET status = ?, reply = ? WHERE id = ?").run(status, reply, id);
        res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS) });
        return res.end();
      });
    }
    const rows = db.prepare("SELECT * FROM submissions ORDER BY id DESC").all();
    return send(200, adminPage(rows, obsData()), "text/html; charset=utf-8");
  }

  // default: anonymous intake (legacy path used by creators.html)
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
