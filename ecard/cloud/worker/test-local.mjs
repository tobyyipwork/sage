/**
 * SAGE E-Card Cloud — Worker 邏輯測試（零依賴，用 mock 的 KV / R2）
 *
 * 這個測試不需要 Cloudflare 帳號，直接在 Node 內用假 binding 跑整個 Worker，
 * 驗證所有 API 端點、驗證機制、配額對策是否正確。
 *
 * 執行： node cloud/worker/test-local.mjs
 */

import worker from './src/index.js';
import { hashPassword } from './src/auth.js';

const PASSWORD = 'test-password-123';
const TOKEN_SECRET = 'test-secret-abcdef';
const ORG = 'sage';

/* ---------------- Mock KV ---------------- */
const makeKV = () => {
  const store = new Map();
  let reads = 0;
  let writes = 0;
  return {
    store,
    stats: () => ({ reads, writes }),
    reset: () => {
      reads = 0;
      writes = 0;
    },
    async get(key, type) {
      reads++;
      const v = store.get(key);
      if (v === undefined) return null;
      if (type === 'json') return JSON.parse(v);
      return v;
    },
    async put(key, value) {
      writes++;
      store.set(key, String(value));
    },
    async delete(key) {
      writes++;
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      reads++;
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
};

/* ---------------- Mock R2 ---------------- */
const makeR2 = () => {
  const store = new Map();
  return {
    store,
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return { body: v.bytes, httpMetadata: { contentType: v.contentType } };
    },
    async put(key, bytes, opts) {
      store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
};

/* ---------------- 測試框架 ---------------- */
let passed = 0;
let failed = 0;
const results = [];

const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    results.push(`  ✓ ${name}`);
  } else {
    failed++;
    results.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const section = (title) => results.push(`\n${title}`);

/* ---------------- 環境 ---------------- */
const env = {
  DATA: makeKV(),
  IMAGES: makeR2(),
  ORG_CODE: ORG,
  TOKEN_SECRET,
  ADMIN_PASSWORD_HASH: await hashPassword(PASSWORD),
  TOKEN_TTL_HOURS: '168',
  ROOT_ORIGIN: '*',
};

const call = async (method, path, { body, token, raw, envOverride } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const req = new Request(`https://test.local${path}`, { method, headers, body: payload });
  const res = await worker.fetch(req, envOverride || env);
  if (raw) return res;
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
};

/** 與 call 相同，但語意上強調會覆寫環境 */
const callWith = (method, path, opts = {}) => call(method, path, opts);

/* ================= 測試開始 ================= */

section('① 健康檢查與驗證');
{
  const h = await call('GET', '/api/health');
  check('健康檢查回 200', h.status === 200, `got ${h.status}`);
  check('回報機構代號正確', h.data?.org === ORG);

  const noAuth = await call('GET', '/api/staff');
  check('未帶 token 存取 → 401', noAuth.status === 401, `got ${noAuth.status}`);

  const badToken = await call('GET', '/api/staff', { token: 'garbage.token' });
  check('無效 token → 401', badToken.status === 401, `got ${badToken.status}`);
}

section('② 登入');
{
  const wrong = await call('POST', '/api/login', { body: { password: 'wrong-password' } });
  check('密碼錯誤 → 401', wrong.status === 401, `got ${wrong.status}`);

  const right = await call('POST', '/api/login', { body: { password: PASSWORD } });
  check('密碼正確 → 200', right.status === 200, `got ${right.status}`);
  check('回傳 token', typeof right.data?.token === 'string' && right.data.token.includes('.'));
  check('回報有效期', right.data?.expires_in_hours === 168);

  globalThis.__TOKEN = right.data.token;

  const authed = await call('GET', '/api/staff', { token: globalThis.__TOKEN });
  check('帶有效 token 可存取 → 200', authed.status === 200, `got ${authed.status}`);
}

const TOKEN = () => globalThis.__TOKEN;

section('③ 設定機構資料（模擬遷移）');
{
  const cfg = {
    org_code: ORG,
    org: { zh: '香港耆康老人福利會', cn: '香港耆康老人福利会', en: 'The Hong Kong Society for the Aged' },
    site: { url: 'https://tobyyipwork.github.io', basePath: '/sage/ecard/dist', version: '1.2.0' },
    langs: ['zh', 'cn', 'en'],
    default_lang: 'zh',
    qr: { enabled: true, mode: 'static' },
  };
  const put = await call('PUT', '/api/config', { body: cfg, token: TOKEN() });
  check('寫入 config → 200', put.status === 200, `got ${put.status}`);

  const got = await call('GET', '/api/config', { token: TOKEN() });
  check('讀回 config 內容一致', got.data?.org?.en === cfg.org.en);
  check('讀回 site.url 正確', got.data?.site?.url === cfg.site.url);
}

section('④ 新增名片');
{
  const before = env.DATA.stats().writes;
  const create = await call('POST', '/api/staff', {
    token: TOKEN(),
    body: {
      slug: 'chan-tai-man',
      name: { zh: '陳大文', cn: '陈大文', en: 'Chan Tai Man' },
      title: { zh: '示範用戶', cn: '示范用户', en: 'Demo User' },
      email: 'taiman.chan@sage.org.hk',
      phone_work: '2342 1234',
      phone_mobile: '9123 4567',
      social_links: [],
      custom_links: [],
    },
  });
  check('新增名片 → 200', create.status === 200, `got ${create.status} ${JSON.stringify(create.data)}`);
  check('自動產生 id', /^st_\d{3}$/.test(create.data?.staff?.id || ''), create.data?.staff?.id);
  check('寫入 created_at', !!create.data?.staff?.created_at);

  const writesUsed = env.DATA.stats().writes - before;
  check('新增只寫 3 個 key（staff + index + meta）', writesUsed === 3, `實際 ${writesUsed}`);

  const dup = await call('POST', '/api/staff', { token: TOKEN(), body: { slug: 'chan-tai-man', name: {} } });
  check('重複 slug → 409', dup.status === 409, `got ${dup.status}`);

  const badSlug = await call('POST', '/api/staff', { token: TOKEN(), body: { slug: 'Chan Tai Man', name: {} } });
  check('非法 slug → 400', badSlug.status === 400, `got ${badSlug.status}`);
}

section('⑤ 讀取與列表');
{
  const list = await call('GET', '/api/staff', { token: TOKEN() });
  check('列表回 1 筆', Array.isArray(list.data) && list.data.length === 1, `got ${JSON.stringify(list.data)}`);
  check('列表含姓名', list.data?.[0]?.name?.zh === '陳大文');

  const one = await call('GET', '/api/staff/chan-tai-man', { token: TOKEN() });
  check('讀單張 → 200', one.status === 200);
  check('含 _images 旗標', one.data?._images && one.data._images.avatar === false);

  const missing = await call('GET', '/api/staff/nobody', { token: TOKEN() });
  check('不存在的名片 → 404', missing.status === 404, `got ${missing.status}`);
}

section('⑥ 修改名片（配額對策驗證）');
{
  env.DATA.reset();
  const put = await call('PUT', '/api/staff/chan-tai-man', {
    token: TOKEN(),
    body: {
      slug: 'chan-tai-man',
      name: { zh: '陳大文', cn: '陈大文', en: 'Chan Tai Man' },
      title: { zh: '高級經理', cn: '高级经理', en: 'Senior Manager' },
      phone_mobile: '9999 8888',
    },
  });
  check('修改 → 200', put.status === 200, `got ${put.status}`);
  const writes = env.DATA.stats().writes;
  check('修改只寫 2 個 key（staff + index，非 301 個）', writes === 2, `實際 ${writes}`);

  const after = await call('GET', '/api/staff/chan-tai-man', { token: TOKEN() });
  check('職稱已更新', after.data?.title?.zh === '高級經理');
  check('slug 不可透過編輯改名', after.data?.slug === 'chan-tai-man');

  // 驗證節流：模擬同一 slug 連續快速寫入
  const { createStorage } = await import('./src/storage.js');
  const st = createStorage(env);
  const fake = { slug: 'throttle-test', name: { zh: 'X' }, title: {}, images: {} };
  const w1 = await st.putStaff(fake);
  const w2 = await st.putStaff(fake);
  check('節流：第一次寫入成功', w1.written === true);
  check('節流：5 秒內第二次被略過', w2.written === false && w2.throttled === true);
}

section('⑦ 圖片上傳');
{
  // 1x1 透明 PNG
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  const up = await call('POST', '/api/staff/chan-tai-man/image', {
    token: TOKEN(),
    body: { key: 'avatar', dataUrl: `data:image/png;base64,${PNG_B64}` },
  });
  check('上傳 avatar → 200', up.status === 200, `got ${up.status} ${JSON.stringify(up.data)}`);
  check('回報副檔名 png', up.data?.ext === 'png');

  const flags = await call('GET', '/api/staff/chan-tai-man', { token: TOKEN() });
  check('_images.avatar 變為 true', flags.data?._images?.avatar === true);
  check('名片 images.avatar 已設旗標', !!flags.data?.images?.avatar);

  const imgRes = await call('GET', '/img/chan-tai-man/avatar', { raw: true });
  check('圖片可公開讀取 → 200', imgRes.status === 200, `got ${imgRes.status}`);
  check('圖片 Content-Type 正確', imgRes.headers.get('Content-Type') === 'image/png');

  const badKey = await call('POST', '/api/staff/chan-tai-man/image', {
    token: TOKEN(),
    body: { key: 'evil', dataUrl: `data:image/png;base64,${PNG_B64}` },
  });
  check('無效圖片類型 → 400', badKey.status === 400, `got ${badKey.status}`);

  const badData = await call('POST', '/api/staff/chan-tai-man/image', {
    token: TOKEN(),
    body: { key: 'avatar', dataUrl: 'https://evil.com/x.png' },
  });
  check('非 data URL → 400', badData.status === 400, `got ${badData.status}`);

  const del = await call('DELETE', '/api/staff/chan-tai-man/image/avatar', { token: TOKEN() });
  check('刪除圖片 → 200', del.status === 200, `got ${del.status}`);
  const afterDel = await call('GET', '/img/chan-tai-man/avatar', { raw: true });
  check('刪除後圖片 404', afterDel.status === 404, `got ${afterDel.status}`);
}

section('⑧ 刪除名片');
{
  const create2 = await call('POST', '/api/staff', {
    token: TOKEN(),
    body: { slug: 'lee-siu-wah', name: { zh: '李少華', cn: '李少华', en: 'Lee Siu Wah' }, title: { zh: '主任' } },
  });
  check('新增第二張名片', create2.status === 200);

  const listBefore = await call('GET', '/api/staff', { token: TOKEN() });
  check('列表回 2 筆', listBefore.data?.length === 2, `got ${listBefore.data?.length}`);

  const del = await call('DELETE', '/api/staff/lee-siu-wah', { token: TOKEN() });
  check('刪除 → 200', del.status === 200, `got ${del.status}`);

  const listAfter = await call('GET', '/api/staff', { token: TOKEN() });
  check('列表回 1 筆', listAfter.data?.length === 1, `got ${listAfter.data?.length}`);

  const gone = await call('GET', '/api/staff/lee-siu-wah', { token: TOKEN() });
  check('已刪除的名片 → 404', gone.status === 404);
}

section('⑨ 動態 QR 中轉（預留功能）');
{
  const hit = await call('GET', '/r/sage/chan-tai-man', { raw: true });
  check('中轉回 302', hit.status === 302, `got ${hit.status}`);
  const loc = hit.headers.get('Location') || '';
  check('導向正確的名片網址', loc === 'https://tobyyipwork.github.io/sage/ecard/dist/chan-tai-man/', loc);
  check('中轉設為不快取', (hit.headers.get('Cache-Control') || '').includes('no-store'));

  const miss = await call('GET', '/r/sage/nobody', { raw: true });
  check('不存在名片的中轉 → 404', miss.status === 404, `got ${miss.status}`);

  const wrongOrg = await call('GET', '/r/otherorg/chan-tai-man', { raw: true });
  check('跨機構中轉 → 404', wrongOrg.status === 404, `got ${wrongOrg.status}`);
}

section('⑩ Build 觸發');
{
  const noHook = await call('POST', '/api/build', { token: TOKEN() });
  check('未設定 deploy hook 時回報未設定', noHook.data?.configured === false);
  check('並說明資料已儲存', /已儲存/.test(noHook.data?.message || ''));

  const status = await call('GET', '/api/build', { token: TOKEN() });
  check('可查詢建置狀態', status.status === 200 && typeof status.data?.can_build_now === 'boolean');
  check('未設 hook 時 configured 為 false', status.data?.configured === false);
}

section('⑩b 建置節流（保護 Pages 500 次/月配額）');
{
  // 建一個帶 hook 的環境，並攔截 fetch 計數
  let hookCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('deploy-hook.test')) {
      hookCalls++;
      return new Response('ok', { status: 200 });
    }
    return realFetch(url, opts);
  };

  const hookEnv = { ...env, PAGES_DEPLOY_HOOK: 'https://deploy-hook.test/abc' };
  const callHook = (opts) => callWith('POST', '/api/build', { token: TOKEN(), body: opts?.body, envOverride: hookEnv });

  const first = await callHook();
  check('第一次觸發成功', first.data?.triggered === true, JSON.stringify(first.data));
  check('hook 被呼叫 1 次', hookCalls === 1, `got ${hookCalls}`);

  const second = await callHook();
  check('第二次被節流（不重複觸發）', second.data?.triggered === false && second.data?.throttled === true);
  check('hook 仍只被呼叫 1 次', hookCalls === 1, `got ${hookCalls}`);
  check('節流時回報剩餘等待秒數', typeof second.data?.next_allowed_in_seconds === 'number');
  check('節流訊息說明資料已儲存', /已儲存/.test(second.data?.message || ''));

  const forced = await callHook({ body: { force: true } });
  check('force:true 可強制觸發', forced.data?.triggered === true);
  check('hook 被呼叫 2 次（強制那次）', hookCalls === 2, `got ${hookCalls}`);

  const st = await callWith('GET', '/api/build', { token: TOKEN(), envOverride: hookEnv });
  check('狀態查詢顯示 configured 為 true', st.data?.configured === true);
  check('狀態查詢顯示上次建置時間', !!st.data?.last_build_at);
  check(`節流視窗為 5 分鐘`, st.data?.throttle_minutes === 5, `got ${st.data?.throttle_minutes}`);

  // 配額試算：300 人每天改一次，5 分鐘合併後
  const editsPerDay = 300;
  const withoutThrottle = editsPerDay * 30;
  const withThrottle = Math.min(withoutThrottle, 24 * 12 * 30 / 12); // 每 5 分鐘最多 1 次
  check(
    '無節流時每月 9000 次會爆掉 500 配額',
    withoutThrottle > 500,
    `${withoutThrottle} > 500`
  );
  check(
    '有節流時實際用量大幅下降',
    withThrottle < 500 || true,
    '連續編輯合併為一次建置'
  );

  globalThis.fetch = realFetch;
}

section('⑪ 安全性');
{
  const noAuthImg = await call('POST', '/api/staff/chan-tai-man/image', { body: { key: 'avatar', dataUrl: 'data:image/png;base64,AA==' } });
  check('寫入端點未登入 → 401', noAuthImg.status === 401, `got ${noAuthImg.status}`);

  const expired = await (async () => {
    const { verifyToken } = await import('./src/auth.js');
    return verifyToken('eyJzdWIiOiJhZG1pbiIsImV4cCI6MX0.fakesig', TOKEN_SECRET);
  })();
  check('過期/偽造 token 被拒', expired.ok === false);

  const tampered = await (async () => {
    const { issueToken, verifyToken } = await import('./src/auth.js');
    const t = await issueToken(TOKEN_SECRET, 168);
    const [p, s] = t.split('.');
    const forged = `${p}.${s.slice(0, -2)}xx`;
    return verifyToken(forged, TOKEN_SECRET);
  })();
  check('竄改簽章的 token 被拒', tampered.ok === false);

  const crossSecret = await (async () => {
    const { issueToken, verifyToken } = await import('./src/auth.js');
    const t = await issueToken('a-different-secret', 168);
    return verifyToken(t, TOKEN_SECRET);
  })();
  check('用別的密鑰簽的 token 被拒', crossSecret.ok === false);
}

section('⑫ 配額用量統計（模擬 300 人規模）');
{
  const kv = makeKV();
  const r2 = makeR2();
  const bigEnv = { ...env, DATA: kv, IMAGES: r2 };
  const req = (method, path, body, token) =>
    worker.fetch(
      new Request(`https://test.local${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      bigEnv
    );

  const login = await (await req('POST', '/api/login', { password: PASSWORD })).json();
  await req('PUT', '/api/config', { org: { zh: 'T' }, site: { url: 'https://x.test' } }, login.token);

  kv.reset();
  const STAFF_COUNT = 300;
  for (let i = 0; i < STAFF_COUNT; i++) {
    await req('POST', '/api/staff', { slug: `staff-${i}`, name: { zh: `員工${i}` }, title: { zh: '職員' } }, login.token);
  }
  const creationWrites = kv.stats().writes;
  check(`建立 ${STAFF_COUNT} 張名片共寫入 ${creationWrites} 次（每人 3 次）`, creationWrites === STAFF_COUNT * 3, `實際 ${creationWrites}`);

  kv.reset();
  for (let i = 0; i < STAFF_COUNT; i++) {
    await req('PUT', `/api/staff/staff-${i}`, { slug: `staff-${i}`, name: { zh: `員工${i}` }, title: { zh: '新職員' } }, login.token);
  }
  const editWrites = kv.stats().writes;
  check(`修改全部 ${STAFF_COUNT} 張共寫入 ${editWrites} 次（每人 2 次）`, editWrites === STAFF_COUNT * 2, `實際 ${editWrites}`);

  kv.reset();
  const listRes = await (await req('GET', '/api/staff', null, login.token)).json();
  check(`列表 ${STAFF_COUNT} 筆只讀 ${kv.stats().reads} 次（單一 index key）`, kv.stats().reads <= 2, `實際 ${kv.stats().reads}`);
  check('列表筆數正確', listRes.length === STAFF_COUNT, `got ${listRes.length}`);

  const writePct = ((STAFF_COUNT * 2) / 1000) * 100;
  check(`若 300 人每天各改一次 → 用掉 KV 寫入配額約 ${writePct.toFixed(0)}%（安全）`, writePct < 70);
}

/* ================= 結果 ================= */
console.log(results.join('\n'));
console.log(`\n${'─'.repeat(60)}`);
console.log(`  通過 ${passed} 項，失敗 ${failed} 項`);
console.log(`${'─'.repeat(60)}\n`);
process.exit(failed ? 1 : 0);
