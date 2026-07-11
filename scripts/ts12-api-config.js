/**
 * 部署：将 apiBase 设为 Railway 后端公网地址。
 * 本地调试：在 localhost 打开页面时默认使用 http://localhost:8787；
 * 也可用 URL 参数临时指定：?api=http://localhost:8787
 */
(function () {
  const STORAGE_KEY = "ts12-api-base";
  const PROD_API = "https://trading-system-1-2-production.up.railway.app";
  const LOCAL_API = "http://localhost:8787";
  const qApi = new URLSearchParams(window.location.search).get("api");
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);

  function normalizeBase(raw) {
    return String(raw || "")
      .trim()
      .replace(/\/$/, "");
  }

  let apiBase = PROD_API;
  if (qApi) {
    apiBase = normalizeBase(qApi);
    try {
      localStorage.setItem(STORAGE_KEY, apiBase);
    } catch (_) {}
  } else if (isLocalHost) {
    apiBase = LOCAL_API;
  } else {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) apiBase = normalizeBase(stored);
    } catch (_) {}
  }

  /** 更新前端脚本后递增，避免 GitHub Pages / 浏览器长期缓存旧 JS */
  window.TS12_ASSET_VERSION = "20260711b";
  window.TS12_CONFIG = window.TS12_CONFIG || { apiBase };
  window.TS12_CONFIG.apiBase = apiBase;
})();
