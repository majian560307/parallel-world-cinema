// 双通证 smoke test：本地 3199，独立 DB，不碰生产
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const DIR = process.env.TDIR;
const DB = path.join(DIR, "t.db");
const BASE = "http://127.0.0.1:3199";
const out = [];
const ok = (cond, msg) => { out.push((cond ? "PASS " : "FAIL ") + msg); if (!cond) process.exitCode = 1; };

const call = async (p, opt = {}) => {
  const r = await fetch(BASE + p, {
    method: opt.method || "GET",
    headers: { "content-type": "application/json", ...(opt.cookie ? { cookie: opt.cookie } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { j = {}; }
  return { status: r.status, j };
};

(async () => {
  const db = new DatabaseSync(DB);
  // 造两个人：u1 创作者(管理员,开专场), u2 玩家
  db.exec(`INSERT INTO users (email, pass_hash, is_admin, passes, email_verified) VALUES ('c@t.local','x',1,0,1), ('p@t.local','x',0,0,1)`);
  const u1 = db.prepare("SELECT id FROM users WHERE email='c@t.local'").get().id;
  const u2 = db.prepare("SELECT id FROM users WHERE email='p@t.local'").get().id;
  db.exec(`INSERT INTO sessions (token,user_id) VALUES ('aaaa1111',${u1}),('bbbb2222',${u2})`);
  const cA = "pwc_token=aaaa1111", cB = "pwc_token=bbbb2222";
  // 专场（u1 名下，签约分账）
  db.exec(`INSERT INTO shows (id,user_id,title,script,shareholder) VALUES (1,${u1},'测试专场','剧本',1)`);
  db.exec(`INSERT INTO show_payouts (show_id,user_id,cum,paid,carry,last_day) VALUES (1,${u1},0,0,0,NULL)`);
  // u2 三类批次：真钱金通10 / 礼包金通5(0现金) / 绿通10(90天) / 过期绿通99
  const ins = db.prepare(`INSERT INTO pass_batches (user_id,kind,qty,remaining,unit_cash,source,reason,expires_at) VALUES (?,?,?,?,?,?,?,?)`);
  ins.run(u2, "gold", 10, 10, 1, "test_paid", "真钱金通", null);
  ins.run(u2, "gold", 5, 5, 0, "signup", "礼包金通", null);
  ins.run(u2, "green", 10, 10, 0, "matrix", "绿通", "2099-01-01");
  ins.run(u2, "green", 99, 99, 0, "matrix", "过期绿通", "2020-01-01");

  // 1) 余额口径：过期批次不计
  let r = await call("/api/passes", { cookie: cB });
  ok(r.status === 200 && r.j.green === 10 && r.j.gold === 15 && r.j.passes === 25, `余额 green10/gold15/total25 → ${JSON.stringify({ g: r.j.green, o: r.j.gold, t: r.j.passes })}`);
  ok(r.j.promo === true, `promo 生效 provided=${r.j.promo}`);

  // 2) 买票 FIFO：绿通先花 → cash_backed 0
  r = await call("/api/stage/buy", { method: "POST", cookie: cB, body: { show_id: 1, key: "k1" } });
  ok(r.status === 200 && r.j.paid_kind === "green" && r.j.cash_backed === 0, `首票花绿通、0 现金背书 → ${JSON.stringify(r.j)}`);

  // 3) 自买不计分成（给创作者一张真钱票去自买）
  ins.run(u1, "gold", 1, 1, 1, "test_paid", "真钱金通", null);
  r = await call("/api/stage/buy", { method: "POST", cookie: cA, body: { show_id: 1, key: "k2" } });
  ok(r.status === 200 && r.j.self_buy === true && r.j.cash_backed === 0, `自买不计分成 → ${JSON.stringify(r.j)}`);

  // 4) 把绿通清零，买 4 张 → 金通真钱，cash_backed 1/张
  db.exec(`UPDATE pass_batches SET remaining=0 WHERE user_id=${u2} AND kind='green'`);
  for (const k of ["k3", "k4", "k5", "k6"]) {
    r = await call("/api/stage/buy", { method: "POST", cookie: cB, body: { show_id: 1, key: k } });
    ok(r.status === 200 && r.j.cash_backed === 1, `${k} 真钱金通 cash_backed=1 → ${JSON.stringify({ k: r.j.paid_kind, c: r.j.cash_backed })}`);
  }
  const agg = db.prepare("SELECT COUNT(*) n, SUM(price) face, SUM(cash_backed) cash, SUM(self_buy) selfb FROM show_tickets WHERE show_id=1").get();
  ok(agg.n === 6 && agg.cash === 4, `票面6张/现金背书4 → n=${agg.n} face=${agg.face} cash=${agg.cash} self=${agg.selfb}`);

  // 5) 分成：只按 cash_backed 的 50%
  db.exec(`UPDATE show_payouts SET last_day='2020-01-01', cum=0 WHERE show_id=1`);
  r = await call("/api/stage/shows", { cookie: cB });
  const pay = db.prepare("SELECT paid, cum FROM show_payouts WHERE show_id=1").get();
  ok(pay && pay.paid === 2, `分成=floor(4现金/2)=2 → paid=${pay && pay.paid} cum=${pay && pay.cum}`);
  const po = db.prepare("SELECT kind, qty, unit_cash, source FROM pass_batches WHERE user_id=? AND source='payout'").get(u1);
  ok(po && po.qty === 2 && po.unit_cash === 1, `分成入账金通真钱 → ${JSON.stringify(po)}`);

  // 6) 绿通不再通过充值发行（只做首注礼）
  r = await call("/api/passes/recharge", { method: "POST", cookie: cA, body: { pack: "mid", kind: "green" } });
  ok(r.status === 403 && r.j.error === "green_signup_only", `充绿通被拒 → ${r.status} ${r.j.error}`);

  // 6b) 促销：充算力送金通（1 算力 = 1 金通，赠送批次 0 现金）
  r = await call("/api/passes/recharge", { method: "POST", cookie: cA, body: { kind: "compute", compute: 20 } });

  ok(r.status === 200 && r.j.compute === 20 && r.j.bonus === 20 && r.j.added === 0,
     `充算力20送金通20、不动现金通证 → ${JSON.stringify({ c: r.j.compute, b: r.j.bonus, a: r.j.added })}`);

  // 7) 促销：充金送金（买的 1 现金背书、送的 0）
  r = await call("/api/passes/recharge", { method: "POST", cookie: cA, body: { pack: "small", kind: "gold" } });
  // 2(分成) + 20(充算力送) + 5(充) + 5(送) = 32
  ok(r.status === 200 && r.j.gold === 32 && r.j.bonus === 5, `充金5送金5(+分成2+充算力送20) → ${JSON.stringify({ o: r.j.gold, b: r.j.bonus })}`);
  const goldB = db.prepare("SELECT unit_cash, qty FROM pass_batches WHERE user_id=? AND source IN ('game','promo_bonus') ORDER BY unit_cash").all(u1);
  ok(goldB.length === 2 && goldB[0].unit_cash === 0 && goldB[1].unit_cash === 1, `金通分两批(赠0/真钱1) → ${JSON.stringify(goldB)}`);

  // 8) 算力端点
  r = await call("/api/compute", { cookie: cA });
  ok(r.status === 200 && r.j.compute === 20 && r.j.ledger.length >= 1, `算力账本 → ${r.j.compute}`);

  // 9) 幂等
  r = await call("/api/stage/buy", { method: "POST", cookie: cB, body: { show_id: 1, key: "k1" } });
  ok(r.status === 200 && r.j.deduped === true, `同 key 不重复扣费 → ${JSON.stringify(r.j)}`);

  // 10) 余额不足
  db.exec(`UPDATE pass_batches SET remaining=0 WHERE user_id=${u2}`);
  r = await call("/api/stage/buy", { method: "POST", cookie: cB, body: { show_id: 1, key: "k9" } });
  ok(r.status === 402, `余额不足 402 → ${r.status}`);

  // 11) 退款按原批次币种回补
  db.exec(`UPDATE pass_batches SET remaining=5 WHERE user_id=${u2} AND kind='gold' AND unit_cash=1`);
  r = await call("/api/passes/spend", { method: "POST", cookie: cB, body: { amount: 2, key: "s1", reason: "按摩" } });
  ok(r.status === 200 && r.j.gold === 3, `消费2 → gold3 ${JSON.stringify(r.j)}`);
  r = await call("/api/passes/refund", { method: "POST", cookie: cB, body: { key: "s1" } });
  ok(r.status === 200 && r.j.passes === 5, `退款回补 → ${r.j.passes}`);

  console.log(out.join("\n"));
  console.log(process.exitCode ? "SMOKE_FAILED" : "SMOKE_OK");
})().catch((e) => { console.log("ERR", e && e.stack || e); process.exitCode = 1; });
