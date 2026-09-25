#!/usr/bin/env node
// 雲端後台環境就緒檢查
// 用法：node cloud/scripts/preflight.js
//
// 檢查項目：
//   1. wrangler CLI 是否可用
//   2. wrangler 是否已登入
//   3. wrangler.toml 的 KV id 是否已填（R2 為選填）
//   4. KV / R2 綁定名稱是否與程式碼一致
//   5. 必要的 secrets 是否已設定（透過 wrangler secret list）
//
// 注意：R2 需要綁定信用卡才能開通，但本專案「不需要 R2」也能完整運作
//       （圖片自動改存 KV）。因此 R2 未設定不算失敗。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WORKER_DIR = join(ROOT, 'cloud', 'worker');
const TOML = join(WORKER_DIR, 'wrangler.toml');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);

let failures = 0;

function run(cmd, args, opts = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, {
        cwd: WORKER_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        ...opts,
      }),
    };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
  }
}

console.log('\n雲端後台環境就緒檢查\n' + '─'.repeat(52));

// ── 1. wrangler CLI ────────────────────────────────────────────
console.log('\n① wrangler CLI');
const ver = run('npx', ['wrangler', '--version'], { shell: true });
if (ver.ok) {
  const v = (ver.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || '?';
  ok(`wrangler ${v}`);
} else {
  bad('找不到 wrangler — 在 cloud/worker 執行：npm install -D wrangler');
  failures++;
}

// ── 2. 登入狀態 ────────────────────────────────────────────────
console.log('\n② Cloudflare 登入狀態');
const who = run('npx', ['wrangler', 'whoami'], { shell: true });
if (who.out.includes('Not logged in') || who.out.includes('auth token has expired')) {
  bad('尚未登入（或 token 已過期）');
  info('請在互動式終端執行：  cd cloud/worker && npx wrangler login');
  failures++;
} else if (who.ok) {
  const acct = (who.out.match(/([^\s]+@[^\s]+)/) || [])[1];
  ok(acct ? `已登入：${acct}` : '已登入');
  const ids = who.out.match(/\b[0-9a-f]{32}\b/g) || [];
  if (ids.length) info(`帳號 ID：${ids[0]}`);
} else {
  warn('無法確認登入狀態');
}

// ── 3. wrangler.toml ──────────────────────────────────────────
console.log('\n③ wrangler.toml 設定');
if (!existsSync(TOML)) {
  bad('找不到 wrangler.toml');
  failures++;
} else {
  const t = readFileSync(TOML, 'utf8');

  const kvBinding = (t.match(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"([^"]+)"/) || [])[1];
  const kvId = (t.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/) || [])[1];

  if (!kvId || kvId.includes('REPLACE_WITH')) {
    bad('KV namespace id 尚未填入');
    info('先執行：  npx wrangler kv namespace create SAGE_ECARD_DATA');
    failures++;
  } else {
    ok(`KV id 已填：${kvId}`);
    if (!/^[0-9a-f]{32}$/.test(kvId)) warn('id 格式看起來不像 32 位十六進位，請確認');
  }

  if (kvBinding === 'DATA') ok('KV binding = DATA（與程式碼 env.DATA 一致）');
  else {
    bad(`KV binding = "${kvBinding}"，但程式碼讀取 env.DATA`);
    info('請把 binding 改成 "DATA"，或同步修改 cloud/worker/src/storage.js');
    failures++;
  }

  const r2 = (t.match(/\[\[r2_buckets\]\][\s\S]*?binding\s*=\s*"([^"]+)"/) || [])[1];
  const r2Bucket = (t.match(/\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/) || [])[1];
  const hasR2 = !!t.match(/^\s*\[\[r2_buckets\]\]/m);
  if (hasR2) {
    if (r2 === 'IMAGES' && r2Bucket) ok(`R2 已綁定：${r2Bucket}（圖片存 R2）`);
    else warn('R2 區塊存在但設定不完整');
  } else {
    ok('未綁 R2 → 圖片將存 KV（不需綁卡，功能完整）');
  }

  const org = (t.match(/ORG_CODE\s*=\s*"([^"]*)"/) || [])[1];
  if (org) ok(`ORG_CODE = ${org}`);
}

// ── 4. 程式碼綁定一致性（靜態檢查）────────────────────────────
console.log('\n④ 程式碼綁定一致性');
try {
  const storage = readFileSync(join(WORKER_DIR, 'src', 'storage.js'), 'utf8');
  const usesKV = /env\.DATA/.test(storage);
  const usesR2 = /env\.IMAGES/.test(storage);
  if (usesKV) ok('storage.js 讀取 env.DATA');
  else { bad('storage.js 未讀取 env.DATA'); failures++; }
  if (usesR2) ok('storage.js 讀取 env.IMAGES');
  else warn('storage.js 未讀取 env.IMAGES');
} catch {
  bad('無法讀取 src/storage.js');
  failures++;
}

// ── 5. Secrets ────────────────────────────────────────────────
console.log('\n⑤ Secrets（僅在已登入時檢查）');
if (who.ok && !who.out.includes('Not logged in')) {
  const list = run('npx', ['wrangler', 'secret', 'list'], { shell: true });
  if (list.ok) {
    const need = ['ADMIN_PASSWORD_HASH', 'TOKEN_SECRET'];
    let anyMissing = false;
    for (const s of need) {
      if (new RegExp(`\\b${s}\\b`).test(list.out)) ok(`${s} 已設定`);
      else { bad(`${s} 未設定`); anyMissing = true; failures++; }
    }
    if (anyMissing) {
      info('設定方式：  npx wrangler secret put ADMIN_PASSWORD_HASH');
      info('            npx wrangler secret put TOKEN_SECRET');
    }
    if (/PAGES_DEPLOY_HOOK/.test(list.out)) ok('PAGES_DEPLOY_HOOK 已設定（可自動重建前台）');
    else info('PAGES_DEPLOY_HOOK 未設定 — 第二階段才需要，可先跳過');
  } else {
    warn('無法讀取 secret 清單（可能尚未部署過 Worker，屬正常）');
  }
} else {
  info('未登入，略過此項');
}

// ── 總結 ──────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(52));
if (failures === 0) {
  console.log('\x1b[32m環境就緒，可以部署了：\x1b[0m');
  console.log('  cd cloud/worker && npx wrangler deploy\n');
} else {
  console.log(`\x1b[33m還有 ${failures} 項待處理\x1b[0m — 請依上方紅色提示修正。\n`);
  console.log('完整步驟見 docs/CLOUD-DEPLOY.md\n');
}
process.exit(failures === 0 ? 0 : 1);
