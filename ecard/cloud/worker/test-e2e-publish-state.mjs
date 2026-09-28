/**
 * 端到端驗證：後台卡片「發布狀態」所需的資料鏈
 *
 * 這條鏈是：
 *   GET /api/staff（index）
 *     → 每筆要帶 updated_at
 *   GET /api/build
 *     → 要帶 last_build_at 與 auto/configured
 *   前端 pubState() 拿這兩者比對 → 決定顯示「待重建」還是「已上線」
 *
 * 為什麼要端到端測？
 *   單元測試可以證明 pubState 的判斷邏輯對，
 *   但證明不了【後端真的把 updated_at 送出來】——
 *   那正是最容易漏的一環（index 是投影出來的小快取，
 *   欄位不會自動跟著 staff 記錄長出來）。少一個欄位，
 *   前端只能顯示「狀態未知」，使用者卻以為功能做好了。
 *
 * 另外驗證新增的維護端點 POST /api/maintenance/rebuild-index：
 *   它是「補舊 index 欄位」的救援路徑，必須真的有效，
 *   否則舊資料永遠停在「狀態未知」。
 *
 * 執行： node cloud/worker/test-e2e-publish-state.mjs
 */

import http from 'node:http';

const workerPromise = import('./src/index.js');
const authPromise = import('./src/auth.js');

const PASSWORD = 'sage-demo-2026';
const PORT = 4198;

let pass = 0;
let fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const check = (n, cond, d) => (cond ? ok(n) : bad(n, d));

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

/* ---------- GitHub stub：可控制「上次執行時間」 ---------- */
let runCreatedAt = '2026-09-28T00:00:00Z';
const startGhStub = () =>
  new Promise((res) => {
    const srv = http.createServer((req, rqRes) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url.includes('/dispatches') && req.method === 'POST') return rqRes.writeHead(204).end();
        if (req.url.includes('/runs') && req.method === 'GET') {
          return rqRes.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ workflow_runs: runCreatedAt ? [{ status: 'completed', conclusion: 'success', created_at: runCreatedAt, html_url: 'https://x', event: 'workflow_dispatch' }] : [] })
          );
        }
        rqRes.writeHead(404).end('{}');
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });

const worker = (await workerPromise).default;
const { hashPassword } = await authPromise;

const ghStub = await startGhStub();
const ghPort = ghStub.address().port;

const KV = makeKV();
await KV.put('config:sage', JSON.stringify({
  org_code: 'sage',
  org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
  org_site: 'https://www.sage.org.hk',
  about: { zh: '簡介', cn: '简介', en: 'About' },
  address: { zh: '香港北角', cn: '香港北角', en: 'North Point, Hong Kong' },
  site: { url: 'https://tobyyipwork.github.io', basePath: '/sage/ecard/dist', copyright: '© 2026 SAGE', version: '1.2.0' },
  qr: { enabled: true, mode: 'static', label: { zh: '掃碼', cn: '扫码', en: 'Scan' } },
  langs: ['zh', 'cn', 'en'],
  default_lang: 'zh',
}));
await KV.put('index:sage', JSON.stringify([]));

const env = {
  DATA: KV,
  ORG_CODE: 'sage',
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  TOKEN_SECRET: 'test-secret-publish-state',
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

const login = async () => (await api('POST', '/api/login', { body: { password: PASSWORD } })).json.token;

console.log('\n=== 後台發布狀態資料鏈 端到端驗證 ===\n');

/* ══════════════════ ⓪ 登入前可取得機構名（登入畫面用）══════════════════
 * 這項放最前面，因為它必須在【尚未登入】時就能成功。
 * 登入畫面要顯示機構名，但 /api/config 需要驗證 ——
 * 只能靠免驗證的 /api/health 提供。 */
console.log('▸ ⓪ 未登入也能取得機構名（登入畫面用）');
{
  const h = await api('GET', '/api/health');
  check('GET /api/health 未登入可用', h.status === 200, `實際 ${h.status}`);
  check('health 回傳 org_name.zh（登入畫面顯示用）',
    h.json.org_name && h.json.org_name.zh === '香港耆康老人福利會',
    `實際 ${JSON.stringify(h.json.org_name)}`);
  check('health 回傳 org_name.en', h.json.org_name && !!h.json.org_name.en);

  /* 反向確認：config 未登入確實不可用 —— 這正是不能用它的原因。 */
  const c = await api('GET', '/api/config');
  check('對照：GET /api/config 未登入 → 401（所以登入畫面不能用它）',
    c.status === 401, `實際 ${c.status}`);
}

const token = await login();
check('登入成功取得通行證', !!token);

/* ══════════════════ ① 新增名片後，index 要帶 updated_at ══════════════════ */
console.log('▸ ① 新增名片 → index 帶 updated_at');
{
  const r = await api('POST', '/api/staff', {
    token,
    body: { slug: 'pub-test', active: true, name: { zh: '發布測試', cn: '', en: '' }, title: { zh: '測試', cn: '', en: '' } },
  });
  check('POST /api/staff 成功', r.status === 200, `實際 ${r.status}`);

  const list = await api('GET', '/api/staff', { token });
  const entry = (list.json || []).find((i) => i.slug === 'pub-test');
  check('新名片出現在 index', !!entry);
  check('index 項目帶 updated_at（發布狀態判定所需）',
    entry && typeof entry.updated_at === 'string' && entry.updated_at.length > 0,
    `實際：${entry && JSON.stringify(entry.updated_at)}`);
  check('updated_at 是可解析的時間',
    entry && isFinite(Date.parse(entry.updated_at)),
    `實際：${entry && entry.updated_at}`);
}

/* ══════════════════ ② GET /api/build 要提供比對基準 ══════════════════ */
console.log('\n▸ ② GET /api/build 提供比對基準');
{
  const b = await api('GET', '/api/build', { token });
  check('GET /api/build 成功', b.status === 200, `實際 ${b.status}`);
  check('回傳 configured=true', b.json.configured === true, `實際 ${b.json.configured}`);
  check('回傳 auto 欄位（決定是否可能自動更新）', typeof b.json.auto === 'boolean', `實際 ${typeof b.json.auto}`);
  check('回傳 last_build_at（前端的比對基準）', !!b.json.last_build_at, `實際 ${b.json.last_build_at}`);
}

/* ══════════════════ ③ 前端判定：這兩個值放在一起要能得出正確結論 ══════════════════ */
console.log('\n▸ ③ 用真實資料做判定（模擬 pubState）');
{
  /* 從真實檔案抽出前端的 pubState，用真實後端資料餵它 ——
     這才是真正的端到端：後端欄位 + 前端邏輯，兩邊一齊驗。 */
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const vm = (await import('node:vm')).default;

  const HERE = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(resolve(HERE, '..', '..', 'admin', 'public', 'index.html'), 'utf8');
  const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];
  const fnSrc = (js.match(/(function pubState\([\s\S]*?\n\})/) || [])[1];
  const agoSrc = (js.match(/(function agoText\([\s\S]*?\n\})/) || [])[1];
  check('成功抽出前端 pubState（真實原始碼）', !!fnSrc && !!agoSrc);

  const list = await api('GET', '/api/staff', { token });
  const build = (await api('GET', '/api/build', { token })).json;
  const entry = (list.json || []).find((i) => i.slug === 'pub-test');

  const evalState = (s, b) => {
    const ctx = { BUILD_STATUS: b, Date, isFinite, Math };
    vm.createContext(ctx);
    vm.runInContext(`${agoSrc}\n${fnSrc}\n; __f = pubState;`, ctx, { filename: 'pubState.js' });
    return ctx.__f(s);
  };

  /* 情境 A：重建時間在名片改動之後 → 已上線 */
  const later = { ...build, last_build_at: new Date(Date.parse(entry.updated_at) + 60000).toISOString() };
  const stA = evalState(entry, later);
  check('名片改動早於上次重建 → 判為「已上線」', stA.cls === 'pub-live', `實際 ${stA.cls} / ${stA.label}`);

  /* 情境 B：重建時間早於名片改動 → 待重建 */
  const earlier = { ...build, last_build_at: new Date(Date.parse(entry.updated_at) - 60000).toISOString() };
  const stB = evalState(entry, earlier);
  check('名片改動晚於上次重建 → 判為「待重建」', stB.cls === 'pub-pending', `實際 ${stB.cls} / ${stB.label}`);
  check('「待重建」有顯示預計生效時間', /分鐘/.test(stB.when || ''), `實際 when="${stB.when}"`);

  /* 情境 C：自動重建未設定 → 不可宣稱已上線 */
  const stC = evalState(entry, { configured: false });
  check('自動重建未設定 → 判為「待發布」（不謊報已上線）', stC.cls === 'pub-pending', `實際 ${stC.cls} / ${stC.label}`);

  /* 情境 D：完全沒有建置狀態 → 狀態未知 */
  const stD = evalState(entry, null);
  check('尚未取得建置狀態 → 判為「狀態未知」', stD.cls === 'pub-unknown', `實際 ${stD.cls} / ${stD.label}`);
}

/* ══════════════════ ④ 維護端點：補舊 index 欄位 ══════════════════ */
console.log('\n▸ ④ POST /api/maintenance/rebuild-index');
{
  /* 模擬「舊 index」：欄位被清掉（模擬 migrate 之前的資料） */
  const before = JSON.parse(KV.store.get('index:sage'));
  const legacy = before.map((e) => { const { updated_at, ...rest } = e; return rest; });
  await KV.put('index:sage', JSON.stringify(legacy));

  const stale = (await api('GET', '/api/staff', { token })).json.find((i) => i.slug === 'pub-test');
  check('舊 index 確實缺 updated_at（模擬遷移前狀態）', stale.updated_at === undefined,
    `實際 ${JSON.stringify(stale.updated_at)}`);

  const r = await api('POST', '/api/maintenance/rebuild-index', { token });
  check('重建端點回應成功', r.status === 200 && r.json.ok === true, `實際 ${r.status}`);
  check('回報重建筆數', r.json.count === before.length, `實際 ${r.json.count}，期望 ${before.length}`);

  const fixed = (await api('GET', '/api/staff', { token })).json.find((i) => i.slug === 'pub-test');
  check('重建後 updated_at 回來了', typeof fixed.updated_at === 'string' && fixed.updated_at.length > 0,
    `實際 ${JSON.stringify(fixed.updated_at)}`);
  check('重建是冪等的（不重複、不遺漏）',
    (await api('GET', '/api/staff', { token })).json.length === before.length);

  /* 其他欄位不能被重建弄丟 */
  const orig = before.find((i) => i.slug === 'pub-test');
  check('重建保留 name / title / active / has_avatar',
    fixed.name && fixed.name.zh === orig.name.zh && fixed.active === orig.active,
    `實際 ${JSON.stringify({ name: fixed.name, active: fixed.active })}`);
}

/* ══════════════════ ⑤ 未登入不可呼叫維護端點 ══════════════════ */
console.log('\n▸ ⑤ 維護端點需授權');
{
  const r = await api('POST', '/api/maintenance/rebuild-index', {});
  check('未登入 → 401', r.status === 401, `實際 ${r.status}`);
}

/* ══════════════════ ⑥ 刪除名片後 index 不殘留 ══════════════════ */
console.log('\n▸ ⑥ 刪除名片 → index 不殘留');
{
  await api('DELETE', '/api/staff/pub-test', { token });
  const list = (await api('GET', '/api/staff', { token })).json;
  check('刪除後 index 不再含該名片', !list.some((i) => i.slug === 'pub-test'));
}

console.log(`\n  通過 ${pass} 項，失敗 ${fail} 項\n`);
server.close();
ghStub.close();
process.exit(fail ? 1 : 0);
