/**
 * SAGE E-Card Cloud — Worker 主程式
 *
 * 這是「自己開發的雲端後台」的後端。零依賴、單檔部署。
 *
 * API（本專案唯一的後台後端；管理介面在 admin/public/index.html）
 *   POST   /api/login                        登入，回傳 token（公開）
 *   GET    /api/config                       讀機構設定
 *   PUT    /api/config                       改機構設定
 *   GET    /api/staff                        名片列表（讀 index，一次讀取）
 *   POST   /api/staff                        新增名片
 *   GET    /api/staff/:slug                  讀單張名片
 *   PUT    /api/staff/:slug                  修改名片
 *   DELETE /api/staff/:slug                  刪除名片
 *   POST   /api/staff/:slug/image            上傳圖片
 *   DELETE /api/staff/:slug/image/:key       刪除圖片
 *   POST   /api/build                        觸發重新生成 + 部署
 *   GET    /api/health                       健康檢查（公開）
 *   GET    /img/:slug/:key                   圖片讀取（公開，前台名片用）
 *   GET    /r/:org/:slug                     動態 QR 中轉（公開，第三階段）
 *
 * 部署： wrangler deploy
 */

import { authenticate, issueToken, verifyLogin } from './auth.js';
import { createStorage, mimeFor } from './storage.js';
import { sanitizeStaff } from './staff-schema.js';
import { handleRedirect } from './redirect.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 單張圖片 5MB

/* ---------------- 回應工具 ---------------- */
const CORS = (env) => ({
  'Access-Control-Allow-Origin': env.ROOT_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
});

const json = (obj, status = 200, env, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS(env), ...extra },
  });

const err = (status, message, env, extra = {}) => json({ error: message }, status, env, extra);

const jsonBody = async (request) => {
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error('請求內容不是合法 JSON'), { status: 400 });
  }
};

/* ---------------- 路由比對 ---------------- */
const matchRoute = (method, pathname, routes) => {
  for (const [route, fn] of Object.entries(routes)) {
    const [routeMethod, pattern] = route.split(' ');
    if (routeMethod !== method) continue;
    const pparts = pattern.split('/').filter(Boolean);
    const uparts = pathname.split('/').filter(Boolean);
    if (uparts.length !== pparts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pparts.length; i++) {
      if (pparts[i].startsWith(':')) params[pparts[i].slice(1)] = decodeURIComponent(uparts[i]);
      else if (pparts[i] !== uparts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { fn, params };
  }
  return null;
};

/* ---------------- 主程式 ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS 預檢
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS(env) });

    const storage = createStorage(env);

    try {
      /* ---------- 公開路由（不需驗證）---------- */

      if (pathname === '/api/health') {
        return json(
          {
            ok: true,
            org: storage.ORG,
            image_mode: storage.imageMode, // 'r2' 或 'kv'
            time: new Date().toISOString(),
          },
          200,
          env
        );
      }

      if (pathname === '/api/login' && method === 'POST') {
        const body = await jsonBody(request);
        const result = await verifyLogin(body.password, env);
        if (!result.ok) {
          // 不透露是「密碼錯」還是「未設定」以外的細節
          const status = result.reason.startsWith('server not configured') ? 500 : 401;
          return err(status, status === 500 ? result.reason : '密碼錯誤', env);
        }
        const ttl = Number(env.TOKEN_TTL_HOURS) || 168;
        const token = await issueToken(env.TOKEN_SECRET || '', ttl);
        return json({ ok: true, token, expires_in_hours: ttl }, 200, env);
      }

      // 圖片讀取（前台名片頁、後台預覽都用這個）
      const imgMatch = /^\/img\/([a-z0-9-]+)\/([a-z0-9_]+)\/?$/.exec(pathname);
      if (imgMatch && (method === 'GET' || method === 'HEAD')) {
        const img = await storage.getImage(imgMatch[1], imgMatch[2]);
        if (!img) return err(404, 'no image', env);
        return new Response(img.body, {
          status: 200,
          headers: {
            'Content-Type': img.contentType,
            'Cache-Control': 'public, max-age=300',
            ...CORS(env),
          },
        });
      }

      // 動態 QR 中轉（第三階段）
      const redirectResponse = await handleRedirect(request, env, storage, pathname);
      if (redirectResponse) return redirectResponse;

      /* ---------- 以下皆需驗證 ---------- */

      if (!pathname.startsWith('/api/')) {
        return err(404, 'not found', env);
      }

      const session = await authenticate(request, env);
      if (!session) return err(401, '未登入或通行證已過期', env);

      /* ---------- 路由表 ---------- */
      const routes = {
        'GET /api/config': async () => {
          const cfg = await storage.getConfig();
          if (!cfg) throw Object.assign(new Error('尚未設定機構資料，請先執行遷移腳本'), { status: 404 });
          return cfg;
        },

        'PUT /api/config': async ({}, request) => {
          const body = await jsonBody(request);
          const cfg = await storage.putConfig(body);
          return { ok: true, config: cfg };
        },

        'GET /api/staff': async () => storage.getIndex(),

        'POST /api/staff': async ({}, request) => {
          const body = await jsonBody(request);
          const slug = String(body.slug || '').trim();
          const exists = await storage.getStaff(slug);
          if (exists) throw Object.assign(new Error('該 slug 已存在'), { status: 409 });

          const meta = await storage.getMeta();
          const nextId = `st_${String((meta.count || 0) + 1).padStart(3, '0')}`;
          const saved = sanitizeStaff(body, { isNew: true, existing: null, nextId });

          await storage.putStaff(saved, { throttle: false });
          await storage.patchIndex(saved);           // 新增 → 更新名單
          await storage.putMeta({ count: (meta.count || 0) + 1, updated_at: saved.updated_at, version: (meta.version || 1) + 1 });

          return { ok: true, staff: saved };
        },

        'GET /api/staff/:slug': async ({ slug }) => {
          const data = await storage.getStaff(slug);
          if (!data) throw Object.assign(new Error('找不到該名片'), { status: 404 });
          data._images = await storage.imageFlags(slug);
          return data;
        },

        'PUT /api/staff/:slug': async ({ slug }, request) => {
          const existing = await storage.getStaff(slug);
          if (!existing) throw Object.assign(new Error('找不到該名片'), { status: 404 });
          const body = await jsonBody(request);
          const saved = sanitizeStaff(body, { isNew: false, existing, nextId: null });
          saved.slug = slug; // slug 是身分識別，不透過編輯改名

          const writeResult = await storage.putStaff(saved);
          if (!writeResult.throttled) {
            await storage.patchIndex(saved);          // 修改 → 更新名單（改內容時仍要同步列表顯示）
          }
          return { ok: true, staff: saved, throttled: !!writeResult.throttled };
        },

        'DELETE /api/staff/:slug': async ({ slug }) => {
          const existing = await storage.getStaff(slug);
          if (!existing) throw Object.assign(new Error('找不到該名片'), { status: 404 });
          await storage.deleteStaff(slug);
          await storage.removeFromIndex(slug);        // 刪除 → 更新名單
          const meta = await storage.getMeta();
          await storage.putMeta({ ...meta, count: Math.max(0, (meta.count || 1) - 1), updated_at: new Date().toISOString() });
          return { ok: true, deleted: slug };
        },

        'POST /api/staff/:slug/image': async ({ slug }, request) => {
          const existing = await storage.getStaff(slug);
          if (!existing) throw Object.assign(new Error('找不到該名片'), { status: 404 });

          const body = await jsonBody(request);
          const key = String(body.key || '');
          if (!storage.IMG_KEYS.includes(key)) throw Object.assign(new Error('無效的圖片類型'), { status: 400 });

          const dataUrl = String(body.dataUrl || '');
          const mm = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
          if (!mm) throw Object.assign(new Error('需為 data:image/...;base64,... 格式'), { status: 400 });

          let ext = mm[1].toLowerCase();
          if (ext === 'jpeg') ext = 'jpg';
          if (!storage.IMG_EXTS.includes(ext)) throw Object.assign(new Error('不支援的圖片格式'), { status: 400 });

          const bytes = Uint8Array.from(atob(mm[2]), (c) => c.charCodeAt(0));
          if (bytes.length > MAX_IMAGE_BYTES) {
            throw Object.assign(new Error('圖片過大（上限 5MB）'), { status: 400 });
          }

          await storage.putImage(slug, key, bytes, ext);
          existing.images = existing.images || {};
          existing.images[key] = key; // truthy flag consumed by build.js
          existing.updated_at = new Date().toISOString();
          // 圖片旗標必須確實寫入，不可被節流略過
          await storage.putStaff(existing, { throttle: false });
          await storage.patchIndex(existing);

          return { ok: true, key, ext, bytes: bytes.length };
        },

        'DELETE /api/staff/:slug/image/:key': async ({ slug, key }) => {
          const existing = await storage.getStaff(slug);
          if (!existing) throw Object.assign(new Error('找不到該名片'), { status: 404 });
          if (!storage.IMG_KEYS.includes(key)) throw Object.assign(new Error('無效的圖片類型'), { status: 400 });

          await storage.deleteImage(slug, key);
          existing.images = existing.images || {};
          existing.images[key] = '';
          existing.updated_at = new Date().toISOString();
          // 圖片旗標必須確實寫入，不可被節流略過
          await storage.putStaff(existing, { throttle: false });
          await storage.patchIndex(existing);

          return { ok: true, key };
        },

        'POST /api/build': async ({}, request) => {
          const hook = env.PAGES_DEPLOY_HOOK;
          if (!hook) {
            return {
              ok: false,
              configured: false,
              message: '尚未設定 PAGES_DEPLOY_HOOK。資料已儲存，但需手動重建前台（見部署文件第二階段）。',
            };
          }

          const body = await request.json().catch(() => ({}));
          const force = body.force === true;

          // 建置節流：視窗內的重複觸發合併為一次。
          // Cloudflare Pages 免費版每月僅 500 次建置，若每次編輯都觸發會很快用完。
          // 記在 KV 而非記憶體，避免多個 isolate 各自計時而失效。
          const buildKey = `build:${storage.ORG}:last`;
          const now = Date.now();
          // 可用環境變數調整，預設 5 分鐘；設 0 代表不節流
          const envMin = env.BUILD_THROTTLE_MINUTES;
          const windowMs = (envMin === undefined || envMin === '' ? 5 : Number(envMin)) * 60 * 1000;

          if (!force && windowMs > 0) {
            const last = await storage.getJson(buildKey);
            if (last && last.at && now - last.at < windowMs) {
              const waitSec = Math.ceil((windowMs - (now - last.at)) / 1000);
              return {
                ok: true,
                configured: true,
                triggered: false,
                throttled: true,
                message: `近期已觸發過建置，略過本次以節省配額（${waitSec} 秒後可再觸發）。資料已儲存。`,
                next_allowed_in_seconds: waitSec,
              };
            }
          }

          const res = await fetch(hook, { method: 'POST' });
          if (!res.ok) {
            throw Object.assign(new Error(`觸發部署失敗（HTTP ${res.status}）`), { status: 502 });
          }

          // 記錄觸發時間（節流用；寫入失敗不影響主要流程）
          try {
            await storage.putJson(buildKey, { at: now });
          } catch {
            /* 忽略 */
          }

          return {
            ok: true,
            configured: true,
            triggered: true,
            throttled: false,
            message: '已觸發前台重建，約 30–60 秒後生效',
          };
        },

        // 查詢建置狀態（供後台顯示「上次發佈時間」）
        'GET /api/build': async () => {
          const last = await storage.getJson(`build:${storage.ORG}:last`);
          const envMin = env.BUILD_THROTTLE_MINUTES;
          const minutes = envMin === undefined || envMin === '' ? 5 : Number(envMin);
          const windowMs = minutes * 60 * 1000;
          const now = Date.now();
          const canBuildNow = windowMs <= 0 || !last || !last.at || now - last.at >= windowMs;
          return {
            configured: !!env.PAGES_DEPLOY_HOOK,
            last_build_at: last && last.at ? new Date(last.at).toISOString() : null,
            throttle_minutes: minutes,
            can_build_now: canBuildNow,
          };
        },
      };

      const matched = matchRoute(method, pathname, routes);
      if (!matched) return err(404, 'API 路徑不存在', env);

      const result = await matched.fn(matched.params, request);
      return json(result, 200, env);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      const message = e && e.message ? e.message : '伺服器錯誤';
      return err(status, message, env);
    }
  },
};
