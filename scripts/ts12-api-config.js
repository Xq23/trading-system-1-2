/**
 * 部署：将 apiBase 设为 Railway 后端公网地址。
 * 本地调试可在 URL 加 ?api=http://localhost:8787 临时覆盖。
 */
(function () {
  const qApi = new URLSearchParams(window.location.search).get("api");
  window.TS12_CONFIG = window.TS12_CONFIG || { apiBase: "" };
  if (qApi) window.TS12_CONFIG.apiBase = qApi.replace(/\/$/, "");
})();
