/**
 * SAGE E-Card Cloud — 儲存層
 *
 * 職責：封裝 KV（JSON 資料）與圖片儲存的存取，並落實三項配額對策：
 *
 *   ① 只寫單一 key        改一張名片只寫 staff:{org}:{slug}，不重寫整份名單
 *   ② 名單惰性更新         index:{org} 僅在「新增／刪除」時才更新
 *   ③ 寫入節流             同一 slug 在 N 秒內的重複寫入合併為一次
 *
 * Key 命名規則： {類型}:{機構}:{識別碼}
 *   config:sage
 *   staff:sage:chan-tai-man
 *   index:sage
 *   meta:sage
 *   users:sage            （方案 B 預留：授權 email 名單）
 *
 * ── 圖片儲存：雙模式（R2 非必需）──────────────────────────────
 *
 *   模式 A  R2 物件儲存      需綁信用卡才能開通
 *     物件鍵： {機構}/{slug}/{key}.{ext}
 *
 *   模式 B  KV（base64）     不需綁卡、零額外設定
 *     key：   img:{機構}:{slug}:{key}.{ext}
 *
 * 由 env.IMAGES 是否存在自動判斷。沒有 R2 就自動走 KV，
 * 路由、前台網址、後台程式碼完全不用改。
 *
 * 兩模式差異：
 *   R2   單張圖可到 MB 級、走 CDN 邊緣、不佔 KV 寫入配額
 *   KV   每值上限 25MB（本專案限制 5MB）、免費 1000 寫入/日、
 *        讀取計入 KV 的 100,000 次/日配額。對本專案規模完全夠用。
 */

const IMG_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const IMG_KEYS = ['banner', 'avatar', 'wechat_qr'];

/* ---------- 節流：同一 key 在視窗內的重複寫入合併 ---------- */
const WRITE_THROTTLE_MS = 5000;
const lastWrite = new Map(); // key -> timestamp（僅存活於單一 isolate，屬盡力而為）

const shouldSkipWrite = (key) => {
  const now = Date.now();
  const prev = lastWrite.get(key);
  if (prev && now - prev < WRITE_THROTTLE_MS) return true;
  lastWrite.set(key, now);
  // 防止 Map 無限成長
  if (lastWrite.size > 500) {
    for (const [k, t] of lastWrite) if (now - t > WRITE_THROTTLE_MS * 4) lastWrite.delete(k);
  }
  return false;
};

/* ---------- base64 ↔ 位元組（Workers 環境無 Buffer） ---------- */
const bytesToB64 = (bytes) => {
  let bin = '';
  const CHUNK = 0x8000; // 分批避免超出參數上限
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* ---------- 建構子 ---------- */
export const createStorage = (env) => {
  const KV = env.DATA;
  const R2 = env.IMAGES || null; // 未綁定 R2 → null，自動走 KV 模式
  const ORG = env.ORG_CODE || 'sage';

  const kConfig = () => `config:${ORG}`;
  const kIndex = () => `index:${ORG}`;
  const kMeta = () => `meta:${ORG}`;
  const kStaff = (slug) => `staff:${ORG}:${slug}`;
  const r2Key = (slug, key, ext) => `${ORG}/${slug}/${key}.${ext}`;
  const r2Prefix = (slug) => `${ORG}/${slug}/`;
  const kvImgKey = (slug, key, ext) => `img:${ORG}:${slug}:${key}.${ext}`;

  /* ---------- JSON 讀寫 ---------- */
  const getJson = async (key) => {
    const raw = await KV.get(key, 'json');
    return raw || null;
  };

  const putJson = async (key, obj) => {
    await KV.put(key, JSON.stringify(obj));
  };

  /** 刪除單一 key（用於清除標記類資料，例如重建的 pending 狀態） */
  const deleteJson = async (key) => {
    await KV.delete(key);
  };

  /* ---------- config ---------- */
  const getConfig = () => getJson(kConfig());

  const putConfig = async (cfg) => {
    await putJson(kConfig(), cfg);
    return cfg;
  };

  /* ---------- 名單（index） ---------- */
  /**
   * index 內容： [{ slug, name, title, active, has_avatar }]
   * 列表頁只需讀這一個 key，避免打 300 次 KV 讀取。
   */
  const getIndex = async () => (await getJson(kIndex())) || [];

  const rebuildIndex = async () => {
    const listing = await KV.list({ prefix: `staff:${ORG}:`, limit: 1000 });
    const entries = await Promise.all(
      listing.keys.map(async ({ name }) => {
        const s = await getJson(name);
        if (!s) return null;
        return {
          slug: s.slug,
          active: s.active !== false,
          name: s.name || {},
          title: s.title || {},
          has_avatar: !!(s.images && s.images.avatar),
        };
      })
    );
    const index = entries.filter(Boolean).sort((a, b) => (a.slug < b.slug ? -1 : 1));
    await putJson(kIndex(), index);
    return index;
  };

  /** 更新名單中的單一項目（改內容時用，避免全量重建） */
  const patchIndex = async (staff) => {
    const index = await getIndex();
    const item = {
      slug: staff.slug,
      active: staff.active !== false,
      name: staff.name || {},
      title: staff.title || {},
      has_avatar: !!(staff.images && staff.images.avatar),
    };
    const at = index.findIndex((i) => i.slug === staff.slug);
    if (at === -1) index.push(item);
    else index[at] = item;
    index.sort((a, b) => (a.slug < b.slug ? -1 : 1));
    await putJson(kIndex(), index);
    return index;
  };

  const removeFromIndex = async (slug) => {
    const index = await getIndex();
    const next = index.filter((i) => i.slug !== slug);
    await putJson(kIndex(), next);
    return next;
  };

  /* ---------- 名片 ---------- */
  const getStaff = (slug) => getJson(kStaff(slug));

  /**
   * 寫入名片。option.throttle=false 可強制寫入（例如圖片旗標異動）。
   * 回傳 { written: boolean } 讓呼叫端知道是否被節流略過。
   */
  const putStaff = async (staff, { throttle = true } = {}) => {
    const key = kStaff(staff.slug);
    if (throttle && shouldSkipWrite(key)) return { written: false, throttled: true };
    await putJson(key, staff);
    return { written: true };
  };

  const deleteStaff = async (slug) => {
    await KV.delete(kStaff(slug));
    await deleteImages(slug);
  };

  /* ---------- 圖片：讀取 ---------- */
  const getImage = async (slug, key) => {
    if (R2) {
      for (const ext of IMG_EXTS) {
        const obj = await R2.get(r2Key(slug, key, ext));
        if (obj) {
          return { body: obj.body, ext, contentType: obj.httpMetadata?.contentType || mimeFor(ext) };
        }
      }
      return null;
    }
    // KV 模式：以 { contentType, b64 } JSON 存放
    for (const ext of IMG_EXTS) {
      const rec = await KV.get(kvImgKey(slug, key, ext), 'json');
      if (rec && rec.b64) {
        return { body: b64ToBytes(rec.b64), ext, contentType: rec.contentType || mimeFor(ext) };
      }
    }
    return null;
  };

  /* ---------- 圖片：寫入 ---------- */
  const putImage = async (slug, key, bytes, ext) => {
    // 先清掉其他副檔名的同名圖片，避免殘留
    await deleteImage(slug, key);
    if (R2) {
      await R2.put(r2Key(slug, key, ext), bytes, { httpMetadata: { contentType: mimeFor(ext) } });
    } else {
      // base64 約放大 33%，5MB 上限 → 約 6.7MB 字串，遠低於 KV 的 25MB 單值上限
      await KV.put(
        kvImgKey(slug, key, ext),
        JSON.stringify({ contentType: mimeFor(ext), b64: bytesToB64(bytes) })
      );
    }
  };

  /* ---------- 圖片：刪除 ---------- */
  /** 刪除某一 key 的所有副檔名變體（對不存在的物件是幂等的） */
  const deleteImage = async (slug, key) => {
    if (R2) {
      for (const ext of IMG_EXTS) await R2.delete(r2Key(slug, key, ext));
    } else {
      for (const ext of IMG_EXTS) await KV.delete(kvImgKey(slug, key, ext));
    }
  };

  const deleteImages = async (slug) => {
    if (R2) {
      const listed = await R2.list({ prefix: r2Prefix(slug), limit: 1000 });
      await Promise.all(listed.objects.map((o) => R2.delete(o.key)));
      return;
    }
    // KV 模式：刪除三種類型的全部副檔名變體
    for (const key of IMG_KEYS) await deleteImage(slug, key);
  };

  const hasImage = async (slug, key) => !!(await getImage(slug, key));

  /** 一次查出三種圖片是否存在 */
  const imageFlags = async (slug) => {
    const flags = { banner: false, avatar: false, wechat_qr: false };
    if (R2) {
      const listed = await R2.list({ prefix: r2Prefix(slug), limit: 1000 });
      for (const obj of listed.objects) {
        for (const key of IMG_KEYS) {
          if (obj.key.startsWith(r2Prefix(slug) + key + '.')) flags[key] = true;
        }
      }
      return flags;
    }
    // KV 模式：並行探測
    await Promise.all(
      IMG_KEYS.map(async (key) => {
        for (const ext of IMG_EXTS) {
          if (await KV.get(kvImgKey(slug, key, ext))) {
            flags[key] = true;
            return;
          }
        }
      })
    );
    return flags;
  };

  /* ---------- meta ---------- */
  const getMeta = async () =>
    (await getJson(kMeta())) || { count: 0, updated_at: null, version: 1 };

  const putMeta = async (meta) => {
    await putJson(kMeta(), meta);
    return meta;
  };

  return {
    ORG,
    /** 圖片儲存模式：'r2' 或 'kv'（供健康檢查與後台顯示） */
    imageMode: R2 ? 'r2' : 'kv',
    getJson,
    putJson,
    deleteJson,
    getConfig,
    putConfig,
    getIndex,
    rebuildIndex,
    patchIndex,
    removeFromIndex,
    getStaff,
    putStaff,
    deleteStaff,
    getImage,
    putImage,
    deleteImage,
    deleteImages,
    hasImage,
    imageFlags,
    getMeta,
    putMeta,
    IMG_EXTS,
    IMG_KEYS,
  };
};

export const mimeFor = (ext) => {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[String(ext).toLowerCase()] || 'application/octet-stream';
};

export { IMG_EXTS, IMG_KEYS };
