#!/usr/bin/env node
/**
 * 產生管理密碼的 SHA-256 雜湊，用來設定 Worker 的 ADMIN_PASSWORD_HASH 機密。
 *
 * 用法：
 *   node cloud/scripts/make-password.js "你的密碼"
 *
 * 然後把輸出貼到：
 *   wrangler secret put ADMIN_PASSWORD_HASH
 *
 * 或亂數產生一組強密碼：
 *   node cloud/scripts/make-password.js --random
 */

import { createHash, randomBytes } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const args = process.argv.slice(2);

if (args[0] === '--random' || args[0] === '-r') {
  // 產生好記的強密碼：4 組 4 字元
  const words = randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 16);
  const pretty = words.match(/.{1,4}/g).join('-');
  console.log('');
  console.log('  隨機產生的密碼（請妥善保存，這個只顯示一次）：');
  console.log('');
  console.log(`     ${pretty}`);
  console.log('');
  console.log('  雜湊（貼到 wrangler secret put ADMIN_PASSWORD_HASH）：');
  console.log('');
  console.log(`     ${sha256(pretty)}`);
  console.log('');
  console.log('  設定指令：');
  console.log(`     wrangler secret put ADMIN_PASSWORD_HASH`);
  console.log(`     → 貼上上面的雜湊值`);
  console.log('');
} else {
  const password = args[0];
  if (!password) {
    console.error('');
    console.error('  用法： node cloud/scripts/make-password.js "你的密碼"');
    console.error('         node cloud/scripts/make-password.js --random     （產生隨機密碼）');
    console.error('');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('');
    console.error('  ⚠️  密碼太短，建議至少 8 個字元。');
    console.error('');
  }
  console.log('');
  console.log('  雜湊值：');
  console.log('');
  console.log(`     ${sha256(password)}`);
  console.log('');
  console.log('  設定指令：');
  console.log(`     wrangler secret put ADMIN_PASSWORD_HASH`);
  console.log(`     → 貼上上面的雜湊值`);
  console.log('');
}
