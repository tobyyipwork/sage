#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — 互動式部署嚮導
 *
 * 把部署流程串成單一指令，每一步都有檢查與提示，避免漏掉設定。
 *
 * 用法：
 *   node cloud/scripts/deploy.js            逐步執行（每一步會問你確認）
 *   node cloud/scripts/deploy.js --check    只檢查狀態，不做任何變更
 *   node cloud/scripts/deploy.js --yes      不詢問，直接跑完（自動化用）
 *
 * 會做的事：
 *   1. 檢查 wrangler 與登入狀態
 *   2. 檢查 wrangler.toml 設定
 *   3. 設定 secrets（從環境變數或 stdin 讀取）
 *   4. 部署 Worker
 *   5. 遷移本地資料到 KV
 *   6. 驗證線上 API
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WORKER_DIR = join(ROOT, 'cloud', 'worker');
const TOML = join(WORKER_DIR, 'wrangler.toml');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const AUTO_YES = args.includes('--yes');

const c = {
  ok: (m) => `\x1b[32m✓\x1b[0m ${m}`,
  bad: (m) => `\x1b[31m✗\x1b[0m ${m}`,
  warn: (m) => `\x1b[33m!\x1b[0m ${m}`,
  dim: (m) => `\x1b[2m${m}\x1b[0m`,
  bold: (m) => `\x1b[1m${m}\x1b[0m`,
};

let problems = 0;

/* ---------- 互動工具 ---------- */
const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) =>
  new Promise((res) => {
    if (AUTO_YES || CHECK_ONLY) return res('y');
    rl.question(q, (a) => res(a.trim().toLowerCase()));
  });

/* ---------- wrangler 執行 ---------- */
const WRANGLER = (() => {
  const local = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');
  if (existsSync(local) || existsSync(local + '.cmd')) return { cmd: local, prefix: [] };
  return { cmd: 'npx', prefix: ['wrangler'] };
})();

const SECRET_TMP = join(ROOT, 'cloud', '.tmp-secret.txt');

const wrangler = (cmdArgs, { quiet = false, allowFail = false } = {}) => {
  const full = [...WRANGLER.prefix, ...cmdArgs];
  const shown = `npx wrangler ${cmdArgs.join(' ')}`;
  if (!quiet) console.log(c.dim(`    $ ${shown}`));

  // 注意：Windows 上從 Node 內 spawn node 會 EBUSY（環境限制），
  // 因此一律用 execFileSync，並以 shell 解析 npx。
  try {
    const out = execFileSync(WRANGLER.cmd, full, {
      cwd: WORKER_DIR,
      encoding: 'utf8',
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    const out = String((e.stdout || '') + (e.stderr || ''));
    if (!allowFail) {
      console.log(c.bad(`執行失敗：${shown}`));
      console.log(c.dim(out.split('\n').slice(0, 12).join('\n')));
      problems++;
    }
    return { ok: false, out };
  }
};

/** 設定 secret：wrangler secret put 從 stdin 讀值，改用管線餵入 */
const putSecret = (name, value) => {
  console.log(c.dim(`    $ echo <hidden> | npx wrangler secret put ${name}`));
  writeFileSync(SECRET_TMP, String(value), 'utf8');
  try {
    const cmd = WRANGLER.prefix.length
      ? `type "${SECRET_TMP}" | npx wrangler secret put ${name}`
      : `type "${SECRET_TMP}" | "${WRANGLER.cmd}" secret put ${name}`;
    const out = execSync(cmd, {
      cwd: WORKER_DIR,
      encoding: 'utf8',
      shell: 'cmd.exe',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: out || '' };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '')) };
  } finally {
    try {
      unlinkSync(SECRET_TMP);
    } catch {
      /* 忽略 */
    }
  }
};

/* ---------- 開始 ---------- */
console.log('');
console.log(c.bold('  SAGE E-Card — 雲端後台部署嚮導'));
console.log('  ' + '─'.repeat(50));
if (CHECK_ONLY) console.log(c.dim('  （--check 模式：只檢查，不做變更）'));
console.log('');

/* ===== 步驟 1：wrangler 與登入 ===== */
console.log(c.bold('  步驟 1／6　檢查 wrangler 與登入狀態'));

// 直接從專案或全域安裝目錄找 wrangler，避免 spawn 的環境問題
const wranglerVersion = (() => {
  try {
    const pkg = join(WORKER_DIR, 'node_modules', 'wrangler', 'package.json');
    if (existsSync(pkg)) return JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch {
    /* 忽略 */
  }
  try {
    return execSync('npx wrangler --version', {
      cwd: WORKER_DIR,
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .match(/(\d+\.\d+\.\d+)/)?.[1];
  } catch {
    return null;
  }
})();

if (wranglerVersion) console.log(c.ok(`wrangler ${wranglerVersion}`));
else {
  console.log(c.bad('找不到 wrangler — 請在 cloud/worker 執行 npm install -D wrangler'));
  problems++;
}

const who = wrangler(['whoami'], { quiet: true, allowFail: true });
// 只有出現明確的「未登入」訊息才算未登入；其他情況（含網路錯誤）保守視為已登入
const notLoggedIn = /Not logged in|auth token has expired|could not be refreshed/i.test(who.out);
const loggedIn = !notLoggedIn && /(You are logged in|Account Name|account_id|associated with the email)/i.test(who.out);

if (loggedIn) {
  const acct = (who.out.match(/([^\s]+@[^\s]+)/) || [])[1] || '';
  const ids = who.out.match(/\b[0-9a-f]{32}\b/g) || [];
  console.log(c.ok(`已登入${acct ? '：' + acct : ''}`));
  if (ids.length) console.log(c.dim(`    帳號 ID：${ids[0]}`));
  if (ids.length && !who.out.includes('30554c7a2f2b71ad4345037a358ebf3b')) {
    console.log(c.warn('登入的帳號與先前 KV namespace 所屬帳號可能不同'));
    console.log(c.dim('    KV namespace 是綁定在特定帳號下的，帳號不符會找不到該 namespace'));
  }
} else {
  console.log(c.bad('尚未登入'));
  console.log('');
  console.log('  請在你自己的終端機執行以下指令（會開啟瀏覽器要你授權）：');
  console.log(c.bold('    cd cloud/worker && npx wrangler login'));
  console.log('');
  console.log('  登入完成後再重跑本嚮導。');
  console.log('');
  rl.close();
  process.exit(1);
}

/* ===== 步驟 2：設定檢查 ===== */
console.log('');
console.log(c.bold('  步驟 2／6　檢查 wrangler.toml'));

const toml = readFileSync(TOML, 'utf8');
const active = toml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const kvId = (active.match(/\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/) || [])[1];
const kvBinding = (active.match(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"([^"]+)"/) || [])[1];
const hasR2 = /^\s*\[\[r2_buckets\]\]/m.test(active);

if (kvId && !kvId.includes('REPLACE')) console.log(c.ok(`KV id：${kvId}`));
else { console.log(c.bad('KV id 未填')); problems++; }

if (kvBinding === 'DATA') console.log(c.ok('KV binding：DATA'));
else { console.log(c.bad(`KV binding 應為 DATA，目前是 ${kvBinding}`)); problems++; }

console.log(hasR2 ? c.ok('R2 已綁定（圖片存 R2）') : c.ok('未綁 R2 → 圖片存 KV（不需綁卡）'));

/* ===== 步驟 3：Secrets ===== */
console.log('');
console.log(c.bold('  步驟 3／6　設定 secrets'));

const secretList = wrangler(['secret', 'list'], { quiet: true, allowFail: true });
const hasHash = /ADMIN_PASSWORD_HASH/.test(secretList.out);
const hasToken = /TOKEN_SECRET/.test(secretList.out);
const hasGhRepo = /GITHUB_REPO/.test(secretList.out);
const hasGhDispatch = /GITHUB_DISPATCH_TOKEN/.test(secretList.out);

if (hasHash) console.log(c.ok('ADMIN_PASSWORD_HASH 已設定'));
if (hasToken) console.log(c.ok('TOKEN_SECRET 已設定'));
if (hasGhRepo && hasGhDispatch) console.log(c.ok('後台一鍵重建（GITHUB_REPO + GITHUB_DISPATCH_TOKEN）已設定'));

if (!CHECK_ONLY && (!hasHash || !hasToken)) {
  console.log('');

  if (!hasHash) {
    console.log('  ' + c.bold('需要設定管理密碼。'));
    console.log(c.dim('  建議先用以下指令產生（會給你一組隨機密碼）：'));
    console.log(c.dim('    node cloud/scripts/make-password.js --random'));
    console.log('');
    const ans = await ask('  已經有雜湊值了嗎？貼上雜湊（或直接 Enter 跳過）：');
    if (ans && ans !== 'y' && /^[0-9a-f]{64}$/i.test(ans)) {
      const r = putSecret('ADMIN_PASSWORD_HASH', ans);
      if (r.ok) console.log(c.ok('ADMIN_PASSWORD_HASH 已設定'));
      else { console.log(c.bad('設定失敗')); console.log(c.dim(r.out.slice(0, 300))); problems++; }
    } else if (ans && ans !== 'y') {
      console.log(c.warn('看起來不是 SHA-256 雜湊（應為 64 位十六進位），已跳過'));
      console.log(c.dim('    請用 make-password.js 產生，不要自己編'));
      problems++;
    } else {
      console.log(c.warn('跳過 — 部署後將無法登入，可稍後用 wrangler secret put 補上'));
      problems++;
    }
  }

  if (!hasToken) {
    const crypto = await import('node:crypto');
    const generated = crypto.randomBytes(32).toString('hex');
    const ans = await ask('  TOKEN_SECRET（直接 Enter 使用自動產生的隨機值）：');
    const value = ans && ans !== 'y' ? ans : generated;
    const r = putSecret('TOKEN_SECRET', value);
    if (r.ok) {
      console.log(c.ok('TOKEN_SECRET 已設定'));
      if (!ans || ans === 'y') console.log(c.dim('    已自動產生 32 bytes 隨機密鑰'));
    } else {
      console.log(c.bad('設定失敗'));
      console.log(c.dim(r.out.slice(0, 300)));
      problems++;
    }
  }

  /* ── 後台一鍵重建（選填，但強烈建議） ──
     沒有這兩個，後台改完資料不會自動／手動觸發前台更新，
     只能等排程（而本 repo 的排程目前從未成功觸發過）。 */
  if (!hasGhRepo || !hasGhDispatch) {
    console.log('');
    console.log('  ' + c.bold('後台一鍵重建（選填，建議設定）'));
    console.log(c.dim('  設定後，後台就能直接觸發前台重建，不必等排程。'));
    console.log(c.dim('  需要一個 fine-grained token：'));
    console.log(c.dim('    https://github.com/settings/personal-access-tokens/new'));
    console.log(c.dim('    → Repository access 只勾 sage'));
    console.log(c.dim('    → Permissions: Actions = Read and write（其他都不用給）'));
    console.log('');

    const wantGh = await ask('  現在設定嗎？（y／Enter 跳過）：');

    if (wantGh !== 'y') {
      console.log(c.warn('跳過 — 後台將無法觸發重建，只能等排程'));
      console.log(c.dim('    可稍後補上：npm run cloud:setup 會再問一次'));
    } else {
      if (!hasGhRepo) {
        const repoAns = await ask('  GITHUB_REPO（格式 擁有者/倉庫，例如 tobyyipwork/sage）：');
        if (repoAns && repoAns !== 'y' && /^[^/\s]+\/[^/\s]+$/.test(repoAns)) {
          const r = putSecret('GITHUB_REPO', repoAns);
          if (r.ok) console.log(c.ok(`GITHUB_REPO 已設定（${repoAns}）`));
          else { console.log(c.bad('GITHUB_REPO 設定失敗')); console.log(c.dim(r.out.slice(0, 300))); problems++; }
        } else if (repoAns && repoAns !== 'y') {
          console.log(c.warn('格式錯誤，應為「擁有者/倉庫」，已跳過'));
          problems++;
        }
      } else {
        console.log(c.ok('GITHUB_REPO 已設定'));
      }

      if (!hasGhDispatch) {
        console.log(c.dim('    接著會請你貼上 token（輸入時畫面不會顯示，這是正常的）'));
        const tokAns = await ask('  GITHUB_DISPATCH_TOKEN（貼上 github_pat_... 後按 Enter）：');
        if (tokAns && tokAns !== 'y' && /^github_pat_/.test(tokAns)) {
          const r = putSecret('GITHUB_DISPATCH_TOKEN', tokAns);
          if (r.ok) console.log(c.ok('GITHUB_DISPATCH_TOKEN 已設定'));
          else { console.log(c.bad('GITHUB_DISPATCH_TOKEN 設定失敗')); console.log(c.dim(r.out.slice(0, 300))); problems++; }
        } else if (tokAns && tokAns !== 'y') {
          console.log(c.warn('看起來不是 fine-grained token（應以 github_pat_ 開頭），已跳過'));
          console.log(c.dim('    注意：舊式 ghp_ 開頭的 token 不支援 workflow_dispatch'));
          problems++;
        } else {
          console.log(c.warn('未輸入 token，已跳過'));
        }
      } else {
        console.log(c.ok('GITHUB_DISPATCH_TOKEN 已設定'));
      }
    }
  }
}

/* ===== 步驟 4：部署 ===== */
console.log('');
console.log(c.bold('  步驟 4／6　部署 Worker'));

if (!CHECK_ONLY) {
  const r = wrangler(['deploy']);
  if (r.ok) {
    const url = (r.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0];
    if (url) {
      console.log(c.ok(`部署成功：${url}`));
      console.log(c.dim(`    後台網址：https://tobyyipwork.github.io/sage/ecard/admin/public/?api=${url}`));
    } else {
      console.log(c.ok('部署成功'));
    }
  }
}

/* ===== 步驟 5：遷移資料 ===== */
console.log('');
console.log(c.bold('  步驟 5／6　遷移本地資料到 KV'));

if (!CHECK_ONLY) {
  const mode = hasR2 ? 'R2' : 'KV';
  console.log(c.dim(`    圖片將以 ${mode} 模式匯入`));
  const ans = await ask('  現在執行資料遷移？(y/n)：');
  if (ans === 'y' || ans === '') {
    runMigrate();
  } else {
    console.log(c.dim('    已跳過 — 稍後可執行：node cloud/seed/migrate-local.js'));
  }
}

function runMigrate() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'cloud', 'seed', 'migrate-local.js')], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
      stdio: 'inherit',
    });
    console.log(c.ok('資料遷移完成'));
  } catch {
    console.log(c.bad('資料遷移未完成'));
    problems++;
  }
}

/* ===== 步驟 6：驗證 ===== */
console.log('');
console.log(c.bold('  步驟 6／6　驗證線上 API'));

const listOut = wrangler(['deployments', 'list', '--json'], { quiet: true, allowFail: true });
let workerUrl = null;
try {
  const arr = JSON.parse(listOut.out.slice(listOut.out.search(/[[{]/)));
  const first = Array.isArray(arr) ? arr[0] : arr;
  workerUrl = (JSON.stringify(first).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0];
} catch {
  /* 忽略 */
}

if (!workerUrl) {
  const hookOut = wrangler(['deployments', 'list'], { quiet: true, allowFail: true });
  workerUrl = (hookOut.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0] || null;
}

if (workerUrl) {
  try {
    const res = await fetch(`${workerUrl}/api/health`);
    const body = await res.json();
    console.log(c.ok(`GET /api/health → HTTP ${res.status}`));
    console.log(c.dim(`    機構：${body.org}　圖片模式：${body.image_mode}`));
    if (body.image_mode === 'kv') console.log(c.ok('確認走 KV 圖片模式（未使用 R2）'));
  } catch (e) {
    console.log(c.warn(`無法連線驗證：${e.message}`));
  }
} else {
  console.log(c.dim('    無法自動取得 Worker 網址，請手動驗證：'));
  console.log(c.dim('    curl https://<你的-worker>.workers.dev/api/health'));
}

/* ===== 總結 ===== */
console.log('');
console.log('  ' + '─'.repeat(50));
if (CHECK_ONLY) {
  console.log(problems === 0 ? c.ok('檢查完成，未發現問題') : c.warn(`檢查完成，發現 ${problems} 個待處理項目`));
} else if (problems === 0) {
  console.log(c.bold('  部署完成！'));
  console.log('');
  console.log('  開啟後台（把網址加到書籤）：');
  console.log(c.dim('    https://tobyyipwork.github.io/sage/ecard/admin/public/?api=<你的 Worker 網址>'));
} else {
  console.log(c.warn(`  完成，但有 ${problems} 個項目需要注意（見上方紅色提示）`));
}
console.log('');

rl.close();
