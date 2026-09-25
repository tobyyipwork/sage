#!/usr/bin/env node
/**
 * 計算 Cloudflare KV 中名片資料的「指紋」（穩定雜湊）。
 *
 * 用途：自動重建流程的變更偵測。
 *   GitHub Actions 每 15 分鐘執行一次，先比對指紋；
 *   指紋相同就代表資料沒動過，直接結束，不重建、不 push。
 *   這樣可以避免產生大量無意義的 commit 與 Pages 建置。
 *
 * 只涵蓋「會影響前台輸出」的資料：config + index + 各張名片。
 * 圖片不列入 — 前台是直接引用 Worker 的 /img/ 路徑，不隨建置輸出改變。
 *
 * 用法：
 *   node cloud/scripts/kv-fingerprint.js           印出雜湊（64 字元 hex）
 *   node cloud/scripts/kv-fingerprint.js --verbose 同時印出涵蓋範圍
 *   node cloud/scripts/kv-fingerprint.js --write   寫入 .kv-fingerprint 檔案
 *   node cloud/scripts/kv-fingerprint.js --check   與 .kv-fingerprint 比對
 *                                                  （相同→exit 0，不同→exit 1）
 *
 * 環境變數：同 kv-to-data.js（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID）
 */

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TOML = join(ROOT, 'cloud', 'worker', 'wrangler.toml');
const FP_FILE = join(ROOT, '.kv-fingerprint');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const WRITE = args.includes('--write');
const CHECK = args.includes('--check');

const ORG = process.env.ORG_CODE || 'sage';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';

/* ---------- 從 wrangler.toml 讀 KV namespace id ---------- */
const namespaceIdFromToml = () => {
  if (process.env.CF_KV_NAMESPACE_ID) return process.env.CF_KV_NAMESPACE_ID;
  if (!existsSync(TOML)) return '';
  const lines = readFileSync(TOML, 'utf8').split(/\r?\n/);
  let inKvBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^\[\[kv_namespaces\]\]/.test(line)) { inKvBlock = true; continue; }
    if (/^\[/.test(line)) { inKvBlock = false; continue; }
    if (inKvBlock && /^id\s*=\s*"([^"]+)"/.test(line)) {
      return line.match(/^id\s*=\s*"([^"]+)"/)[1];
    }
  }
  return '';
};

/* ---------- KV 讀取（REST 優先，其次 wrangler） ---------- */
const makeKvGet = () => {
  if (TOKEN && ACCOUNT_ID) {
    const nsId = namespaceIdFromToml();
    if (!nsId) throw new Error('找不到 KV namespace id');
    return async (key) => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`
        + `/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (res.status === 404) return null;
      if (res.status === 403) {
        throw new Error('KV 讀取被拒（403）— token 缺 Workers KV Storage Read');
      }
      if (!res.ok) throw new Error(`KV 讀取失敗（HTTP ${res.status}）`);
      return res.json();
    };
  }

  // wrangler fallback
  const localBin = join(ROOT, 'cloud', 'worker', 'node_modules', '.bin', 'wrangler');
  const WR = (process.env.WRANGLER_BIN && existsSync(process.env.WRANGLER_BIN))
    ? { cmd: process.env.WRANGLER_BIN, prefix: [] }
    : (existsSync(localBin) || existsSync(localBin + '.cmd'))
      ? { cmd: localBin, prefix: [] }
      : { cmd: 'npx', prefix: ['--yes', 'wrangler@4'] };

  return async (key) => {
    const cmd = [...WR.prefix, 'kv', 'key', 'get', key, '--binding', 'DATA', '--text', '--remote'];
    try {
      const out = execFileSync(WR.cmd, cmd, {
        cwd: join(ROOT, 'cloud', 'worker'),
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 32 * 1024 * 1024,
      });
      const trimmed = out.trim();
      const start = trimmed.search(/[[{]/);
      if (start === -1) return null;
      return JSON.parse(trimmed.slice(start));
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (/not found|404|does not exist/i.test(msg)) return null;
      throw e;
    }
  };
};

/* ---------- 穩定序列化：物件鍵排序，避免鍵序不同造成假變更 ---------- */
const stable = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(stable);
  return Object.keys(v).sort().reduce((acc, k) => { acc[k] = stable(v[k]); return acc; }, {});
};

/* ---------- 主流程 ---------- */
const kvGet = makeKvGet();

const config = await kvGet(`config:${ORG}`);
if (!config) {
  console.error(`  ✗ KV 裡找不到 config:${ORG}`);
  process.exit(1);
}

const index = (await kvGet(`index:${ORG}`)) || [];
if (!Array.isArray(index)) {
  console.error(`  ✗ index:${ORG} 格式異常`);
  process.exit(1);
}

// 依 slug 排序，確保名單順序變動不算「資料變更」— 順序由 index 本身決定，
// 但我們仍把 index 原文納入雜湊，所以順序變了確實會反映（前台排序也會變）。
const staffRecords = [];
for (const entry of index) {
  const rec = await kvGet(`staff:${ORG}:${entry.slug}`);
  staffRecords.push({ slug: entry.slug, data: rec });
}

const payload = JSON.stringify(stable({
  version: 1,
  org: ORG,
  config,
  index,
  staff: staffRecords,
}));

const hash = createHash('sha256').update(payload, 'utf8').digest('hex');

if (VERBOSE) {
  console.log('');
  console.log(`  機構：${ORG}`);
  console.log(`  名片：${staffRecords.length} 張（${staffRecords.map(s => s.slug).join(', ') || '無'}）`);
  console.log(`  資料量：${payload.length} bytes`);
  console.log('');
}

if (CHECK) {
  if (!existsSync(FP_FILE)) {
    console.log('  無既有指紋檔 — 視為首次執行，需要重建。');
    process.exit(1);
  }
  const prev = readFileSync(FP_FILE, 'utf8').trim();
  if (prev === hash) {
    console.log(`  資料未變更（${hash.slice(0, 12)}…）`);
    process.exit(0);
  }
  console.log(`  資料已變更：${prev.slice(0, 12)}… → ${hash.slice(0, 12)}…`);
  process.exit(1);
}

if (WRITE) {
  writeFileSync(FP_FILE, hash + '\n', 'utf8');
  console.log(`  ✓ 已寫入指紋：${hash}`);
} else {
  console.log(hash);
}
