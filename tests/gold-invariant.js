// 金通不变量审计：任何 DB 都能跑，只读。
// 用法：node tests/gold-invariant.js <db路径>
// 退出码 1 = 发现可刷的金通（违反「必须有充值才出现」）
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.argv[2];
if (!dbPath) { console.error("用法: node tests/gold-invariant.js <db路径>"); process.exit(2); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const out = [];
const bad = (msg) => { out.push("FAIL " + msg); process.exitCode = 1; };
const good = (msg) => out.push("PASS " + msg);

if (!has("pass_batches")) { console.log("PASS 无 pass_batches 表，跳过"); process.exit(0); }
const bCols = cols("pass_batches");
const hasRef = bCols.includes("ref");
const hasLog = has("recharge_log");

// 1) 现金金通必须有付费来源（测试夹具可用 AUDIT_ALLOW=test_paid,probe 放行）
const extra = String(process.env.AUDIT_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);
const CASH_OK = ["game", "payout", "refund", "legacy", ...extra].map((s) => `'${s}'`).join(",");
const r1 = db.prepare(`SELECT source, COUNT(*) n, COALESCE(SUM(qty),0) q FROM pass_batches
  WHERE kind='gold' AND unit_cash > 0 AND source NOT IN (${CASH_OK}) GROUP BY source`).all();
r1.length === 0 ? good("现金金通来源合法（只来自充值/分成/退回/迁移）")
               : bad(`现金金通来源非法: ${JSON.stringify(r1)}`);

// 2) 促销赠送金通必须挂着一条真实充值流水
if (!hasLog) {
  const n = db.prepare("SELECT COUNT(*) c FROM pass_batches WHERE kind='gold' AND unit_cash=0 AND source IN ('compute_bonus','promo_bonus')").get().c;
  n === 0 ? good("无赠送金通（且无 recharge_log，历史库）") : bad(`有 ${n} 笔赠送金通但无 recharge_log 表`);
} else {
  const orphan = hasRef
    ? db.prepare(`SELECT COUNT(*) c FROM pass_batches b WHERE b.kind='gold' AND b.source IN ('compute_bonus','promo_bonus')
        AND (b.ref IS NULL OR NOT EXISTS (SELECT 1 FROM recharge_log l WHERE l.ref = b.ref))`).get().c
    : db.prepare(`SELECT COUNT(*) c FROM pass_batches b WHERE b.kind='gold' AND b.source IN ('compute_bonus','promo_bonus')`).get().c;
  orphan === 0 ? good("赠送金通全部有充值凭证") : bad(`无凭证赠送金通 ${orphan} 笔`);

  // 3) 每笔赠送额度不得超过该笔充值所能赠送的上限（防后台手改数量）
  if (!hasRef) {
    out.push("SKIP 旧库无 ref 列，跳过额度核对（重建库或 ALTER 后再跑）");
  } else {
    const over = db.prepare(`SELECT l.ref, l.bonus cap, COALESCE(SUM(b.qty),0) got FROM recharge_log l
      LEFT JOIN pass_batches b ON b.ref = l.ref AND b.kind='gold' AND b.source IN ('compute_bonus','promo_bonus')
      GROUP BY l.ref HAVING got > cap`).all();
    over.length === 0 ? good("赠送未超充值流水额度") : bad(`赠送超额度: ${JSON.stringify(over)}`);
  }
}

// 4) 绿通不得带现金属性
const r4 = db.prepare("SELECT COUNT(*) c FROM pass_batches WHERE kind='green' AND unit_cash > 0").get().c;
r4 === 0 ? good("绿通无现金属性") : bad(`绿通带现金背书 ${r4} 笔`);

// 5) 现金背书的票不得超过真钱金通发行量
if (has("show_tickets") && cols("show_tickets").includes("cash_backed")) {
  const cash = db.prepare("SELECT COALESCE(SUM(cash_backed),0) c FROM show_tickets").get().c;
  const issued = db.prepare("SELECT COALESCE(SUM(qty),0) c FROM pass_batches WHERE kind='gold' AND unit_cash > 0").get().c;
  cash <= issued ? good(`现金背书票 ${cash} ≤ 真钱金通发行 ${issued}`) : bad(`现金背书票 ${cash} > 真钱金通发行 ${issued}`);
}

// 概览
const bySrc = db.prepare("SELECT kind, source, unit_cash, COUNT(*) n, COALESCE(SUM(qty),0) q, COALESCE(SUM(remaining),0) lv FROM pass_batches GROUP BY kind, source, unit_cash ORDER BY kind, source").all();
console.log(out.join("\n"));
console.log("—— 批次概览 ——");
for (const r of bySrc) console.log(`${r.kind.padEnd(6)} src=${(r.source || "-").padEnd(14)} unit_cash=${r.unit_cash} 笔=${r.n} 发行=${r.q} 在库=${r.lv}`);
