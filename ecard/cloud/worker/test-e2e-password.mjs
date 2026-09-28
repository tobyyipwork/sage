/**
 * 端到端驗證：網頁修改管理密碼（第 1 層）
 *
 * 最重要的兩個情境：
 *   ① 向後相容 —— KV 沒有密碼時，仍可用環境密鑰 ADMIN_PASSWORD_HASH 登入
 *      （若這條壞掉，本次升級會讓既有機構立刻無法登入）
 *   ② 改密碼後 —— 新密碼生效、舊密碼失效、KV 已遷移
 *
 * 執行： node test-e2e-password.mjs
 */

import http from 'node:http';

const workerPromise = import('./src/index.js');
const authPromise = import('./src/auth.js');

const ENV_PASSWORD = 'env-secret-2026';   // 模擬既有機構：密碼只在環境密鑰
const PORT = 4195;

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

const worker = (await workerPromise).default;
const { hashPassword } = await authPromise;

const KV = makeKV();
await KV.put('config:sage', JSON.stringify({
  org_code: 'sage',
  org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
  about: { zh: 'a', cn: 'a', en: 'a' },
  address: { zh: 'a', cn: 'a', en: 'a' },
  site: { url: 'https://x.example', basePath: '/sage/ecard/dist', copyright: 'c', version: '1.2.0' },
  qr: { enabled: true, label: { zh: 'q', cn: 'q', en: 'q' } },
  langs: ['zh', 'cn', 'en'],
  default_lang: 'zh',
}));
await KV.put('index:sage', JSON.stringify([]));

const env = {
  DATA: KV,
  ORG_CODE: 'sage',
  // 關鍵：只有環境密鑰，KV 裡沒有密碼 → 模擬升級前的既有機構
  ADMIN_PASSWORD_HASH: await hashPassword(ENV_PASSWORD),
  TOKEN_SECRET: 'test-secret-e2e-pw',
  TOKEN_TTL_HOURS: '1',
  ROOT_ORIGIN: '*',
  BUILD_THROTTLE_MINUTES: '0',
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
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
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

console.log('\n=== ① 向後相容：KV 無密碼時仍可用環境密鑰登入（最關鍵）===');
{
  const kvRec = await KV.get('auth:sage:password', 'json');
  check('前提：KV 裡還沒有密碼記錄', kvRec === null);

  const r = await api('POST', '/api/login', { body: { password: ENV_PASSWORD } });
  check('環境密鑰可登入 → 200', r.status === 200, `實際 ${r.status}`);
  check('取得通行證', !!r.json.token);

  const wrong = await api('POST', '/api/login', { body: { password: 'wrong-password' } });
  check('錯誤密碼 → 401', wrong.status === 401, `實際 ${wrong.status}`);
}

const login = await api('POST', '/api/login', { body: { password: ENV_PASSWORD } });
const token = login.json.token;

console.log('\n=== ② 密碼狀態查詢 ===');
{
  const r = await api('GET', '/api/password', { token });
  check('GET /api/password → 200', r.status === 200, `實際 ${r.status}`);
  check('configured=true', r.json.configured === true);
  check('migrated=false（尚未遷移到 KV）', r.json.migrated === false, `實際 ${r.json.migrated}`);
  check('source=env', r.json.source === 'env', `實際 ${r.json.source}`);
  check('未登入 → 401', (await api('GET', '/api/password')).status === 401);
}

console.log('\n=== ③ 修改密碼的驗證規則 ===');
{
  const noCur = await api('POST', '/api/password', { token, body: { new_password: 'Xk9-mQ2p-Lz' } });
  check('未提供舊密碼 → 400', noCur.status === 400, `實際 ${noCur.status}`);

  const wrongCur = await api('POST', '/api/password', {
    token, body: { current_password: 'not-the-password', new_password: 'Xk9-mQ2p-Lz' },
  });
  check('舊密碼錯誤 → 401', wrongCur.status === 401, `實際 ${wrongCur.status}`);

  const short = await api('POST', '/api/password', {
    token, body: { current_password: ENV_PASSWORD, new_password: 'abc' },
  });
  check('新密碼過短 → 400', short.status === 400, `實際 ${short.status}`);

  const weak = await api('POST', '/api/password', {
    token, body: { current_password: ENV_PASSWORD, new_password: 'password' },
  });
  check('新密碼為常見密碼 → 400', weak.status === 400, `實際 ${weak.status}`);

  const same = await api('POST', '/api/password', {
    token, body: { current_password: ENV_PASSWORD, new_password: ENV_PASSWORD },
  });
  check('新密碼與舊密碼相同 → 400', same.status === 400, `實際 ${same.status}`);

  const noAuth = await api('POST', '/api/password', {
    body: { current_password: ENV_PASSWORD, new_password: 'Xk9-mQ2p-Lz' },
  });
  check('未登入 → 401', noAuth.status === 401, `實際 ${noAuth.status}`);

  // 上述都失敗，KV 應仍無記錄
  check('失敗的嘗試未寫入 KV', (await KV.get('auth:sage:password', 'json')) === null);
}

console.log('\n=== ④ 成功修改密碼 ===');
const NEW_PASSWORD = 'Xk9-mQ2p-Lz-2026';
let newToken = '';
{
  const r = await api('POST', '/api/password', {
    token, body: { current_password: ENV_PASSWORD, new_password: NEW_PASSWORD },
  });

  check('修改成功 → 200', r.status === 200, `實際 ${r.status}`);
  check('回應 ok=true', r.json.ok === true);
  check('回報驗證來源 source=env', r.json.source === 'env');
  check('回報密碼強度', !!r.json.strength);
  check('簽發新通行證', !!r.json.token);
  newToken = r.json.token || '';

  // 檢查 KV 落地
  const rec = await KV.get('auth:sage:password', 'json');
  check('KV 已寫入密碼記錄', !!rec && !!rec.hash);
  check('KV 記錄含 algo 欄位', rec?.algo === 'sha256');
  check('KV 記錄含 updated_at', !!rec?.updated_at);
  check('KV 儲存的是雜湊而非明文', rec?.hash !== NEW_PASSWORD && /^[0-9a-f]{64}$/.test(rec?.hash || ''));
  check('雜湊值正確', rec?.hash === await hashPassword(NEW_PASSWORD));
  check('KV 中不含明文新密碼', !JSON.stringify(rec).includes(NEW_PASSWORD));
}

console.log('\n=== ⑤ 改完後：新密碼生效、舊密碼失效 ===');
{
  const withNew = await api('POST', '/api/login', { body: { password: NEW_PASSWORD } });
  check('新密碼可登入 → 200', withNew.status === 200, `實際 ${withNew.status}`);

  const withOld = await api('POST', '/api/login', { body: { password: ENV_PASSWORD } });
  check('原本的環境密碼已失效 → 401', withOld.status === 401, `實際 ${withOld.status}`);

  const withWrong = await api('POST', '/api/login', { body: { password: 'whatever-else' } });
  check('其他密碼 → 401', withWrong.status === 401, `實際 ${withWrong.status}`);
}

console.log('\n=== ⑥ 遷移狀態已更新 ===');
{
  const r = await api('GET', '/api/password', { token: newToken });
  check('migrated=true（已遷移到 KV）', r.json.migrated === true, `實際 ${r.json.migrated}`);
  check('source=kv', r.json.source === 'kv', `實際 ${r.json.source}`);
  check('configured=true', r.json.configured === true);
}

console.log('\n=== ⑦ 第二次改密碼（此時來源已是 KV）===');
{
  const THIRD = 'Zq7#vN4w-Rt9-Km';
  const r = await api('POST', '/api/password', {
    token: newToken, body: { current_password: NEW_PASSWORD, new_password: THIRD },
  });
  check('從 KV 驗證舊密碼並修改 → 200', r.status === 200, `實際 ${r.status}`);
  check('回報 source=kv（這次是從 KV 驗證的）', r.json.source === 'kv', `實際 ${r.json.source}`);

  check('第三次密碼可登入', (await api('POST', '/api/login', { body: { password: THIRD } })).status === 200);
  check('第二次密碼已失效', (await api('POST', '/api/login', { body: { password: NEW_PASSWORD } })).status === 401);
}

console.log('\n=== ⑧ 環境密鑰移除後仍可運作（真實部署情境）===');
{
  // 模擬維運者之後把 ADMIN_PASSWORD_HASH 刪掉 —— 只要 KV 有值就該正常
  const envNoKey = { ...env, ADMIN_PASSWORD_HASH: undefined };
  const req = new Request(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'Zq7#vN4w-Rt9-Km' }),
  });
  const resp = await worker.fetch(req, envNoKey);
  check('無環境密鑰但 KV 有值 → 仍可登入', resp.status === 200, `實際 ${resp.status}`);

  // 反之：KV 無值且環境密鑰也無 → 應回 500（設定問題，不是密碼錯）
  const emptyKV = makeKV();
  const envNeither = { ...env, DATA: emptyKV, ADMIN_PASSWORD_HASH: undefined };
  const req2 = new Request(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'anything' }),
  });
  const resp2 = await worker.fetch(req2, envNeither);
  check('兩處都沒設定 → 500（明確的設定錯誤）', resp2.status === 500, `實際 ${resp2.status}`);
}

console.log('\n=== ⑨ KV 讀取失敗時的回落 ===');
{
  // KV 讀取拋錯時，應退回環境密鑰而不是整個壞掉
  const brokenKV = {
    ...makeKV(),
    async get() { throw new Error('KV unavailable'); },
    async put() {},
    async delete() {},
    async list() { return { keys: [], list_complete: true }; },
  };
  const envBroken = { ...env, DATA: brokenKV };
  const req = new Request(`http://127.0.0.1:${PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ENV_PASSWORD }),
  });
  const resp = await worker.fetch(req, envBroken);
  check('KV 故障時回落到環境密鑰 → 200', resp.status === 200, `實際 ${resp.status}`);
}

/* ---------- 收尾 ---------- */
server.close();

console.log(`\n通過 ${pass} 項，失敗 ${fail} 項\n`);
process.exit(fail === 0 ? 0 : 1);
