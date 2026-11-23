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
const DB_PATH = "/opt/submit/pc-center.db";
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
);`);
db.prepare("UPDATE users SET is_admin = 1 WHERE lower(email) = ?").run(ADMIN_EMAIL);

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
  const row = db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?").get(token);
  return row || null;
}
const cookieFor = (token) => `pwc_token=${token}; Path=/; Domain=.osmaigc.com; Max-Age=2592000; SameSite=None; Secure`;
const ADMIN_COOKIE = (pw) => `pcadmin=${pw}; Path=/; Domain=.osmaigc.com; Max-Age=86400; SameSite=None; Secure`;

// ---------- admin page ----------
function adminPage(rows) {
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
body{background:#0d0b08;color:#f4f0e6;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:820px;margin:0 auto;padding:28px 18px}
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
.empty{color:#8b8272;text-align:center;padding:60px 0}
</style><h1>平行世界 · 投稿后台 <small>${rows.length} 份 · <a href="/pc-submit/account" style="font-size:12px">用户门户→</a></small></h1>${cards || '<p class="empty">暂无投稿</p>'}`;
}

// ---------- portal (login / register / my page) ----------
const PORTAL = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的平行世界 · 账号门户</title><style>
body{background:#0d0b08;color:#f4f0e6;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:640px;margin:0 auto;padding:32px 18px}
h1{font-size:19px;letter-spacing:.14em;color:#e8c987}
.tabs{display:flex;gap:0;border-bottom:1px solid rgba(212,175,106,.3);margin:22px 0 20px}
.tabs button{background:none;border:0;color:#8b8272;font-size:15px;letter-spacing:.1em;padding:10px 22px;cursor:pointer;border-bottom:2px solid transparent}
.tabs button.on{color:#d4af6a;border-bottom-color:#d4af6a}
input,select,textarea{display:block;width:100%;box-sizing:border-box;margin:12px 0 0;padding:11px 14px;background:rgba(255,255,255,.04);border:1px solid rgba(212,175,106,.35);border-radius:10px;color:#f4f0e6;font:inherit;font-size:14.5px}
.go{margin-top:18px;width:100%;padding:12px;background:#d4af6a;color:#0d0b08;border:0;border-radius:99px;font-size:15px;letter-spacing:.2em;cursor:pointer}
.msg{min-height:22px;font-size:13px;color:#ff9d8a;margin-top:12px}
.card{border:1px solid rgba(212,175,106,.22);border-radius:12px;padding:14px 16px;margin:12px 0;background:rgba(255,255,255,.03)}
.badge{border-radius:99px;font-size:11px;letter-spacing:.12em;padding:2px 10px;color:#0d0b08}
.meta{font-size:12px;color:#8b8272}
.reply{margin-top:8px;border-left:2px solid #d4af6a;padding-left:10px;color:#cfc6ae;font-size:14px}
.hdr{display:flex;justify-content:space-between;align-items:center}.hdr .em{color:#8b8272;font-size:13px}
.ops{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.ops input{display:inline-block;width:auto;flex:1;min-width:160px;margin:0;padding:8px 12px;font-size:13px}
.ops select{width:auto;display:inline-block;padding:8px 12px;font-size:13px;background:rgba(255,255,255,.04);border:1px solid rgba(212,175,106,.35);border-radius:10px;color:#f4f0e6;font:inherit}
.ops button{background:#d4af6a;color:#0d0b08;border:0;border-radius:99px;padding:8px 20px;font-size:13px;cursor:pointer}
a{color:#d4af6a}
</style></head><body>
<div class="hdr"><h1>我的平行世界</h1><span class="em" id="who"></span></div>
<div id="auth">
<div class="tabs"><button id="t-in" class="on" onclick="tab(1)">登录</button><button id="t-up" onclick="tab(0)">注册</button></div>
<input id="email" type="email" placeholder="邮箱"><input id="pw" type="password" placeholder="密码（至少 6 位）">
<button class="go" id="goBtn">进入影院</button><div class="msg" id="msg"></div>
</div>
<div id="mine" hidden>
<div class="tabs" id="mineTabs" hidden><button id="mt-mine" class="on" onclick="mineTab(0)">我的投稿</button><button id="mt-all" onclick="mineTab(1)">全部投稿 · 管理</button></div>
<div id="plist"></div>
<button class="go" onclick="logout()">退出登录</button></div>
<script>
var API = location.origin + '/pc-submit';
var tok = localStorage.getItem('pwc_token') || '';
var reg = false, me = null, adminMode = false, showAll = false;
function tab(r){ reg = !!r; document.getElementById('t-up').className = r ? 'on' : ''; document.getElementById('t-in').className = r ? '' : 'on'; document.getElementById('goBtn').textContent = r ? '注册新世界账号' : '进入影院'; }
function mineTab(a){ showAll = !!a; document.getElementById('mt-all').className = a ? 'on' : ''; document.getElementById('mt-mine').className = a ? '' : 'on'; render(); }
window.mineTab = mineTab;
async function api(p, body, method){
  var r = await fetch(API + p, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json().then(function(j){ return { code: r.status, j: j }; });
}
async function go(){
  var email = document.getElementById('email').value.trim(), password = document.getElementById('pw').value;
  var m = document.getElementById('msg'); m.textContent = '';
  var res = await api('/api/auth/' + (reg ? 'register' : 'login'), { email: email, password: password });
  if (res.code === 200 && res.j.token){ tok = res.j.token; localStorage.setItem('pwc_token', tok); boot(); }
  else m.textContent = res.j.error || '失败，稍后再试';
}
document.getElementById('goBtn').onclick = go;
document.getElementById('pw').addEventListener('keydown', function(e){ if (e.key === 'Enter') go(); });
async function logout(){ await api('/api/auth/logout', {}, 'POST'); localStorage.removeItem('pwc_token'); tok = ''; boot(); }
function stBadge(s){ var map = { received: ['已收到', '#d4af6a'], reviewing: ['审核中', '#9ef0e7'], scheduled: ['已排片', '#8ee28e'], rejected: ['退回', '#ff9d8a'] }; var v = map[s] || map.received; return '<span class="badge" style="background:' + v[1] + '">' + v[0] + '</span>'; }
function stOptions(s){ var map = { received: '已收到', reviewing: '审核中', scheduled: '已排片', rejected: '退回' }; return Object.entries(map).map(function(e){ return '<option value="' + e[0] + '" ' + (e[0] === s ? 'selected' : '') + '>' + e[1] + '</option>'; }).join(''); }
function card(r){
  var mine = !showAll || !me || !me.isAdmin;
  var ops = mine ? '' :
    '<div class="ops"><select id="st-' + r.id + '">' + stOptions(r.status) + '</select>' +
    '<input id="rp-' + r.id + '" placeholder="给投稿人的回复（用户可见）" value="' + esc(r.reply || '') + '" style="flex:1;min-width:160px;margin:0">' +
    '<button onclick="save(' + r.id + ')">保存</button><span id="sv-' + r.id + '" style="font-size:12px;color:#8ee28e"></span></div>';
  return '<div class="card"><div class="meta">#' + r.id + ' · ' + esc(r.at) + ' · ' + (r.type === 'game' ? '街区' : '放映') + ' ' + stBadge(r.status) +
    (mine ? '' : ' · ' + (r.user_id ? '用户#' + r.user_id : '匿名投稿')) + '</div>' +
    '<div style="color:#e8c987">' + esc(r.name) + ' · <a href="' + esc(r.link) + '" target="_blank">作品↗</a></div>' +
    (r.desc ? '<div style="color:#cfc6ae;font-size:14px;margin-top:4px">' + esc(r.desc) + '</div>' : '') +
    (r.contact ? '<div class="meta" style="margin-top:4px">联系：' + esc(r.contact) + '</div>' : '') +
    (r.reply ? '<div class="reply">官方：' + esc(r.reply) + '</div>' : '') + ops + '</div>';
}
async function save(id){
  var res = await api('/api/submissions/set', { id: id, status: document.getElementById('st-' + id).value, reply: document.getElementById('rp-' + id).value });
  document.getElementById('sv-' + id).textContent = res.j.ok ? '已保存' : '失败';
  if (res.j.ok) setTimeout(function(){ document.getElementById('sv-' + id).textContent = ''; }, 2000);
}
window.save = save;
async function render(){
  var rows = await api(showAll ? '/api/submissions/all' : '/api/submissions/mine');
  if (rows.code !== 200) { document.getElementById('plist').innerHTML = '<p class="meta" style="text-align:center">' + (rows.j.error || '加载失败') + '</p>'; return; }
  document.getElementById('plist').innerHTML = (rows.j.submissions || []).map(card).join('') || '<p class="meta" style="text-align:center;padding:40px 0">' + (showAll ? '还没有任何投稿' : '还没有投稿 — 去 <a href="https://global.osmaigc.com/creators.html#submitform">创作者专区</a> 交一份') + '</p>';
}
async function boot(){
  if (!tok) { document.getElementById('auth').hidden = false; document.getElementById('mine').hidden = true; return; }
  var m = await api('/api/user');
  if (m.code !== 200) { localStorage.removeItem('pwc_token'); tok = ''; return boot(); }
  me = m.j; adminMode = !!me.isAdmin;
  document.getElementById('auth').hidden = true; document.getElementById('mine').hidden = false;
  document.getElementById('who').textContent = me.email + (adminMode ? ' · 管理员' : '');
  document.getElementById('mineTabs').hidden = !adminMode;
  render();
}
function esc(s){ return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
window.logout = logout;
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
      db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, info.lastInsertRowid);
      send(200, JSON.stringify({ token, user: pubUser({ id: info.lastInsertRowid, email, is_admin: email === ADMIN_EMAIL }) }), null, { "set-cookie": cookieFor(token) });
    });
  }
  if (p === "/api/auth/login" && req.method === "POST") {
    return readBody().then(() => {
      const email = String(body.email || "").trim().toLowerCase();
      const u2 = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(email);
      if (!u2 || !verifyPass(String(body.password || ""), u2.pass_hash)) return send(401, JSON.stringify({ error: "invalid email or password" }));
      const token = crypto.randomBytes(32).toString("hex");
      db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, u2.id);
      send(200, JSON.stringify({ token, user: pubUser(u2) }), null, { "set-cookie": cookieFor(token) });
    });
  }
  if (p === "/api/auth/logout" && req.method === "POST") {
    return readBody().then(() => {
      if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
      db.prepare("DELETE FROM sessions WHERE token = ?").run(String(req.headers.authorization || "").replace("Bearer ", ""));
      send(200, JSON.stringify({ ok: true }));
    });
  }
  if (p === "/api/user" && req.method === "GET") {
    if (!user) return send(401, JSON.stringify({ error: "not authenticated" }));
    return send(200, JSON.stringify(pubUser(user)));
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

  // ---- portal page ----
  if (p === "/account" && req.method === "GET") return send(200, PORTAL, "text/html; charset=utf-8");

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
    return send(200, adminPage(rows), "text/html; charset=utf-8");
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
