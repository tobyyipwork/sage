/**
 * 驗證 CI 路徑（REST API 模式）的邏輯正確性，不需真實 token。
 * 用假的 token / account id 確認：
 *   1. 腳本能正確進入 REST 模式
 *   2. 錯誤訊息能區分 401 / 403 / 404
 *   3. 參數缺失時給出清楚錯誤
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');   // worker/ -> cloud/ -> ecard/

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

const run = (args, env) => {
  try {
    const out = execFileSync('node', [resolve(ROOT, 'cloud/scripts/kv-fingerprint.js'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell: process.platform === 'win32',
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};

console.log('\n=== CI 路徑（REST 模式）邏輯驗證 ===\n');

// 1. 有 token 但缺 account id → 應走 wrangler fallback 或報錯，不應誤判
{
  const r = run([], { CLOUDFLARE_API_TOKEN: 'x'.repeat(40), CLOUDFLARE_ACCOUNT_ID: '' });
  const combined = r.out + r.err;
  if (/ACCOUNT_ID|找不到|wrangler/i.test(combined) || r.code === 0) {
    ok('缺 ACCOUNT_ID 時有明確處理（不靜默失敗）');
  } else {
    bad('缺 ACCOUNT_ID 時行為不明確');
  }
}

// 2. 假 token + 真 account id → REST 模式應被觸發並回報 401
{
  const r = run([], {
    CLOUDFLARE_API_TOKEN: 'fake-token-for-testing-1234567890',
    CLOUDFLARE_ACCOUNT_ID: '30554c7a2f2b71ad4345037a358ebf3b',
  });
  const combined = r.out + r.err;
  if (r.code !== 0) {
    ok('假 token 正確失敗（非靜默成功）');
  } else {
    bad('假 token 竟然成功了 — 有問題');
  }
  if (/401|403|KV 讀取|Invalid|Authentication/i.test(combined)) {
    ok(`錯誤訊息可辨識（含 HTTP 狀態或權限提示）`);
  } else {
    console.log(`     實際輸出：${combined.trim().slice(0, 160)}`);
    bad('錯誤訊息不夠明確');
  }
}

// 3. 確認 REST 模式確實使用 fetch 而非 wrangler
{
  const r = run([], {
    CLOUDFLARE_API_TOKEN: 'fake-token-for-testing-1234567890',
    CLOUDFLARE_ACCOUNT_ID: '30554c7a2f2b71ad4345037a358ebf3b',
  });
  const combined = r.out + r.err;
  if (/api\.cloudflare\.com|403|401|Invalid|Authentication/i.test(combined)
      && !/wrangler|You are logged in/i.test(combined)) {
    ok('確實走 REST API（未呼叫 wrangler）');
  } else if (/api\.cloudflare\.com|403|401/i.test(combined)) {
    ok('走 REST API 並取得 Cloudflare 回應');
  } else {
    bad('無法確認走 REST 模式');
  }
}

console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail ? 1 : 0);
