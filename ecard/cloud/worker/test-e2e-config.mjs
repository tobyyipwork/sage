/**
 * 端到端驗證：後台機構設定 → 寫入 KV → 觸發前台重建
 *
 * 起一個真的 HTTP 伺服器把 Worker 掛上去，用真實請求走完
 * 「登入 → 讀設定 → 改設定 → 驗證唯讀欄位未被覆寫 → 觸發重建」。
 *
 * GitHub API 與 KV 都用本機 stub，不發出真實網路請求。
 *
 * 執行： node cloud/worker/test-e2e-config.mjs
 */

import http from 'node:http';

const workerPromise = import('./src/index.js');
const authPromise = import('./src/auth.js');

const PASSWORD = 'sage-demo-2026';
const PORT = 4193;

let pass = 0;
let fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const check = (n, cond, d) => (cond ? ok(n) : bad(n, d));

/* ---------- mock KV ---------- */
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
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
};

/* ---------- GitHub API stub（只記錄，不真的呼叫） ---------- */
const ghRequests = [];
const startGhStub = () =>
  new Promise((res) => {
    const srv = http.createServer((req, rqRes) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ghRequests.push({ method: req.method, url: req.url });
        if (req.url.includes('/dispatches') && req.method === 'POST') return rqRes.writeHead(204).end();
        if (req.url.includes('/runs') && req.method === 'GET') {
          return rqRes.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ workflow_runs: [{ status: 'completed', conclusion: 'success', created_at: '2026-09-28T00:00:00Z', html_url: 'https://x', event: 'workflow_dispatch' }] })
          );
        }
        rqRes.writeHead(404).end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });

/* ---------- 種入初始 config ---------- */
const seedConfig = () => ({
  org_code: 'sage',
  org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
  org_site: 'https://www.sage.org.hk',
  about: { zh: '簡介', cn: '简介', en: 'About' },
  address: { zh: '香港北角', cn: '香港北角', en: 'North Point, Hong Kong' },
  site: { url: 'https://tobyyipwork.github.io', basePath: '/sage/ecard/dist', copyright: '© 2026 SAGE', version: '1.2.0' },
  qr: { enabled: true, mode: 'static', base: '', path: '/r/{org}/{slug}', accordion: 1, label: { zh: '掃碼開啟名片', cn: '扫码开启名片', en: 'Scan to open card' } },
  langs: ['zh', 'cn', 'en'],
  default_lang: 'zh',
});

/* ---------- 啟動 ---------- */
const worker = (await workerPromise).default;
const { hashPassword } = await authPromise;

const ghStub = await startGhStub();
const ghPort = ghStub.address().port;

const KV = makeKV();
await KV.put('config:sage', JSON.stringify(seedConfig()));
await KV.put('index:sage', JSON.stringify([]));

const env = {
  DATA: KV,
  ORG_CODE: 'sage',
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  TOKEN_SECRET: 'test-secret-for-e2e-config',
  TOKEN_TTL_HOURS: '1',
  ROOT_ORIGIN: '*',
  BUILD_THROTTLE_MINUTES: '0',
  GITHUB_REPO: 'tobyyipwork/sage',
  GITHUB_DISPATCH_TOKEN: 'github_pat_e2e_fake',
  _GH_BASE: `http://127.0.0.1:${ghPort}`,
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.includes('api.github.com')) return realFetch(s.replace('https://api.github.com', env._GH_BASE), opts);
  return realFetch(url, opts);
};

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: body.length ? body : undefined,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const api = async (method, path, { token, body } = {}) => {
  const r = await realFetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
};

/* ══════════════════ 測試開始 ══════════════════ */

console.log('\n=== ① 未登入不可讀寫設定 ===');
{
  const r = await api('GET', '/api/config');
  check('GET /api/config 未登入 → 401', r.status === 401, `實際 ${r.status}`);

  const w = await api('PUT', '/api/config', { body: { org: { zh: 'x', cn: 'x', en: 'x' } } });
  check('PUT /api/config 未登入 → 401', w.status === 401, `實際 ${w.status}`);
}

/* 登入 */
const login = await api('POST', '/api/login', { body: { password: PASSWORD } });
const token = login.json.token;
check('登入成功並取得通行證', login.status === 200 && !!token);

console.log('\n=== ② 讀取設定 ===');
{
  const r = await api('GET', '/api/config', { token });
  check('GET /api/config → 200', r.status === 200, `實際 ${r.status}`);
  check('回傳機構名稱', r.json.org?.zh === '香港耆康老人福利會');
  check('回傳 org_code', r.json.org_code === 'sage');
  check('回傳 basePath', r.json.site?.basePath === '/sage/ecard/dist');
}

console.log('\n=== ③ 更新可編輯欄位 ===');
{
  const before = ghRequests.length;
  const r = await api('PUT', '/api/config', {
    token,
    body: {
      org: { zh: '測試機構', cn: '测试机构', en: 'Test Organisation' },
      about: { zh: '新簡介', cn: '新简介', en: 'New about' },
      address: { zh: '新地址', cn: '新地址', en: 'New address' },
      org_site: 'https://test.example.org',
      site: { copyright: '© 2026 測試機構' },
      qr: { label: { zh: '掃我', cn: '扫我', en: 'Scan me' } },
    },
  });

  check('PUT /api/config → 200', r.status === 200, `實際 ${r.status}`);
  check('回應 ok=true', r.json.ok === true);
  check('org.zh 已更新', r.json.config?.org?.zh === '測試機構');
  check('about.zh 已更新', r.json.config?.about?.zh === '新簡介');
  check('address.en 已更新', r.json.config?.address?.en === 'New address');
  check('org_site 已更新', r.json.config?.org_site === 'https://test.example.org');
  check('site.copyright 已更新', r.json.config?.site?.copyright === '© 2026 測試機構');
  check('qr.label.zh 已更新', r.json.config?.qr?.label?.zh === '掃我');
  check('回應包含 rebuild 欄位', !!r.json.rebuild);
  check('已觸發重建', r.json.rebuild?.triggered === true);
  check('確實發出 GitHub 請求', ghRequests.length > before, `前 ${before} 後 ${ghRequests.length}`);
}

console.log('\n=== ④ 唯讀欄位不可被覆寫（關鍵安全檢查）===');
{
  const r = await api('PUT', '/api/config', {
    token,
    body: {
      org_code: 'HACKED',
      langs: ['xx'],
      default_lang: 'xx',
      site: { url: 'https://evil.example', basePath: '/evil', version: '9.9.9', copyright: '© 2026 測試機構' },
    },
  });

  check('請求本身成功（唯讀欄位被靜默忽略）', r.status === 200, `實際 ${r.status}`);
  check('org_code 未被竄改', r.json.config?.org_code === 'sage', `實際 ${r.json.config?.org_code}`);
  check('langs 未被竄改', JSON.stringify(r.json.config?.langs) === JSON.stringify(['zh', 'cn', 'en']));
  check('default_lang 未被竄改', r.json.config?.default_lang === 'zh');
  check('site.url 未被竄改', r.json.config?.site?.url === 'https://tobyyipwork.github.io');
  check('site.basePath 未被竄改', r.json.config?.site?.basePath === '/sage/ecard/dist');
  check('site.version 未被竄改', r.json.config?.site?.version === '1.2.0');

  // 再讀一次 KV，確認落地資料也正確（不只是回應同步過）
  const kvRaw = JSON.parse(await KV.get('config:sage'));
  check('KV 落地：org_code 正確', kvRaw.org_code === 'sage');
  check('KV 落地：basePath 正確', kvRaw.site.basePath === '/sage/ecard/dist');
}

console.log('\n=== ⑤ 合併語意：漏送欄位不應清空資料 ===');
{
  // 只送 org，其他欄位完全不送
  const r = await api('PUT', '/api/config', {
    token,
    body: { org: { zh: '只改名稱', cn: '只改名称', en: 'Only name' } },
  });

  check('org 已更新', r.json.config?.org?.zh === '只改名稱');
  check('未送的 about 保留（第③步的值）', r.json.config?.about?.zh === '新簡介');
  check('未送的 address 保留', r.json.config?.address?.en === 'New address');
  check('未送的 org_site 保留', r.json.config?.org_site === 'https://test.example.org');
  check('未送的 copyright 保留', r.json.config?.site?.copyright === '© 2026 測試機構');
  check('未送的 qr.label 保留', r.json.config?.qr?.label?.zh === '掃我');
}

console.log('\n=== ⑥ 空物件不應清空任何資料 ===');
{
  const beforeRes = await api('GET', '/api/config', { token });
  const before = beforeRes.json;

  const r = await api('PUT', '/api/config', { token, body: {} });

  check('org 不變', r.json.config?.org?.zh === before.org.zh);
  check('about 不變', r.json.config?.about?.zh === before.about.zh);
  check('org_site 不變', r.json.config?.org_site === before.org_site);
  check('copyright 不變', r.json.config?.site?.copyright === before.site.copyright);
  check('qr 不變', r.json.config?.qr?.label?.zh === before.qr.label.zh);
}

console.log('\n=== ⑦ 驗證失敗的情境 ===');
{
  const r1 = await api('PUT', '/api/config', {
    token,
    body: { org: { zh: '', cn: '', en: '' } },
  });
  // 三語都有舊值 → 應沿用而非清空，所以仍是 200
  check('機構名稱送空字串 → 沿用舊值（200）', r1.status === 200, `實際 ${r1.status}`);
  check('機構名稱未被清空', !!r1.json.config?.org?.zh);

  const r2 = await api('PUT', '/api/config', {
    token,
    body: { org_site: 'not-a-url' },
  });
  check('非法 URL → 400', r2.status === 400, `實際 ${r2.status}`);

  const r3 = await api('PUT', '/api/config', {
    token,
    body: { org_site: 'javascript:alert(1)' },
  });
  check('javascript: 協定 → 400', r3.status === 400, `實際 ${r3.status}`);

  const r4 = await api('PUT', '/api/config', {
    token,
    body: { org: { zh: '只有中文' } },  // 缺 cn / en
  });
  check('機構名稱缺語言 → 沿用舊值（200）', r4.status === 200, `實際 ${r4.status}`);
  check('缺的語言沿用舊值', !!r4.json.config?.org?.cn && !!r4.json.config?.org?.en);
}

console.log('\n=== ⑧ 手動模式下不自動觸發 ===');
{
  const envManual = { ...env, AUTO_REBUILD_MODE: 'manual' };
  const before = ghRequests.length;

  // 直接呼叫 worker.fetch 以指定不同 env
  const req = new Request(`http://127.0.0.1:${PORT}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ org: { zh: '手動模式測試', cn: '手动模式测试', en: 'Manual mode test' } }),
  });
  const resp = await worker.fetch(req, envManual);
  const json = await resp.json();

  check('手動模式：設定仍成功儲存', resp.status === 200 && json.ok === true);
  check('手動模式：未自動觸發', json.rebuild?.triggered === false);
  check('手動模式：回報 mode=manual', json.rebuild?.mode === 'manual');
  check('手動模式：確實沒發出 GitHub 請求', ghRequests.length === before, `多了 ${ghRequests.length - before} 次`);
}

console.log('\n=== ⑨ 設定不存在時的處理 ===');
{
  const emptyKV = makeKV();  // 完全空的 KV，沒有 config
  const envEmpty = { ...env, DATA: emptyKV };

  const req = new Request(`http://127.0.0.1:${PORT}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ org: { zh: 'x', cn: 'x', en: 'x' } }),
  });
  const resp = await worker.fetch(req, envEmpty);
  check('無既有設定 → 404', resp.status === 404, `實際 ${resp.status}`);
}

/* ---------- 收尾 ---------- */
server.close();
ghStub.close();

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail === 0 ? 0 : 1);
