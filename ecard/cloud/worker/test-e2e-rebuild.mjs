/**
 * 端到端驗證：後台改完資料 → 自動觸發前台重建
 *
 * 與 test-rebuild-trigger.mjs 的差異：
 *   前者驗單一函式（github.js）的行為；
 *   這裡起一個**真的 HTTP 伺服器**把 Worker 掛上去，
 *   用真實的 HTTP 請求走完「登入 → 改名片 → 觸發 GitHub → 回應帶 rebuild 欄位」。
 *
 * GitHub API 用本機 stub 模擬，不發出真實網路請求。
 *
 * 執行： node cloud/worker/test-e2e-rebuild.mjs
 */

import http from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const workerPromise = import('./src/index.js');
const authPromise = import('./src/auth.js');

const PASSWORD = 'sage-demo-2026';
const PORT = 4191;

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};
const bad = (n, d) => {
  fail++;
  console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`);
};
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
    async put(k, v) {
      store.set(k, String(v));
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      return {
        keys: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit)
          .map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
};

/* ---------- GitHub API stub ---------- */
const ghRequests = [];
const startGhStub = () =>
  new Promise((res) => {
    const srv = http.createServer((req, rqRes) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ghRequests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.includes('/dispatches') && req.method === 'POST') {
          rqRes.writeHead(204).end();
        } else if (req.url.includes('/runs') && req.method === 'GET') {
          rqRes.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              workflow_runs: [
                {
                  status: 'completed',
                  conclusion: 'success',
                  created_at: '2026-09-25T06:30:00Z',
                  html_url: 'https://github.com/tobyyipwork/sage/actions/runs/999',
                  event: 'workflow_dispatch',
                },
              ],
            })
          );
        } else {
          rqRes.writeHead(404).end('{}');
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });

/* ---------- 主流程 ---------- */
const worker = (await workerPromise).default;
const { hashPassword } = await authPromise;

const ghStub = await startGhStub();
const ghPort = ghStub.address().port;

const KV = makeKV();
const env = {
  DATA: KV,
  ORG_CODE: 'sage',
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  TOKEN_SECRET: 'test-secret-for-e2e',
  TOKEN_TTL_HOURS: '1',
  ROOT_ORIGIN: '*',
  BUILD_THROTTLE_MINUTES: '0', // 關閉節流，方便連續測試
  GITHUB_REPO: 'tobyyipwork/sage',
  GITHUB_DISPATCH_TOKEN: 'github_pat_e2e_fake',
  // 把 GitHub API 導向本機 stub
  _GH_BASE: `http://127.0.0.1:${ghPort}`,
};

// 攔截 fetch：把 api.github.com 導向 stub
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const s = String(url);
  if (s.includes('api.github.com')) {
    return realFetch(s.replace('https://api.github.com', env._GH_BASE), opts);
  }
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
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, data, text };
};

console.log('\n=== 端到端：後台改資料 → 自動觸發重建 ===\n');

/* ① 登入 */
const login = await api('POST', '/api/login', { body: { password: PASSWORD } });
check('登入成功取得 token', login.status === 200 && !!login.data?.token);
const TOKEN = login.data.token;

/* ② 建立一張名片 → 應觸發重建 */
ghRequests.length = 0;
const created = await api('POST', '/api/staff', {
  token: TOKEN,
  body: {
    slug: 'test-e2e',
    active: true,
    name: { zh: '測試員', cn: '测试员', en: 'Tester' },
    title: { zh: '工程師', cn: '工程师', en: 'Engineer' },
    n: { family: '測試', given: '員' },
    email: 't@example.com',
  },
});
check('新增名片成功', created.status === 200 && created.data?.ok === true);
check(
  '回應中帶 rebuild 欄位（新增）',
  created.data?.rebuild && typeof created.data.rebuild === 'object',
  JSON.stringify(created.data?.rebuild)
);
check('已觸發重建', created.data?.rebuild?.triggered === true, JSON.stringify(created.data?.rebuild));
check('GitHub dispatch 被呼叫', ghRequests.length >= 1, `got ${ghRequests.length}`);

const disp = ghRequests.find((r) => r.url.includes('/dispatches'));
check(
  'dispatch URL 路徑正確',
  disp && disp.url === '/repos/tobyyipwork/sage/actions/workflows/auto-rebuild.yml/dispatches',
  disp?.url
);
check('dispatch 帶 Bearer token', disp?.headers?.authorization === 'Bearer github_pat_e2e_fake', disp?.headers?.authorization);

/* ③ 修改名片 → 也應觸發 */
ghRequests.length = 0;
const updated = await api('PUT', '/api/staff/test-e2e', {
  token: TOKEN,
  body: {
    slug: 'test-e2e',
    active: true,
    name: { zh: '測試員改', cn: '测试员改', en: 'Tester II' },
    title: { zh: '資深工程師', cn: '资深工程师', en: 'Senior Engineer' },
    n: { family: '測試', given: '員' },
    email: 't@example.com',
  },
});
check('修改名片成功', updated.status === 200);
check('修改後也觸發重建', updated.data?.rebuild?.triggered === true, JSON.stringify(updated.data?.rebuild));
check('GitHub dispatch 被呼叫（修改）', ghRequests.some((r) => r.url.includes('/dispatches')));

/* ④ 刪除名片 → 也應觸發 */
ghRequests.length = 0;
const deleted = await api('DELETE', '/api/staff/test-e2e', { token: TOKEN });
check('刪除名片成功', deleted.status === 200);
check('刪除後也觸發重建', deleted.data?.rebuild?.triggered === true, JSON.stringify(deleted.data?.rebuild));

/* ⑤ 修改機構設定 → 也應觸發 */
ghRequests.length = 0;
const cfg = await api('GET', '/api/config', { token: TOKEN });
if (cfg.status === 200 && cfg.data) {
  const put = await api('PUT', '/api/config', {
    token: TOKEN,
    body: { ...cfg.data, org_name: cfg.data.org_name || { zh: '測試機構' } },
  });
  check('改機構設定後觸發重建', put.data?.rebuild?.triggered === true, JSON.stringify(put.data?.rebuild));
} else {
  ok('（略過機構設定測試：尚無 config）');
}

/* ⑥ 手動重建按鈕（force） */
ghRequests.length = 0;
const manual = await api('POST', '/api/build', { token: TOKEN, body: { force: true } });
check('手動重建成功', manual.status === 200 && manual.data?.triggered === true);
const fbody = JSON.parse(ghRequests.find((r) => r.url.includes('/dispatches'))?.body || '{}');
check('force 以字串 "true" 傳給 GitHub', fbody.inputs?.force === 'true', JSON.stringify(fbody.inputs));

/* ⑦ 狀態查詢應顯示 configured 與最近執行 */
const status = await api('GET', '/api/build', { token: TOKEN });
check('狀態查詢 configured 為 true', status.data?.configured === true);
check('狀態查詢回報 repo', status.data?.repo === 'tobyyipwork/sage', status.data?.repo);
check(
  '狀態查詢帶最近一次執行結果',
  status.data?.latest_run?.conclusion === 'success',
  JSON.stringify(status.data?.latest_run)
);

/* ⑧ 未設定 token 的環境 → 應明確回報未設定，而非靜默 */
const envNoCfg = { ...env, GITHUB_REPO: '', GITHUB_DISPATCH_TOKEN: '' };
const workerModule = worker;
const noCfgRes = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/build`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  }),
  envNoCfg
);
const noCfgData = await noCfgRes.json();
check('未設定時 configured 為 false', noCfgData?.configured === false);
check('未設定時說明資料已儲存', /已儲存/.test(noCfgData?.message || ''), noCfgData?.message);

/* ⑨ 半套設定 → 應明確報錯，不可當成成功 */
const envHalf = { ...env, GITHUB_REPO: 'tobyyipwork/sage', GITHUB_DISPATCH_TOKEN: '' };
const halfRes = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/build`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  }),
  envHalf
);
const halfData = await halfRes.json();
check('半套設定（缺 token）時 configured 為 false', halfData?.configured === false);
check('半套設定有明確原因', !!halfData?.reason, halfData?.reason);

/* ⑩ 手動模式（AUTO_REBUILD_MODE=manual）→ 儲存不觸發，按鈕才觸發 */
const envManual = { ...env, AUTO_REBUILD_MODE: 'manual' };

const manualCreate = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/staff`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'test-manual',
      active: true,
      name: { zh: '手動測試', cn: '手动测试', en: 'Manual Test' },
      title: { zh: '測試', cn: '测试', en: 'Test' },
      n: { family: '手動', given: '測試' },
      email: 'm@example.com',
    }),
  }),
  envManual
);
const manualCreateData = await manualCreate.json();
check('手動模式：新增名片仍成功', manualCreateData?.ok === true, JSON.stringify(manualCreateData).slice(0, 160));
check(
  '手動模式：新增後「不」自動觸發',
  manualCreateData?.rebuild?.triggered === false,
  JSON.stringify(manualCreateData?.rebuild)
);
check('手動模式：標記 mode=manual', manualCreateData?.rebuild?.mode === 'manual', manualCreateData?.rebuild?.mode);
check('手動模式：標記 manual=true', manualCreateData?.rebuild?.manual === true);
check(
  '手動模式：訊息引導使用者去按按鈕',
  /立即重建前台/.test(manualCreateData?.rebuild?.message || ''),
  manualCreateData?.rebuild?.message
);

// 關鍵：確認 GitHub 完全沒有被呼叫（這才是手動模式的意義）
ghRequests.length = 0;
const manualUpdate = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/staff/test-manual`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: 'test-manual',
      active: true,
      name: { zh: '手動測試改', cn: '手动测试改', en: 'Manual Test II' },
      title: { zh: '測試', cn: '测试', en: 'Test' },
      n: { family: '手動', given: '測試' },
      email: 'm@example.com',
    }),
  }),
  envManual
);
const manualUpdateData = await manualUpdate.json();
check('手動模式：修改名片成功', manualUpdateData?.ok === true);
check('手動模式：修改後也不觸發', manualUpdateData?.rebuild?.triggered === false);
check('手動模式：完全沒有發出 GitHub 請求', ghRequests.length === 0, `got ${ghRequests.length}`);

// 手動模式下按按鈕 → 應該要觸發
ghRequests.length = 0;
const manualBtn = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/build`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ force: true }),
  }),
  envManual
);
const manualBtnData = await manualBtn.json();
check('手動模式：按鈕仍可觸發', manualBtnData?.triggered === true, JSON.stringify(manualBtnData));
check('手動模式：按鈕確實呼叫 GitHub', ghRequests.some((r) => r.url.includes('/dispatches')));

// 狀態查詢要回報 manual
const statusManual = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/build`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }),
  envManual
);
const statusManualData = await statusManual.json();
check('狀態查詢回報 mode=manual', statusManualData?.mode === 'manual', statusManualData?.mode);
check('狀態查詢回報 auto=false', statusManualData?.auto === false);

/* ⑪ auto 模式的狀態查詢要回報 auto */
const statusAuto = await api('GET', '/api/build', { token: TOKEN });
check('auto 模式狀態查詢回報 mode=auto', statusAuto.data?.mode === 'auto', statusAuto.data?.mode);
check('auto 模式狀態查詢回報 auto=true', statusAuto.data?.auto === true);

/* ⑫ 打錯字不可意外靜音（fallback auto）*/
const envTypo = { ...env, AUTO_REBUILD_MODE: 'manul' };
const typoRes = await workerModule.fetch(
  new Request(`http://127.0.0.1:${PORT}/api/build`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }),
  envTypo
);
const typoData = await typoRes.json();
check('拼錯字 fallback 為 auto（不靜音）', typoData?.mode === 'auto', typoData?.mode);

/* ---------- 收尾 ---------- */
globalThis.fetch = realFetch;
server.close();
ghStub.close();

console.log('');
if (fail === 0) {
  console.log(`通過 ${pass} 項，失敗 0 項`);
  process.exit(0);
} else {
  console.log(`通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(1);
}
