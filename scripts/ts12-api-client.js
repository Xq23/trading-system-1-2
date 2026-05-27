/**
 * 云端 API 客户端（需先加载 ts12-api-config.js）
 */
(function (global) {
  const SESSION_KEY = "ts12-session-v1";

  function getApiBase() {
    const base = String(global.TS12_CONFIG?.apiBase || "").trim();
    return base.replace(/\/$/, "");
  }

  function isEnabled() {
    return Boolean(getApiBase());
  }

  function getStoredSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function getToken() {
    const s = getStoredSession();
    return s?.token || null;
  }

  async function apiFetch(path, options = {}) {
    const base = getApiBase();
    if (!base) throw new Error("未配置 API 地址");
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { ...options, headers });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch (_) {
        body = { error: text };
      }
    }
    if (!res.ok) {
      const err = new Error(body?.error || `请求失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function getPrefs() {
    return apiFetch("/api/sync/prefs");
  }

  async function putPrefs(prefs) {
    return apiFetch("/api/sync/prefs", {
      method: "PUT",
      body: JSON.stringify({ prefs }),
    });
  }

  async function getBreakScan() {
    return apiFetch("/api/sync/break-scan");
  }

  async function putBreakScan(breakScan) {
    return apiFetch("/api/sync/break-scan", {
      method: "PUT",
      body: JSON.stringify({ breakScan }),
    });
  }

  async function deleteBreakScan() {
    return apiFetch("/api/sync/break-scan", { method: "DELETE" });
  }

  global.Ts12Api = {
    getApiBase,
    isEnabled,
    getToken,
    apiFetch,
    getPrefs,
    putPrefs,
    getBreakScan,
    putBreakScan,
    deleteBreakScan,
  };
})(typeof window !== "undefined" ? window : globalThis);
