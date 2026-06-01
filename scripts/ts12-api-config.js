/**
 * 部署：将 apiBase 设为 Railway 后端公网地址。
 * 本地调试可在 URL 加 ?api=http://localhost:8787 临时覆盖。
 */
(function () {
  const qApi = new URLSearchParams(window.location.search).get("api");
  /** 更新前端脚本后递增，避免 GitHub Pages / 浏览器长期缓存旧 JS */
  window.TS12_ASSET_VERSION = "20260522";
  window.TS12_CONFIG = window.TS12_CONFIG || {
    apiBase: "https://trading-system-1-2-production.up.railway.app",
  };
  if (qApi) window.TS12_CONFIG.apiBase = qApi.replace(/\/$/, "");
})();
