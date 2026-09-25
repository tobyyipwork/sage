#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — API Token 診斷工具
 *
 * 當你不想用 `wrangler login`，改用 API Token 時，這支工具會：
 *   1. 檢查環境變數中的 token 是否存在
 *   2. 驗證 token 對 Cloudflare API 是否有效
 *   3. 檢查權限是否足夠跑完本專案的部署流程
 *   4. 檢查能否存取你已建立的 KV namespace
 *
 * 用法：
 *   # Windows PowerShell
 *   $env:CLOUDFLARE_API_TOKEN = "你的token"
 *   node cloud/scripts/check-token.js
 *
 *   # Git Bash / macOS / Linux
 *   export CLOUDFLARE_API_TOKEN="你的token"
 *   node cloud/scripts/check-token.js
 *
 * 安全提醒：本工具只讀取環境變數，不會寫入或記錄 token 值。
 */

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '30554c7a2f2b71ad4345037a358ebf3b';
const KV_NAMESPACE_ID = '78100d9be89b4bccbde4b3cbbdd7a777';

const c = {
  ok: (m) => `  \x1b[32m✓\x1b[0m ${m}`,
  bad: (m) => `  \x1b[31m✗\x1b[0m ${m}`,
  warn: (m) => `  \x1b[33m!\x1b[0m ${m}`,
  dim: (m) => `    \x1b[2m${m}\x1b[0m`,
  bold: (m) => `\x1b[1m${m}\x1b[0m`,
};

let problems = 0;

const argsHas = (f) => process.argv.slice(2).includes(f);

const API = 'https://api.cloudflare.com/client/v4';

const cf = async (path) => {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 忽略 */
  }
  return { status: res.status, body };
};

console.log('');
console.log(c.bold('  SAGE E-Card — API Token 診斷'));
console.log('  ' + '─'.repeat(54));
console.log('');

/* ---------- ① Token 是否存在 ---------- */
console.log(c.bold('  ① Token 環境變數'));
if (!TOKEN) {
  console.log(c.bad('找不到 CLOUDFLARE_API_TOKEN'));
  console.log('');
  console.log('  請先設定環境變數（兩種方式選一）：');
  console.log('');
  console.log(c.bold('  Windows PowerShell：'));
  console.log(c.dim('    $env:CLOUDFLARE_API_TOKEN = "你的token"'));
  console.log(c.dim('    node cloud/scripts/check-token.js'));
  console.log('');
  console.log(c.bold('  Git Bash：'));
  console.log(c.dim('    export CLOUDFLARE_API_TOKEN="你的token"'));
  console.log(c.dim('    node cloud/scripts/check-token.js'));
  console.log('');
  console.log(c.warn('  token 值在 Cloudflare 建立時只顯示一次，若已關閉視窗需重新建立'));
  console.log('');
  process.exit(1);
}

const masked = TOKEN.slice(0, 6) + '…' + TOKEN.slice(-4);
console.log(c.ok(`已讀取到 token：${masked}`));
console.log(c.dim(`長度 ${TOKEN.length} 字元（Cloudflare token 通常為 40 字元）`));

if (TOKEN.length < 30) {
  console.log(c.bad('長度太短，可能只貼到一部分'));
  problems++;
} else if (TOKEN.length > 60) {
  console.log(c.warn('長度偏長，可能多貼了空白或換行'));
}

/* ---------- ② Token 有效性 ---------- */
console.log('');
console.log(c.bold('  ② Token 有效性'));

const verify = await cf('/user/tokens/verify');
if (verify.status === 200 && verify.body?.success) {
  console.log(c.ok('Token 有效'));
  const st = verify.body.result?.status;
  const exp = verify.body.result?.expires_on;
  if (st) console.log(c.dim(`狀態：${st}`));
  if (exp) console.log(c.dim(`到期：${new Date(exp).toLocaleString('zh-HK')}`));
} else {
  const errs = verify.body?.errors?.map((e) => e.message).join('; ') || `HTTP ${verify.status}`;
  console.log(c.bad(`Token 無效：${errs}`));
  problems++;
}
console.log(c.dim('（/user/tokens/verify 是唯一不需要額外權限的端點）'));

/* ---------- ③ 帳號存取 ---------- */
console.log('');
console.log(c.bold('  ③ 帳號存取'));
const acct = await cf(`/accounts/${ACCOUNT_ID}`);
if (acct.status === 200 && acct.body?.success) {
  console.log(c.ok(`可存取帳號：${acct.body.result?.name || ACCOUNT_ID}`));
  console.log(c.dim(`帳號 ID：${ACCOUNT_ID}`));
} else {
  const code = acct.body?.errors?.[0]?.code;
  const msg = acct.body?.errors?.[0]?.message || `HTTP ${acct.status}`;
  console.log(c.bad(`無法存取帳號：${msg}`));
  if (code === 9109 || /invalid.*token/i.test(msg)) {
    console.log(c.dim('→ token 無效或已撤銷'));
  } else if (acct.status === 403) {
    console.log(c.dim('→ token 有效但缺少此帳號的權限'));
  }
  problems++;
}

/* ---------- ④ 權限清單 ---------- */
console.log('');
console.log(c.bold('  ④ Token 權限檢查'));

const tok = await cf('/user/tokens/verify');
const tokenId = tok.body?.result?.id;

if (tokenId) {
  const detail = await cf(`/user/tokens/${tokenId}`);
  if (detail.status === 200 && detail.body?.success) {
    const policies = detail.body.result?.policies || [];
    const perms = new Set();
    for (const p of policies) {
      for (const g of p.permission_groups || []) perms.add(g.name);
    }
    if (perms.size) {
      console.log(c.dim('目前已具備：'));
      for (const name of [...perms].sort()) console.log(c.dim(`  · ${name}`));

      // 本專案部署實際需要的能力
      const NEEDED = [
        { key: 'Workers Scripts Write', why: '部署 Worker', alt: ['Workers Editor'] },
        { key: 'Workers KV Storage Write', why: '寫入 KV 資料', alt: [] },
        { key: 'Workers KV Storage Read', why: '讀取／備份 KV', alt: [] },
      ];
      console.log('');
      const missing = [];
      for (const n of NEEDED) {
        const has = [...perms].some((p) => p === n.key) || n.alt.some((a) => perms.has(a));
        if (has) console.log(c.ok(`${n.key}（${n.why}）`));
        else {
          console.log(c.bad(`缺 ${n.key} — ${n.why}`));
          missing.push(n.key);
        }
      }
      if (missing.length) problems += missing.length;
    }
  } else {
    console.log(c.dim('無法讀取權限明細（可能需要「User Token Read」權限）'));
    console.log(c.dim('這不影響部署，部署會直接嘗試並回報結果'));
  }
} else {
  console.log(c.dim('無法取得 token ID，略過權限明細檢查'));
}

/* ---------- ⑤ KV namespace 存取 ---------- */
console.log('');
console.log(c.bold('  ⑤ KV namespace 存取'));
const kv = await cf(`/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}`);
if (kv.status === 200 && kv.body?.success) {
  console.log(c.ok(`可存取 KV：${kv.body.result?.title || KV_NAMESPACE_ID}`));
} else {
  const msg = kv.body?.errors?.[0]?.message || `HTTP ${kv.status}`;
  console.log(c.bad(`無法存取 KV namespace：${msg}`));
  if (kv.status === 403) {
    console.log(c.dim('→ 這就是「只有 KV Write、沒有 KV Read」的症狀'));
    console.log(c.dim('  寫入可以成功，但讀取／列表／備份會失敗'));
  }
  problems++;
}

/* ---------- ⑥ 寫入測試（可選） ---------- */
if (argsHas('--write-test')) {
  console.log('');
  console.log(c.bold('  ⑥ 寫入測試'));
  const tkey = `__healthcheck__${Date.now()}`;
  const put = await fetch(`${API}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${tkey}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
    body: 'ok',
  });
  if (put.ok) {
    console.log(c.ok('寫入 KV 成功'));
    const del = await fetch(`${API}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${tkey}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    console.log(del.ok ? c.ok('刪除測試資料成功') : c.warn('測試資料刪除失敗，請手動清理'));
  } else {
    console.log(c.bad(`寫入失敗：HTTP ${put.status}`));
    problems++;
  }
}

/* ---------- 總結 ---------- */
console.log('');
console.log('  ' + '─'.repeat(54));
if (problems === 0) {
  console.log(c.bold('  Token 可用，可以設定環境變數後直接部署：'));
  console.log('');
  console.log(c.dim('    npm run cloud:preflight'));
  console.log(c.dim('    npm run cloud:deploy'));
} else {
  console.log(c.warn(`  發現 ${problems} 個問題 — 見上方紅色提示`));
  console.log('');
  console.log('  最省事的做法仍是改用登入（權限自動完整）：');
  console.log(c.bold('    cd cloud/worker && npx wrangler login'));
}
console.log('');
process.exit(problems === 0 ? 0 : 1);
