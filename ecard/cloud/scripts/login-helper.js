#!/usr/bin/env node
/**
 * SAGE E-Card Cloud — 登入輔助
 *
 * 檢查登入前的環境狀態，並在需要時清掉過期憑證（避免登入卡住）。
 *
 * 用法：
 *   npm run cloud:login            檢查環境，必要時清掉過期憑證
 *   npm run cloud:login -- --clean  強制清除舊憑證後再登入
 *
 * 為什麼需要這個：
 *   若 ~/.wrangler/config/default.toml 留有過期的 OAuth 憑證，
 *   wrangler 會嘗試 refresh、失敗後才提示要你重新登入，
 *   有時會卡在「正忙」狀態。先清掉可讓登入乾淨進行。
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const FORCE_CLEAN = args.includes('--clean');

const c = {
  ok: (m) => `  \x1b[32m✓\x1b[0m ${m}`,
  bad: (m) => `  \x1b[31m✗\x1b[0m ${m}`,
  warn: (m) => `  \x1b[33m!\x1b[0m ${m}`,
  dim: (m) => `    \x1b[2m${m}\x1b[0m`,
  bold: (m) => `\x1b[1m${m}\x1b[0m`,
};

/** wrangler 設定檔可能的位置（隨平台與 XDG 設定而異） */
const configCandidates = () =>
  [
    process.env.WRANGLER_HOME ? join(process.env.WRANGLER_HOME, 'config', 'default.toml') : null,
    process.env.APPDATA ? join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml') : null,
    process.env.HOME ? join(process.env.HOME, '.wrangler', 'config', 'default.toml') : null,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.wrangler', 'config', 'default.toml') : null,
  ].filter(Boolean);

console.log('');
console.log(c.bold('  SAGE E-Card — Cloudflare 登入輔助'));
console.log('  ' + '─'.repeat(52));
console.log('');

/* ---------- ① 找設定檔 ---------- */
console.log(c.bold('  ① 檢查 wrangler 憑證檔'));

let found = null;
for (const p of configCandidates()) {
  if (existsSync(p)) {
    found = p;
    break;
  }
}

if (!found) {
  console.log(c.ok('沒有舊憑證檔 — 可以直接登入'));
} else {
  console.log(c.dim(`檔案位置：${found}`));

  const raw = readFileSync(found, 'utf8');
  const get = (k) => (raw.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\n]*)"?`, 'm')) || [])[1] || '';

  const token = get('oauth_token');
  const refresh = get('refresh_token');
  const expRaw = get('expiration_time');

  if (!token) {
    console.log(c.ok('憑證檔存在但沒有 oauth_token — 視同未登入'));
  } else {
    const hasRefresh = !!refresh;
    let expired = false;
    if (expRaw) {
      // expiration_time 可能是 ISO 字串或 epoch 秒
      let expMs = Date.parse(expRaw);
      if (Number.isNaN(expMs) && /^\d+$/.test(expRaw)) expMs = Number(expRaw) * 1000;
      if (!Number.isNaN(expMs)) {
        expired = expMs < Date.now();
        const when = new Date(expMs).toLocaleString('zh-HK');
        console.log(c.dim(`到期時間：${when}`));
      }
    }
    console.log(c.dim(`refresh_token：${hasRefresh ? '有' : '無'}`));

    if (expired) {
      console.log(c.warn('憑證已過期'));
      console.log(c.dim('→ 這就是 whoami 顯示「token has expired」的原因'));
    } else {
      console.log(c.ok('憑證尚未過期（但可能已被撤銷）'));
    }
  }

  /* ---------- ② 清除舊憑證 ---------- */
  if (FORCE_CLEAN || (token && !refresh)) {
    console.log('');
    console.log(c.bold('  ② 清除舊憑證'));
    try {
      const backup = found + '.bak';
      copyFileSync(found, backup);
      console.log(c.ok(`已備份至 ${backup}`));
      unlinkSync(found);
      console.log(c.ok('已刪除舊憑證檔 — 登入會是乾淨狀態'));
    } catch (e) {
      console.log(c.bad(`清除失敗：${e.message}`));
      console.log(c.dim('可手動刪除該檔案後再登入'));
    }
  }
}

/* ---------- ③ Proxy 檢查 ---------- */
console.log('');
console.log(c.bold('  ③ Proxy 環境變數'));

const proxyVars = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];
const activeProxies = proxyVars.filter((v) => process.env[v]);

if (activeProxies.length) {
  console.log(c.warn('偵測到 proxy 設定：'));
  for (const v of activeProxies) console.log(c.dim(`${v} = ${process.env[v]}`));
  console.log('');
  console.log(c.dim('wrangler 會透過此 proxy 連線。若登入卡住或失敗，可嘗試：'));
  console.log('');
  console.log(c.bold('  Git Bash：'));
  console.log(c.dim('    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY'));
  console.log(c.dim('    npx wrangler login'));
  console.log('');
  console.log(c.bold('  Windows PowerShell：'));
  console.log(c.dim('    $env:HTTP_PROXY=""; $env:HTTPS_PROXY=""'));
  console.log(c.dim('    npx wrangler login'));
} else {
  console.log(c.ok('沒有 proxy 設定'));
}

/* ---------- ④ Port 檢查 ---------- */
console.log('');
console.log(c.bold('  ④ 登入回呼埠（8976）'));
try {
  const out = execSync('netstat -ano', { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const busy = out.split('\n').some((l) => /[:.]8976\s/.test(l) && /LISTEN/i.test(l));
  if (busy) {
    console.log(c.warn('8976 已被佔用 — 登入可能失敗'));
    console.log(c.dim('可改用其他埠：npx wrangler login --callback-port 8977'));
  } else {
    console.log(c.ok('8976 可用'));
  }
} catch {
  console.log(c.dim('無法檢查（不影響登入）'));
}

/* ---------- 下一步 ---------- */
console.log('');
console.log('  ' + '─'.repeat(52));
console.log(c.bold('  接著請執行：'));
console.log('');
console.log(c.dim('    cd cloud/worker && npx wrangler login'));
console.log('');
console.log('  會開啟瀏覽器，選擇你的 Cloudflare 帳號並點「Allow」。');
console.log('  成功後回到這裡執行：');
console.log('');
console.log(c.dim('    npm run cloud:deploy        # 一路部署到完成'));
console.log('');
