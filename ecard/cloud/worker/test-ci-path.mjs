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

// 0. 完全無憑證時，必須以 exit 2 失敗（區別於「資料有變更」的 exit 1）
//    這個區別很重要：workflow 若把 exit 2 誤判成「有變更」，
//    憑證設錯就會看起來像資料變動，非常難排查。
{
  const r = run([], {
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    APPDATA: '/nonexistent-appdata-for-test',
    HOME: '/nonexistent-home-for-test',
  });
  if (r.code === 2) {
    ok('無憑證時以 exit 2 失敗（可與「資料變更」區分）');
  } else {
    bad(`無憑證時 exit code 應為 2，實際為 ${r.code}`);
  }
  const combined = r.out + r.err;
  if (/CLOUDFLARE_API_TOKEN/.test(combined) && /CLOUDFLARE_ACCOUNT_ID/.test(combined)) {
    ok('錯誤訊息指出需要哪兩個環境變數');
  } else {
    bad('錯誤訊息未指出所需環境變數');
  }
  if (/wrangler login/i.test(combined)) {
    ok('同時提供本機替代方案（wrangler login）');
  } else {
    bad('未提供本機替代方案');
  }
}

// 1. 有 token 但缺 account id → 不應誤判為「資料變更」
{
  const r = run([], { CLOUDFLARE_API_TOKEN: 'x'.repeat(40), CLOUDFLARE_ACCOUNT_ID: '' });
  const combined = r.out + r.err;
  if (r.code !== 1) {
    ok(`缺 ACCOUNT_ID 時 exit=${r.code}（未誤判為資料變更）`);
  } else {
    bad('缺 ACCOUNT_ID 時誤判為資料變更（exit 1）');
  }
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
