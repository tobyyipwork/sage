/**
 * 共用的環境探索工具 — 供 kv-to-data.js 與 kv-fingerprint.js 使用。
 *
 * 這裡集中處理兩件容易出錯、且兩支腳本都需要的事：
 *   1. 找出 wrangler 的憑證檔位置（判斷本機是否已登入）
 *   2. 找出一個「真的能跑」的 wrangler（npx 快取可能殘缺）
 *
 * 為什麼需要「真的能跑」的判斷：
 *   npx 下載的 wrangler 若缺 @cloudflare/workerd-* 原生模組，
 *   執行時會噴一大串 Node 堆疊，非常難懂。
 *   先探測好壞再決定用哪個，可以讓失敗訊息變得可讀。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Node 的 platform/arch 與 workerd 套件命名不同（win32/x64 → windows-64） */
export const workerdPkgName = () => {
  const plat = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
    || process.platform;
  const arch = { x64: '64', arm64: 'arm64' }[process.arch] || process.arch;
  return `workerd-${plat}-${arch}`;
};

/**
 * wrangler 的憑證檔路徑。
 * 注意：Windows 上 npm 的設定目錄常被寫成 xdg 風格路徑，
 * 且實際位置在 %APPDATA%（Roaming）而非 %LOCALAPPDATA%，這裡兩種都試。
 */
export const wranglerCredPath = () => {
  const cands = [];
  if (process.env.APPDATA) {
    cands.push(join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml'));
    cands.push(join(process.env.APPDATA, '.wrangler', 'config', 'default.toml'));
  }
  if (process.env.HOME) {
    cands.push(join(process.env.HOME, '.config', '.wrangler', 'config', 'default.toml'));
  }
  if (process.env.XDG_CONFIG_HOME) {
    cands.push(join(process.env.XDG_CONFIG_HOME, '.wrangler', 'config', 'default.toml'));
  }
  return cands.find((p) => existsSync(p)) || cands[0] || '';
};

export const isWranglerLoggedIn = () => {
  const p = wranglerCredPath();
  return !!p && existsSync(p);
};

/**
 * npx 的快取目錄。
 * 重要：Windows 上 npm 的快取在 %LOCALAPPDATA%，不是 %APPDATA%。
 */
export const npxCacheDir = () => {
  if (process.env.npm_config_cache) return join(process.env.npm_config_cache, '_npx');
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
  }
  if (process.env.HOME) return join(process.env.HOME, '.npm', '_npx');
  return '';
};

/**
 * 列出候選的 wrangler 執行方式，順序即優先序。
 * 只把「已具備對應平台原生模組」的快取列為候選，避免選到壞的。
 */
export const findWorkingWrangler = (rootDir) => {
  const candidates = [];
  const pkg = workerdPkgName();

  if (process.env.WRANGLER_BIN && existsSync(process.env.WRANGLER_BIN)) {
    candidates.push({ cmd: process.env.WRANGLER_BIN, prefix: [], label: 'WRANGLER_BIN' });
  }

  const local = join(rootDir, 'cloud', 'worker', 'node_modules', '.bin', 'wrangler');
  if (existsSync(local) || existsSync(local + '.cmd')) {
    candidates.push({ cmd: local, prefix: [], label: '本地 node_modules' });
  }

  const npxDir = npxCacheDir();
  if (npxDir && existsSync(npxDir)) {
    let entries = [];
    try { entries = readdirSync(npxDir); } catch { /* 忽略權限等問題 */ }
    for (const e of entries) {
      const bin = join(npxDir, e, 'node_modules', '.bin', 'wrangler');
      const hasNative = existsSync(join(npxDir, e, 'node_modules', '@cloudflare', pkg));
      if (hasNative && (existsSync(bin) || existsSync(bin + '.cmd'))) {
        candidates.push({ cmd: bin, prefix: [], label: `npx 快取 ${e.slice(0, 8)}` });
      }
    }
  }

  // 最後手段：讓 npx 自行處理（可能重新下載，也可能失敗）
  candidates.push({ cmd: 'npx', prefix: ['--yes', 'wrangler@4'], label: 'npx（現場下載）' });
  return candidates;
};

/** 帶有可行動指引的環境錯誤 */
export class EnvError extends Error {
  constructor(lines) {
    super(lines.join('\n'));
    this.name = 'EnvError';
    this.lines = lines;
  }
}

/**
 * 檢查讀取遠端 KV 所需的前置條件。
 * 缺憑證 → 丟 EnvError（呼叫端應以 exit 2 結束，與「資料變更」區分）。
 */
export const assertRemoteKvReady = ({ token, accountId, local = false }) => {
  if (local) return 'wrangler-local';
  if (token && accountId) return 'rest';

  // 只給一半是最常見的設定錯誤，明確指出缺哪個
  if (token !== accountId) {
    throw new EnvError([
      `  ✗ 憑證設定不完整 — 缺少 ${token ? 'CLOUDFLARE_ACCOUNT_ID' : 'CLOUDFLARE_API_TOKEN'}。`,
      '',
      '    CLOUDFLARE_API_TOKEN 與 CLOUDFLARE_ACCOUNT_ID 必須成對設定。',
      '    只設定其中一個會導致讀取失敗。',
    ]);
  }

  if (isWranglerLoggedIn()) return 'wrangler';

  throw new EnvError([
    '  ✗ 找不到 Cloudflare 憑證，無法讀取遠端 KV。',
    '',
    '    二選一：',
    '      1. 設定環境變數（CI／GitHub Actions 用，token 需 Workers KV Storage Read）',
    '           CLOUDFLARE_API_TOKEN',
    '           CLOUDFLARE_ACCOUNT_ID',
    '      2. 在本機執行 npx wrangler login',
  ]);
};
