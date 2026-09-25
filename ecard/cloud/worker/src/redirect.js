/**
 * SAGE E-Card Cloud — 動態 QR 中轉（第三階段功能，目前預留）
 *
 * 用途：QR 卡片編碼的是 「穩定」的中轉網址，例如
 *          https://qr.sage.org.hk/r/sage/chan-tai-man
 *       中轉層再 302 到「當前」的正式名片網址。
 *       這樣將來換網域、換部署平台，已印出的實體卡片永遠有效。
 *
 * 啟用方式：
 *   1. 在 config.json 設定 qr.mode = "dynamic"、qr.base = 你的 Worker 網域
 *   2. 重新 build，所有 QR 就會改成編碼中轉網址
 *   3. 本路由會自動生效（不需改程式碼）
 *
 * 對照表來源：直接讀 KV 的 config:{org}，取其 site.url + basePath，
 *            所以改網域只需改一個 KV 值，不必重新部署 Worker。
 */

/**
 * @returns {Response|null} 若是中轉請求則回傳 302，否則回傳 null 讓其他路由處理
 */
export const handleRedirect = async (request, env, storage, pathname) => {
  const m = /^\/r\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/i.exec(pathname);
  if (!m) return null;

  const [, org, slug] = m;
  const config = await storage.getConfig();

  if (!config) {
    return new Response('中轉服務尚未設定（找不到機構設定）', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // 只允許存取本機構（避免跨機構探測）
  const thisOrg = env.ORG_CODE || 'sage';
  if (org !== thisOrg) {
    return new Response('找不到此機構', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // 名片必須存在且啟用
  const staff = await storage.getStaff(slug);
  if (!staff || staff.active === false) {
    return new Response('找不到此名片', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // 由 config 組出當前正式網址 —— 換網域時只改 config，QR 不受影響
  const siteUrl = String(config.site?.url || '').replace(/\/+$/, '');
  const basePath = String(config.site?.basePath || '').replace(/\/+$/, '');
  const defaultLang = config.default_lang || 'zh';
  const langSuffix = defaultLang === (config.langs?.[0] || 'zh') ? '' : `/${defaultLang}`;

  if (!siteUrl) {
    return new Response('機構設定缺少 site.url，無法中轉', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const target = `${siteUrl}${basePath}/${slug}${langSuffix}/`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      // 中轉必須「不」被長期快取，否則改網域後舊快取會持續把人帶去舊位址
      'Cache-Control': 'no-store, must-revalidate',
    },
  });
};
