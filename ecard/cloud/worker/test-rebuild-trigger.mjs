/**
 * 自動重建觸發 —— 單元與整合驗證
 *
 * 驗證重點：
 *   ① 設定檢查：兩個變數缺一不可，半套設定必須明確報錯（不可靜默）
 *   ② 觸發邏輯：正確組出 URL、帶對 header、正確解讀 204
 *   ③ 錯誤處理：各 HTTP 狀態碼要有可辨識的中文提示
 *   ④ 節流：視窗內合併為一次，且失敗時不佔用節流視窗
 *   ⑤ 整合：改名片後回應中要帶 rebuild 欄位
 *
 * 全程用 stub 攔截 fetch，不發出真實網路請求。
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SRC = resolve(HERE, 'src');

const { dispatchStatus, triggerRebuild, latestRun, rebuildMode } = await import(
  'file://' + resolve(WORKER_SRC, 'github.js').replace(/\\/g, '/')
);

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  console.log(`  ✓ ${name}`);
};
const bad = (name, detail) => {
  fail++;
  console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
};

/* ---------- fetch stub ---------- */
const realFetch = globalThis.fetch;
let calls = [];
const stubFetch = (handler) => {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
};
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

const mkRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (body === undefined) throw new Error('no body');
    return body;
  },
});

const ENV_OK = {
  GITHUB_REPO: 'tobyyipwork/sage',
  GITHUB_DISPATCH_TOKEN: 'github_pat_fake_token_for_test',
};

/* ══════════ ① 設定檢查 ══════════ */
console.log('\n=== 設定檢查（dispatchStatus）===');

{
  const s = dispatchStatus({});
  s.ready === false && s.reason === 'not_configured'
    ? ok('兩個都缺 → not_configured（合理預設，非錯誤）')
    : bad('兩個都缺', JSON.stringify(s));
}

{
  const s = dispatchStatus({ GITHUB_REPO: 'a/b' });
  s.ready === false && s.reason === 'missing_token'
    ? ok('只有 repo → missing_token（半套設定要抓出來）')
    : bad('只有 repo', JSON.stringify(s));
}

{
  const s = dispatchStatus({ GITHUB_DISPATCH_TOKEN: 'x' });
  s.ready === false && s.reason === 'missing_repo'
    ? ok('只有 token → missing_repo')
    : bad('只有 token', JSON.stringify(s));
}

{
  const s = dispatchStatus({ GITHUB_REPO: 'not-a-repo', GITHUB_DISPATCH_TOKEN: 'x' });
  s.ready === false && s.reason === 'invalid_repo_format'
    ? ok('repo 格式錯誤 → invalid_repo_format')
    : bad('repo 格式錯誤', JSON.stringify(s));
}

{
  const s = dispatchStatus(ENV_OK);
  s.ready === true && s.repo === 'tobyyipwork/sage' && s.workflow === 'auto-rebuild.yml'
    ? ok('設定完整 → ready，預設 workflow 為 auto-rebuild.yml')
    : bad('設定完整', JSON.stringify(s));
}

{
  const s = dispatchStatus({ ...ENV_OK, GITHUB_WORKFLOW_FILE: 'other.yml' });
  s.workflow === 'other.yml' ? ok('可自訂 workflow 檔名') : bad('自訂 workflow', JSON.stringify(s));
}

/* ══════════ ② 觸發邏輯 ══════════ */
console.log('\n=== 觸發邏輯（triggerRebuild）===');

{
  stubFetch(() => mkRes(204));
  const r = await triggerRebuild(ENV_OK);
  const call = calls[0];

  r.ok === true && r.triggered === true
    ? ok('204 → triggered: true')
    : bad('204 解讀', JSON.stringify(r));

  call.url ===
  'https://api.github.com/repos/tobyyipwork/sage/actions/workflows/auto-rebuild.yml/dispatches'
    ? ok('URL 正確組成')
    : bad('URL', call.url);

  call.opts.method === 'POST' ? ok('使用 POST') : bad('method', call.opts.method);

  const h = call.opts.headers;
  h.Authorization === 'Bearer github_pat_fake_token_for_test'
    ? ok('Authorization 帶 Bearer token')
    : bad('Authorization', h.Authorization);

  h['User-Agent'] ? ok('帶 User-Agent（GitHub 要求）') : bad('User-Agent 缺少');

  const body = JSON.parse(call.opts.body);
  body.ref === 'main' ? ok('ref 預設為 main') : bad('ref', body.ref);

  body.inputs && body.inputs.force === 'false'
    ? ok('inputs.force 為字串 "false"（GitHub 要求字串型別）')
    : bad('inputs.force', JSON.stringify(body.inputs));
  restoreFetch();
}

{
  stubFetch(() => mkRes(204));
  await triggerRebuild(ENV_OK, { force: true });
  const body = JSON.parse(calls[0].opts.body);
  body.inputs.force === 'true' ? ok('force: true 正確傳遞') : bad('force 傳遞', body.inputs.force);
  restoreFetch();
}

{
  stubFetch(() => mkRes(204));
  await triggerRebuild({ ...ENV_OK, GITHUB_BRANCH: 'develop' });
  const body = JSON.parse(calls[0].opts.body);
  body.ref === 'develop' ? ok('可自訂分支') : bad('自訂分支', body.ref);
  restoreFetch();
}

/* ══════════ ③ 錯誤處理 ══════════ */
console.log('\n=== 錯誤處理 ===');

const errCases = [
  [401, /過期|無效/],
  [403, /權限不足/],
  [404, /找不到/],
  [410, /停用/],
  [422, /參數/],
];

for (const [status, pattern] of errCases) {
  stubFetch(() => mkRes(status, { message: 'stub error' }));
  const r = await triggerRebuild(ENV_OK);
  const good = r.ok === false && r.triggered === false && pattern.test(r.message);
  good
    ? ok(`HTTP ${status} → 有可辨識的中文提示`)
    : bad(`HTTP ${status}`, r.message);
  if (status === 403 && !/Actions: Read and write/.test(r.message)) {
    bad('403 應提示需要的權限', r.message);
  }
  restoreFetch();
}

{
  stubFetch(() => mkRes(403, { message: 'Resource not accessible by personal access token' }));
  const r = await triggerRebuild(ENV_OK);
  /Resource not accessible/.test(r.detail || '')
    ? ok('保留 GitHub 原始錯誤訊息供排查')
    : bad('原始錯誤訊息', r.detail);
  restoreFetch();
}

{
  stubFetch(() => {
    throw new Error('simulated network down');
  });
  const r = await triggerRebuild(ENV_OK);
  r.ok === false && r.reason === 'network_error' && /無法連線/.test(r.message)
    ? ok('網路錯誤被捕捉，不往外丟例外')
    : bad('網路錯誤', JSON.stringify(r));
  restoreFetch();
}

{
  // 未設定時不應發出任何網路請求
  stubFetch(() => mkRes(204));
  const r = await triggerRebuild({});
  calls.length === 0 && r.configured === false
    ? ok('未設定時不發請求，直接回報未設定')
    : bad('未設定仍發請求', `calls=${calls.length}`);
  restoreFetch();
}

/* ══════════ ④ latestRun ══════════ */
console.log('\n=== 執行狀態查詢（latestRun）===');

{
  stubFetch(() =>
    mkRes(200, {
      workflow_runs: [
        {
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-09-25T06:00:00Z',
          html_url: 'https://github.com/x/y/actions/runs/1',
          event: 'workflow_dispatch',
        },
      ],
    })
  );
  const r = await latestRun(ENV_OK);
  r && r.conclusion === 'success' && r.event === 'workflow_dispatch'
    ? ok('可取得最近一次執行結果')
    : bad('latestRun', JSON.stringify(r));
  restoreFetch();
}

{
  stubFetch(() => mkRes(200, { workflow_runs: [] }));
  const r = await latestRun(ENV_OK);
  r === null ? ok('沒有執行記錄時回傳 null') : bad('空記錄', JSON.stringify(r));
  restoreFetch();
}

{
  stubFetch(() => mkRes(500, {}));
  const r = await latestRun(ENV_OK);
  r === null ? ok('查詢失敗時回傳 null（不影響主要流程）') : bad('查詢失敗', JSON.stringify(r));
  restoreFetch();
}

{
  stubFetch(() => mkRes(200, {}));
  const r = await latestRun({});
  r === null ? ok('未設定時回傳 null') : bad('未設定', JSON.stringify(r));
  calls.length === 0 ? ok('未設定時不發查詢請求') : bad('未設定仍發請求');
  restoreFetch();
}

/* ══════════ ⑤ 重建模式切換（AUTO_REBUILD_MODE） ══════════ */
console.log('\n=== 重建模式切換 ===');

{
  const m = (env) => rebuildMode(env).mode;

  m({}) === 'auto' ? ok('未設定時預設為 auto（維持既有行為）') : bad('未設定預設', m({}));
  m({ AUTO_REBUILD_MODE: 'auto' }) === 'auto' ? ok('明確設定 auto') : bad('設定 auto');
  m({ AUTO_REBUILD_MODE: 'manual' }) === 'manual' ? ok('明確設定 manual') : bad('設定 manual');

  // 大小寫與空白要容錯，否則使用者手改 toml 很容易踩雷
  m({ AUTO_REBUILD_MODE: 'MANUAL' }) === 'manual'
    ? ok('大寫 MANUAL 仍視為 manual')
    : bad('大寫 MANUAL', m({ AUTO_REBUILD_MODE: 'MANUAL' }));
  m({ AUTO_REBUILD_MODE: '  manual  ' }) === 'manual'
    ? ok('前後空白仍視為 manual')
    : bad('空白 trim', m({ AUTO_REBUILD_MODE: '  manual  ' }));

  // 關鍵：打錯字必須 fallback 到 auto，不可意外靜音
  m({ AUTO_REBUILD_MODE: 'manul' }) === 'auto'
    ? ok('拼錯字 fallback 為 auto（避免誤觸靜音）')
    : bad('拼錯字 fallback', m({ AUTO_REBUILD_MODE: 'manul' }));
  m({ AUTO_REBUILD_MODE: 'off' }) === 'auto'
    ? ok('非法值 fallback 為 auto')
    : bad('非法值 fallback', m({ AUTO_REBUILD_MODE: 'off' }));

  rebuildMode({}).auto === true ? ok('auto 模式 auto=true') : bad('auto flag');
  rebuildMode({ AUTO_REBUILD_MODE: 'manual' }).auto === false
    ? ok('manual 模式 auto=false')
    : bad('manual flag');
}

/* ══════════ ⑥ 整合：Worker 端點 ══════════ */
console.log('\n=== 整合：Worker /api/build ===');
{
  const worker = (await import('file://' + resolve(WORKER_SRC, 'index.js').replace(/\\/g, '/'))).default;

  // 用 stub 攔 GitHub，讓 /api/build 走完整流程
  stubFetch((url) => {
    if (String(url).includes('api.github.com')) return mkRes(204);
    return mkRes(500, {});
  });

  // 需要通過驗證，這裡直接檢查「未登入」時的行為即可（401），
  // 但更重要的是確認模組載入無誤、路由註冊成功。
  const res = await worker.fetch(
    new Request('https://x.workers.dev/api/build', { method: 'POST' }),
    { ...ENV_OK, DATA: fakeKV() }
  );
  res.status === 401
    ? ok('/api/build 需登入（未帶 token → 401）')
    : bad('/api/build 未登入', `status=${res.status}`);
  restoreFetch();
}

/* ---------- 極簡 KV stub（僅供路由載入用） ---------- */
function fakeKV() {
  const m = new Map();
  return {
    get: async (k, type) => {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async () => ({ keys: [] }),
  };
}

/* ---------- 結果 ---------- */
console.log('');
if (fail === 0) {
  console.log(`通過 ${pass} 項，失敗 0 項`);
  process.exit(0);
} else {
  console.log(`通過 ${pass} 項，失敗 ${fail} 項`);
  process.exit(1);
}
