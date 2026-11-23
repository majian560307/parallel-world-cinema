// Parallel World Cinema — submission intake + admin
import http from "node:http";
import fs from "node:fs";
import nodemailer from "nodemailer";

const PORT = Number(process.env.PORT || 3010);
const TO = "yanaranft@gmail.com";
const ARCHIVE = "/opt/submit/submissions.jsonl";
const FLAGS = "/opt/submit/flags.json";
const ADMIN_PASS = process.env.ADMIN_PASS || "changeme";
const RATE_MS = 10_000;
const last = new Map();

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const readRecords = () => {
  try { return fs.readFileSync(ARCHIVE, "utf8").split("\n").filter(Boolean).map((l, i) => { try { return { id: i, ...JSON.parse(l) }; } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const readFlags = () => { try { return JSON.parse(fs.readFileSync(FLAGS, "utf8")); } catch { return {}; } };
const writeFlags = (f) => fs.writeFileSync(FLAGS, JSON.stringify(f));

const transporter = nodemailer.createTransport({
  host: "smtp.qq.com", port: 465, secure: true, connectionTimeout: 15000, greetingTimeout: 15000,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const TYPE_CN = { film: "放映 · FILM", game: "街区 · GAME" };

function sendMail(rec) {
  const subject = `[平行世界投稿] ${rec.type === "game" ? "街区" : "放映"} · ${rec.name}`;
  const html = `<h3>${esc(rec.name)}</h3><p>类型：${TYPE_CN[rec.type] || rec.type}<br>时间：${rec.at}<br>链接：<a href="${esc(rec.link)}">${esc(rec.link)}</a><br>联系：${esc(rec.contact || "—")}</p><hr>${esc(rec.desc || "").replace(/\n/g, "<br>")}`;
  transporter.sendMail({ from: `"平行世界投稿" <${process.env.SMTP_USER}>`, to: TO, subject, html })
    .catch((e) => console.log("mail fail (queued locally):", String(e).slice(0, 140)));
}

const adminPage = (rows, flags, note) => {
  const unread = rows.filter((r) => !flags[r.id]).length;
  const cards = rows.map((r) => {
    const seen = !!flags[r.id];
    return `<div class="card ${seen ? "" : "new"}"><div class="meta">#${r.id} · ${esc(r.at)} · ${TYPE_CN[r.type] || esc(r.type)}${seen ? "" : ' <b class="badge">未读</b>'}</div><div class="name">${esc(r.name)}</div><div class="desc">${esc(r.desc || "").replace(/\n/g, "<br>")}</div><div class="links">链接：<a href="${esc(r.link)}" target="_blank">${esc(r.link)}</a> · 联系：${esc(r.contact || "—")}</div><div class="ops"><a class="btn" href="/pc-submit/admin/review?id=${r.id}&pass=${encodeURIComponent(ADMIN_PASS)}&seen=${seen ? 0 : 1}">${seen ? "标记未读" : "标为已读"}</a><a class="btn mail" href="mailto:yanaranft@gmail.com?subject=${encodeURIComponent("[投稿 #" + r.id + "] " + r.name)}&body=${encodeURIComponent("链接：" + r.link + "\n联系：" + (r.contact || "—") + "\n\n" + (r.desc || ""))}">转发邮件</a><a class="btn" href="/pc-submit/admin/del?id=${r.id}&pass=${encodeURIComponent(ADMIN_PASS)}" onclick="return confirm('删除 #${r.id} ${esc(r.name)}？')">删除</a></div></div>`;
  }).join("");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>投稿后台 · 平行世界电影院</title><style>
body{background:#0d0b08;color:#f4f0e6;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:760px;margin:0 auto;padding:28px 18px}
h1{font-size:20px;letter-spacing:.1em;border-bottom:1px solid rgba(212,175,106,.35);padding-bottom:14px}
h1 small{float:right;font-size:12px;color:#8b8272;font-weight:400;margin-top:6px}
.card{border:1px solid rgba(212,175,106,.22);border-radius:12px;padding:16px 18px;margin:14px 0;background:rgba(255,255,255,.03)}
.card.new{border-color:rgba(212,175,106,.75);box-shadow:0 0 24px rgba(212,175,106,.12)}
.badge{color:#0d0b08;background:#d4af6a;border-radius:99px;font-size:11px;padding:2px 9px;letter-spacing:.15em}
.meta{font-size:12px;color:#8b8272;letter-spacing:.06em}
.name{font-size:17px;color:#e8c987;margin:4px 0}
.desc{color:#cfc6ae;white-space:pre-wrap}
.links{font-size:13px;color:#8b8272;margin-top:8px;word-break:break-all}
a{color:#d4af6a}
.ops{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap}
.btn{font-size:12px;text-decoration:none;border:1px solid rgba(212,175,106,.4);border-radius:99px;padding:4px 14px;color:#d4af6a}
.empty{color:#8b8272;text-align:center;padding:60px 0}
</style><h1>平行世界 · 投稿后台 <small>${rows.length} 份存档 · ${unread} 未读</small></h1>${note ? `<p style="color:#d4af6a">${note}</p>` : ""}${cards || '<p class="empty">暂无投稿</p>'}`;
};

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body, type) => { res.writeHead(code, { "content-type": type || "text/plain; charset=utf-8", "access-control-allow-origin": "*" }); res.end(body); };

  if (req.method === "GET" && req.url === "/healthz") return send(200, "ok");
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "86400" }); return res.end(); }

  // ---- admin ----
  const pass = u.searchParams.get("pass") || ((req.headers.cookie || "").match(/pcadmin=([^;]+)/) || [])[1] || "";
  if (u.pathname === "/admin" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body).get("pass");
      if (p === ADMIN_PASS) { res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS), "set-cookie": "pcadmin=" + p + "; Path=/pc-submit/; Max-Age=86400" }); return res.end(); }
      return send(200, `<meta http-equiv="refresh" content="1.2"><body style="background:#0d0b08;color:#ff9d8a;font:16px sans-serif;text-align:center;padding-top:40vh">口令不对，请重试<script>setTimeout(()=>location.href="/pc-submit/admin",1200)</script>`);
    });
    return;
  }
  if (u.pathname.startsWith("/admin")) {
    if (pass !== ADMIN_PASS) {
      return send(200, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>投稿后台</title><body style="background:#0d0b08;color:#f4f0e6;font:16px sans-serif;display:grid;place-items:center;height:100vh"><form method="post" action="/pc-submit/admin" style="text-align:center"><p style="letter-spacing:.2em;color:#d4af6a">平行世界 · 投稿后台</p><input name="pass" type="password" placeholder="管理口令" style="background:transparent;border:1px solid #d4af6a;border-radius:8px;padding:10px 16px;color:#f4f0e6;font-size:16px"><button style="margin-left:8px;padding:10px 20px;background:#d4af6a;border:0;border-radius:8px;font-size:15px">进入</button></form></body></html>`);
    }
    if (u.pathname === "/admin/review") {
      const f = readFlags(); const id = u.searchParams.get("id");
      if (u.searchParams.get("seen") === "1") f[id] = Date.now(); else delete f[id];
      writeFlags(f);
      res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS) }); return res.end();
    }
    if (u.pathname === "/admin/del") {
      const id = Number(u.searchParams.get("id"));
      const kept = readRecords().filter((r) => r.id !== id);
      fs.writeFileSync(ARCHIVE, kept.map(({ id, ...r }) => JSON.stringify(r)).join("\n") + "\n");
      res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS) }); return res.end();
    }
    const rows = readRecords().sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return send(200, adminPage(rows, readFlags()), "text/html; charset=utf-8");
  }
  if (req.method === "POST" && u.pathname === "/admin") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body).get("pass");
      if (p === ADMIN_PASS) { res.writeHead(302, { location: "/pc-submit/admin?pass=" + encodeURIComponent(ADMIN_PASS), "set-cookie": "pcadmin=" + p + "; Path=/pc-submit/; Max-Age=86400" }); return res.end(); }
      return send(200, adminPage(readRecords(), readFlags(), "") && `<meta http-equiv="refresh" content="1.2"><body style="background:#0d0b08;color:#ff9d8a;font:16px sans-serif;text-align:center;padding-top:40vh">口令不对，请重试<script>setTimeout(()=>location.href="/pc-submit/admin",1200)</script>`);
    });
    return;
  }

  // ---- intake ----
  if (req.method !== "POST") return send(405, JSON.stringify({ ok: false, err: "POST only" }));
  const ip = req.headers["x-forwarded-for"] || "unknown";
  if (last.has(ip) && Date.now() - last.get(ip) < RATE_MS) return send(429, JSON.stringify({ ok: false, err: "slow down" }));
  last.set(ip, Date.now());
  let body = "";
  req.on("data", (c) => { if ((body += c).length > 20000) { send(413, JSON.stringify({ ok: false, err: "too large" })); req.destroy(); } });
  req.on("end", () => {
    let d; try { d = JSON.parse(body); } catch { return send(400, JSON.stringify({ ok: false, err: "bad json" })); }
    const rec = {
      at: new Date().toISOString().replace("T", " ").slice(0, 19),
      type: d.type === "game" ? "game" : "film",
      name: clip(d.name, 120), link: clip(d.link, 500),
      contact: clip(d.contact, 200), desc: clip(d.desc, 4000), ip: String(ip).split(",")[0],
    };
    if (!rec.name || !rec.link) return send(400, JSON.stringify({ ok: false, err: "name & link required" }));
    fs.appendFileSync(ARCHIVE, JSON.stringify(rec) + "\n");
    sendMail(rec);
    console.log("received:", rec.name, "from", rec.ip);
    send(200, JSON.stringify({ ok: true }));
  });
}).listen(PORT, "127.0.0.1", () => console.log("submit intake on :" + PORT));
