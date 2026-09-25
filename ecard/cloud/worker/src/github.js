/**
 * SAGE E-Card Cloud — GitHub Actions 觸發
 *
 * 職責：讓後台「儲存後自動重建」能真的運作。
 *
 * ── 為什麼需要這個模組 ────────────────────────────────────
 *
 * 前台是預先建置的靜態檔（GitHub Pages），資料存在 Cloudflare KV。
 * 兩者之間需要一條「資料變了 → 重新建置 → 前台更新」的線。
 *
 * 原本的設計是走 Cloudflare Pages 的 Deploy Hook（env.PAGES_DEPLOY_HOOK），
 * 但本專案的前台實際上是 GitHub Pages，因此那條路一直沒接上。
 *
 * 這個模組改為呼叫 GitHub Actions 的 workflow_dispatch API，
 * 觸發 .github/workflows/auto-rebuild.yml 執行重建。
 *
 * ── 需要的設定（兩個 Secrets）────────────────────────────
 *
 *   GITHUB_REPO          格式 "擁有者/倉庫"，例如 "tobyyipwork/sage"
 *   GITHUB_DISPATCH_TOKEN   fine-grained PAT，權限僅需：
 *                          - Actions: Read and write（單一 repo）
 *                          建議只授予這一個 repo，降低外洩風險。
 *
 * 兩個都設定齊全才會啟用；只設一個會被視為設定不完整並明確報錯
 * （避免半套設定造成「以為有觸發、其實沒有」的靜默失敗）。
 */

const API = 'https://api.github.com';

/* ---------- 設定檢查 ---------- */

/**
 * 檢查 GitHub 觸發設定是否完整可用。
 * @returns {{ready: boolean, reason?: string, repo?: string, workflow?: string}}
 */
export const dispatchStatus = (env) => {
  const repo = (env.GITHUB_REPO || '').trim();
  const token = (env.GITHUB_DISPATCH_TOKEN || '').trim();
  const workflow = (env.GITHUB_WORKFLOW_FILE || 'auto-rebuild.yml').trim();

  const hasRepo = !!repo;
  const hasToken = !!token;

  // 兩個都缺 → 未啟用（這是合理的預設狀態，不算錯誤）
  if (!hasRepo && !hasToken) {
    return { ready: false, reason: 'not_configured', repo: null, workflow };
  }

  // 只設定一半 → 設定錯誤，必須明確指出
  if (hasRepo && !hasToken) {
    return { ready: false, reason: 'missing_token', repo, workflow };
  }
  if (!hasRepo && hasToken) {
    return { ready: false, reason: 'missing_repo', repo: null, workflow };
  }

  // 格式檢查：必須是 "owner/repo"
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { ready: false, reason: 'invalid_repo_format', repo, workflow };
  }

  return { ready: true, repo, workflow };
};

/* ---------- 觸發 ---------- */

/**
 * 呼叫 GitHub Actions 的 workflow_dispatch 端點，觸發重建。
 *
 * @param {object} env          Worker 環境變數
 * @param {object} [opts]
 * @param {boolean} [opts.force] 傳給 workflow 的 force 輸入（略過指紋比對）
 * @returns {Promise<object>}   永遠回傳結構化結果，不丟錯（呼叫端據此決定訊息）
 */
export const triggerRebuild = async (env, { force = false } = {}) => {
  const status = dispatchStatus(env);

  if (!status.ready) {
    const messages = {
      not_configured: '尚未設定 GITHUB_REPO 與 GITHUB_DISPATCH_TOKEN，無法從後台觸發重建。',
      missing_token: '已設定 GITHUB_REPO，但缺少 GITHUB_DISPATCH_TOKEN（需 Actions: Read and write）。',
      missing_repo: '已設定 GITHUB_DISPATCH_TOKEN，但缺少 GITHUB_REPO（格式：擁有者/倉庫）。',
      invalid_repo_format: `GITHUB_REPO 格式錯誤（目前為「${status.repo}」），應為「擁有者/倉庫」。`,
    };
    return {
      ok: false,
      triggered: false,
      configured: false,
      reason: status.reason,
      message: messages[status.reason] || 'GitHub 觸發設定不完整。',
    };
  }

  const url = `${API}/repos/${status.repo}/actions/workflows/${encodeURIComponent(
    status.workflow
  )}/dispatches`;

  const body = {
    ref: (env.GITHUB_BRANCH || 'main').trim(),
    inputs: { force: force ? 'true' : 'false' },
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        // GitHub 要求帶 User-Agent
        'User-Agent': 'sage-ecard-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      triggered: false,
      configured: true,
      reason: 'network_error',
      message: `無法連線到 GitHub API：${e && e.message ? e.message : '未知錯誤'}`,
    };
  }

  // workflow_dispatch 成功時回 204 No Content
  if (res.status === 204) {
    return {
      ok: true,
      triggered: true,
      configured: true,
      reason: 'dispatched',
      repo: status.repo,
      workflow: status.workflow,
      message: '已通知 GitHub 開始重建，約 1–2 分鐘後前台更新。',
    };
  }

  // 失敗：依狀態碼給出可辨識的訊息
  let detail = '';
  try {
    const j = await res.json();
    if (j && j.message) detail = j.message;
  } catch {
    /* 無 JSON 內容，忽略 */
  }

  const hints = {
    401: 'token 無效或已過期，請重新產生 GITHUB_DISPATCH_TOKEN。',
    403: 'token 權限不足，需具備該 repo 的 Actions: Read and write。',
    404: '找不到 repo 或 workflow 檔案。請確認 GITHUB_REPO 正確，且 auto-rebuild.yml 存在於預設分支。',
    410: '該 workflow 已被停用，或 repo 的 Actions 已被關閉。',
    422: '觸發參數有誤（例如分支名稱不存在）。',
  };

  return {
    ok: false,
    triggered: false,
    configured: true,
    reason: `http_${res.status}`,
    http_status: res.status,
    message: hints[res.status] || `觸發失敗（HTTP ${res.status}）${detail ? '：' + detail : ''}`,
    detail: detail || undefined,
  };
};

/**
 * 查詢最近的 workflow 執行狀態，供後台顯示「上次重建結果」。
 * 失敗時回傳 null（不影響主要流程）。
 */
export const latestRun = async (env) => {
  const status = dispatchStatus(env);
  if (!status.ready) return null;

  const url = `${API}/repos/${status.repo}/actions/workflows/${encodeURIComponent(
    status.workflow
  )}/runs?per_page=1`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sage-ecard-worker',
      },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const run = j && j.workflow_runs && j.workflow_runs[0];
    if (!run) return null;
    return {
      status: run.status, // queued / in_progress / completed
      conclusion: run.conclusion, // success / failure / null
      created_at: run.created_at,
      html_url: run.html_url,
      event: run.event,
    };
  } catch {
    return null;
  }
};
