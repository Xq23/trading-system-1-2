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
    let res;
    try {
      res = await fetch(`${base}${path}`, { ...options, headers });
    } catch (err) {
      if (err instanceof TypeError) {
        throw new Error("无法连接服务器，请检查网络后刷新；若仍失败请重新登录");
      }
      throw err;
    }
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
      const rawErr = body?.error || text || "";
      const errMsg =
        typeof rawErr === "string" && /<!DOCTYPE|<html/i.test(rawErr)
          ? `请求失败 (${res.status})，请确认后端已部署最新版本`
          : rawErr || `请求失败 (${res.status})`;
      const err = new Error(errMsg);
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

  async function getVolumeAlerts({ limit = 100, offset = 0 } = {}) {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    return apiFetch(`/api/volume-alerts?${q.toString()}`);
  }

  async function getVolumeAlertsLatest() {
    return apiFetch("/api/volume-alerts/latest");
  }

  async function getVolumeAlertHistory({ limit = 30, offset = 0 } = {}) {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    return apiFetch(`/api/volume-alerts/history?${q.toString()}`);
  }

  async function clearVolumeAlerts() {
    return apiFetch("/api/volume-alerts", { method: "DELETE" });
  }

  async function backtestVolumeAlertsToday({ clearFirst = false, force = true } = {}) {
    return apiFetch("/api/volume-alerts/backtest", {
      method: "POST",
      body: JSON.stringify({ today: true, clearFirst, force, timeZone: "Asia/Shanghai" }),
    });
  }

  async function getVolumeAlertScanStatus() {
    return apiFetch("/api/volume-alerts/status");
  }

  async function postVolumeAlertScanComplete(payload) {
    return apiFetch("/api/volume-alerts/scan-complete", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function postVolumeAlertsBatch(alerts) {
    return apiFetch("/api/volume-alerts/batch", {
      method: "POST",
      body: JSON.stringify({ alerts }),
    });
  }

  async function getTradeRecords({ limit = 50, offset = 0, journal = false } = {}) {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    if (journal) q.set("journal", "1");
    return apiFetch(`/api/trade-records?${q.toString()}`);
  }

  async function getTradeRecord(id) {
    return apiFetch(`/api/trade-records/${encodeURIComponent(id)}`);
  }

  async function createTradePlan(payload) {
    return apiFetch("/api/trade-plans", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function executeTradePlan(id, payload) {
    return apiFetch(`/api/trade-plans/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function updateTradePlan(id, payload) {
    return apiFetch(`/api/trade-plans/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async function deleteTradePlan(id) {
    return apiFetch(`/api/trade-plans/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async function createTradeRecord(payload) {
    return apiFetch("/api/trade-records", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function updateTradeRecord(id, payload) {
    return apiFetch(`/api/trade-records/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async function deleteTradeRecord(id) {
    return apiFetch(`/api/trade-records/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async function getTradeExperiences({ limit, offset } = {}) {
    const q = new URLSearchParams();
    if (limit != null) q.set("limit", String(limit));
    if (offset != null) q.set("offset", String(offset));
    const qs = q.toString();
    return apiFetch(`/api/trade-experiences${qs ? `?${qs}` : ""}`);
  }

  async function createTradeExperience(payload) {
    return apiFetch("/api/trade-experiences", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function updateTradeExperience(id, payload) {
    return apiFetch(`/api/trade-experiences/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  }

  async function deleteTradeExperience(id) {
    return apiFetch(`/api/trade-experiences/${encodeURIComponent(id)}`, { method: "DELETE" });
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
    getVolumeAlerts,
    getVolumeAlertsLatest,
    getVolumeAlertHistory,
    clearVolumeAlerts,
    backtestVolumeAlertsToday,
    getVolumeAlertScanStatus,
    postVolumeAlertScanComplete,
    postVolumeAlertsBatch,
    getTradeRecords,
    getTradeRecord,
    createTradePlan,
    updateTradePlan,
    executeTradePlan,
    deleteTradePlan,
    createTradeRecord,
    updateTradeRecord,
    deleteTradeRecord,
    getTradeExperiences,
    createTradeExperience,
    updateTradeExperience,
    deleteTradeExperience,
  };
})(typeof window !== "undefined" ? window : globalThis);
