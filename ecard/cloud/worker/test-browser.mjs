/**
 * 在本機起一個真的 HTTP 伺服器，把 Worker 掛上去（用 mock KV/R2），
 * 再用真實瀏覽器載入後台，驗證登入 → CRUD → 圖片 → 刪除整條流程。
 *
 * 執行： node cloud/worker/test-browser.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
import worker from './src/index.js';
import { hashPassword } from './src/auth.js';

const PASSWORD = 'sage-demo-2026';
const PORT = 4188;

/* ---- mock bindings ---- */
const makeKV = () => {
  const store = new Map();
  return {
    store,
    async get(k, t) {
      const v = store.get(k);
      if (v === undefined) return null;
      return t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(name => ({ name })), list_complete: true };
    },
  };
};
const makeR2 = () => {
  const store = new Map();
  return {
    store,
    async get(k) { const v = store.get(k); return v ? { body: v.bytes, httpMetadata: { contentType: v.ct } } : null; },
    async put(k, bytes, o) { store.set(k, { bytes, ct: o?.httpMetadata?.contentType }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).slice(0, limit).map(key => ({ key })), truncated: false };
    },
  };
};

const env = {
  DATA: makeKV(), IMAGES: makeR2(),
  ORG_CODE: 'sage', TOKEN_SECRET: 'browser-test-secret',
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  TOKEN_TTL_HOURS: '168', ROOT_ORIGIN: '*',
};

/* 預先放好 config，模擬已遷移的狀態 */
await env.DATA.put('config:sage', JSON.stringify({
  org_code: 'sage',
  org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
  site: { url: 'https://tobyyipwork.github.io', basePath: '/sage/ecard/dist', version: '1.2.0' },
  langs: ['zh', 'cn', 'en'], default_lang: 'zh',
  qr: { enabled: true, mode: 'static' },
}));

/* ---- HTTP 伺服器：把請求轉給 Worker，並供應後台 HTML ---- */
const ADMIN_HTML = readFileSync(resolve(HERE, '../../admin/public/index.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/' || path.startsWith('/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(ADMIN_HTML);
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const wreq = new Request('http://localhost' + req.url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
  const wres = await worker.fetch(wreq, env);
  const headers = {};
  wres.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(wres.status, headers);
  const buf = wres.body ? Buffer.from(await wres.arrayBuffer()) : null;
  res.end(buf);
});

await new Promise(r => server.listen(PORT, r));
console.log(`\n  Mock Worker 已啟動於 http://localhost:${PORT}\n`);

/* ---- 瀏覽器測試 ---- */
const pw = await import('file:///C:/Users/Toby/AppData/Roaming/npm/node_modules/playwright/index.js');
const chromium = pw.chromium || pw.default?.chromium;
const EXE = 'C:/Users/Toby/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

const step = (name, ok, extra = '') => console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);

try {
  /* 1. 登入畫面 */
  await page.goto(`http://localhost:${PORT}/?api=http://localhost:${PORT}`);
  await page.waitForTimeout(800);
  step('顯示登入畫面', await page.locator('#loginWrap').isVisible());
  step('主畫面隱藏', !(await page.locator('#appWrap').isVisible()));

  /* 2. 錯誤密碼 */
  await page.fill('#loginPw', 'wrong-password');
  await page.click('#loginBtn');
  await page.waitForTimeout(600);
  const errText = await page.locator('#loginErr').innerText();
  step('錯誤密碼顯示提示', /密碼錯誤/.test(errText), errText);

  /* 3. 正確密碼 */
  await page.fill('#loginPw', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForTimeout(1200);
  step('登入後主畫面顯示', await page.locator('#appWrap').isVisible());
  step('登入畫面隱藏', !(await page.locator('#loginWrap').isVisible()));
  step('副標顯示「雲端」', (await page.locator('#subline').innerText()).includes('雲端'));

  /* 4. 新增名片 */
  await page.click('#addBtn');
  await page.waitForTimeout(400);
  await page.fill('#f_slug', 'chan-tai-man');
  await page.fill('#f_name_zh', '陳大文');
  await page.fill('#f_name_cn', '陈大文');
  await page.fill('#f_name_en', 'Chan Tai Man');
  await page.fill('#f_title_zh', '示範用戶');
  await page.fill('#f_email', 'taiman.chan@sage.org.hk');
  await page.click('#saveBtn');
  await page.waitForTimeout(1200);
  const cardCount = await page.locator('.ecard').count();
  step('新增後列表有 1 張名片', cardCount === 1, `got ${cardCount}`);
  const cardText = await page.locator('.ecard').first().innerText();
  step('名片顯示姓名', /陳大文/.test(cardText), cardText.replace(/\n/g, ' '));

  /* 5. 編輯名片 */
  await page.click('.ecard [data-edit]');
  await page.waitForTimeout(500);
  await page.fill('#f_title_zh', '高級經理');
  await page.click('#saveBtn');
  await page.waitForTimeout(1000);
  await page.click('.ecard [data-edit]');
  await page.waitForTimeout(500);
  const titleVal = await page.inputValue('#f_title_zh');
  step('編輯後職稱已更新', titleVal === '高級經理', titleVal);
  await page.click('#cancelBtn');
  await page.waitForTimeout(300);

  /* 6. 圖片上傳 */
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.click('.ecard [data-edit]');
  await page.waitForTimeout(500);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('.img-row[data-key="avatar"] .pick'),
  ]);
  await chooser.setFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await page.waitForTimeout(500);
  await page.click('#saveBtn');
  await page.waitForTimeout(1200);

  const avSrc = await page.locator('.ecard img').first().getAttribute('src');
  step('列表頭像改用 Worker /img 路徑', /\/img\/chan-tai-man\/avatar/.test(avSrc || ''), avSrc);

  const imgRes = await page.request.get(`http://localhost:${PORT}/img/chan-tai-man/avatar`);
  step('圖片確實可從 Worker 讀取', imgRes.status() === 200, `HTTP ${imgRes.status()}`);

  /* 7. 重新生成（未設 deploy hook）*/
  await page.click('#buildBtn');
  await page.waitForTimeout(1000);
  const buildOut = await page.locator('#buildOut').innerText();
  step('未設 deploy hook 時有清楚提示', /已儲存/.test(buildOut), buildOut.replace(/\n/g, ' '));

  /* 8. 登出 */
  await page.click('#logoutBtn');
  await page.waitForTimeout(600);
  step('登出後回到登入畫面', await page.locator('#loginWrap').isVisible());
  const tokenAfter = await page.evaluate(() => localStorage.getItem('ecard_token'));
  step('登出後 token 已清除', !tokenAfter);

  /* 9. 重新登入並刪除 */
  await page.fill('#loginPw', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForTimeout(1200);
  page.on('dialog', d => d.accept());
  await page.click('.ecard [data-del]');
  await page.waitForTimeout(1200);
  const afterDel = await page.locator('.ecard').count();
  step('刪除後列表為空', afterDel === 0, `got ${afterDel}`);

  /* 10. 截圖 */
  await page.screenshot({ path: 'cloud-admin-login.png' });
  await page.evaluate(() => localStorage.removeItem('ecard_token'));
  await page.reload();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'cloud-admin-login.png' });
  const loggedIn = await page.locator('#loginWrap').isVisible();
  if (!loggedIn) {
    await page.screenshot({ path: 'cloud-admin-app.png' });
  } else {
    await page.fill('#loginPw', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForTimeout(1000);
    await page.click('#addBtn');
    await page.waitForTimeout(300);
    await page.fill('#f_slug', 'lee-siu-wah');
    await page.fill('#f_name_zh', '李少華');
    await page.fill('#f_title_zh', '中心主任');
    await page.click('#saveBtn');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'cloud-admin-app.png' });
  }
} finally {
  const errs = logs.filter(l => l.startsWith('[pageerror]') || l.includes('error'));
  if (errs.length) console.log('\n  瀏覽器錯誤訊息:\n' + errs.map(e => '    ' + e).join('\n'));
  await browser.close();
  server.close();
  console.log('');
}
