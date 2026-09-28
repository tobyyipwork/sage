/**
 * SAGE E-Card Cloud — 驗證層
 *
 * 設計目標：
 *  - 密碼絕不以明文存在任何地方（一律存 SHA-256 雜湊）
 *  - 登入成功後發一張 HMAC 簽章的通行證（token），有效期可設定
 *  - 通行證自帶到期時間，Worker 不需查任何儲存即可驗證（無狀態）
 *
 * ── 密碼來源的演進（2026-09）──────────────────────────────
 *
 *   原本：只能讀 env.ADMIN_PASSWORD_HASH，
 *         機構無法自助改密碼（要開發者下 wrangler secret put）。
 *
 *   現在：優先讀 KV auth:{org}:password，讀不到才回落環境密鑰。
 *         機構可在後台網頁自行修改密碼。
 *
 *   回落機制的必要性：升級當下 KV 還沒有值，
 *   若不回落，既有機構會立刻無法登入。
 *
 * ── 未來升級到方案 B（Email 驗證碼）───────────────────────
 *   只需替換 verifyLogin，其餘程式碼完全不用動。
 *   儲存層已預留 users:{org} 作為授權 email 名單。
 */

const enc = new TextEncoder();

/* ---------- base64url 編解碼（無依賴） ---------- */
const b64urlEncode = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (str) => {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/* ---------- 雜湊 ---------- */
const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const importHmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/* ---------- 通行證（token）---------- */
const sign = async (payloadStr, secret) => {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadStr));
  return b64urlEncode(new Uint8Array(sig));
};

/**
 * 產生通行證： base64url(payload) + "." + base64url(hmac)
 * payload = { sub: "admin", exp: <unix 秒> }
 */
export const issueToken = async (secret, ttlHours = 168) => {
  const payload = { sub: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlHours * 3600 };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(enc.encode(payloadStr));
  const signature = await sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
};

/**
 * 驗證通行證。回傳 { ok: true, payload } 或 { ok: false, reason }
 */
export const verifyToken = async (token, secret) => {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'no token' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, signature] = parts;

  // 簽章比對（時序安全比較）
  const expected = await sign(payloadB64, secret);
  if (expected.length !== signature.length) return { ok: false, reason: 'bad signature' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'bad signature' };

  // 解 payload
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
  } catch {
    return { ok: false, reason: 'bad payload' };
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
};

/* ---------- 登入 ---------- */
/**
 * 比對密碼。
 *
 * 密碼來源有兩處，優先順序如下：
 *   ① KV  auth:{org}:password        （第 1 層：可由網頁自助修改）
 *   ② env ADMIN_PASSWORD_HASH        （舊機制：只能 CLI 修改）
 *
 * 為什麼要保留 ② 的回落？
 *   這是**向後相容的關鍵**。若移除回落，本次升級後
 *   「尚未在網頁改過密碼」的機構會立刻無法登入 ——
 *   因為 KV 裡還沒有值。
 *   有了回落，機構可以照自己的步調遷移：
 *   第一次在網頁改密碼時才會寫入 KV，之後就以 KV 為準。
 *
 * 使用時序安全比較，避免以回應時間推測密碼。
 *
 * @param {string} password  使用者輸入
 * @param {object} env       Worker 環境
 * @param {object} [storage] 儲存層（未提供時只檢查環境密鑰，維持舊行為）
 */
export const verifyLogin = async (password, env, storage = null) => {
  const input = await sha256Hex(String(password || ''));

  /* ① 先看 KV 是否已有設定 */
  if (storage && typeof storage.getPasswordRecord === 'function') {
    let rec = null;
    try {
      rec = await storage.getPasswordRecord();
    } catch {
      rec = null;   // KV 讀取失敗時退回環境密鑰，不讓登入整個壞掉
    }
    if (rec && rec.hash) {
      const stored = String(rec.hash).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(stored)) {
        return { ok: false, reason: 'server not configured: KV 中的密碼雜湊格式錯誤' };
      }
      return timingSafeEqualHex(input, stored)
        ? { ok: true, source: 'kv' }
        : { ok: false, reason: 'wrong password' };
    }
  }

  /* ② 回落：環境密鑰 */
  const stored = String(env.ADMIN_PASSWORD_HASH || '').trim().toLowerCase();
  if (!stored || !/^[0-9a-f]{64}$/.test(stored)) {
    return { ok: false, reason: 'server not configured: ADMIN_PASSWORD_HASH 未設定或格式錯誤' };
  }
  return timingSafeEqualHex(input, stored)
    ? { ok: true, source: 'env' }
    : { ok: false, reason: 'wrong password' };
};

/** 時序安全的十六進位字串比較 */
const timingSafeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/* ---------- 中介層 ---------- */
/** 從 Authorization: Bearer <token> 取出並驗證；失敗回傳 null */
export const authenticate = async (request, env) => {
  const header = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const result = await verifyToken(m[1], env.TOKEN_SECRET || '');
  return result.ok ? result.payload : null;
};

/* ---------- 工具：產生密碼雜湊（供 make-password.js 使用同一邏輯）---------- */
export const hashPassword = sha256Hex;
