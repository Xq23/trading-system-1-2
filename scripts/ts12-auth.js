/**
 * 登录：配置了 TS12_CONFIG.apiBase 时走云端 API，否则仅本地（开发备用）
 */
(function (global) {
  const SESSION_KEY = "ts12-session-v1";
  const REMEMBER_DAYS = 30;

  function normalizeUsername(name) {
    return String(name || "")
      .trim()
      .toLowerCase();
  }

  function isCloud() {
    return global.Ts12Api?.isEnabled?.() === true;
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session?.userId || !session?.username) return null;
      if (session.expiresAt && Date.now() > session.expiresAt) {
        clearSession();
        return null;
      }
      if (isCloud() && !session.token) {
        clearSession();
        return null;
      }
      return session;
    } catch (_) {
      return null;
    }
  }

  function setSession(session, remember) {
    const payload = JSON.stringify({ ...session, cloud: isCloud() });
    sessionStorage.setItem(SESSION_KEY, payload);
    if (remember) {
      localStorage.setItem(SESSION_KEY, payload);
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  }

  function sessionFromApiResponse(data, remember) {
    return {
      userId: data.user.id,
      username: data.user.username,
      displayName: data.user.displayName || data.user.username,
      token: data.token,
      expiresAt: data.expiresAt,
      remember: Boolean(remember),
    };
  }

  async function register(username, password) {
    const name = normalizeUsername(username);
    if (name.length < 2) throw new Error("用户名至少 2 个字符");
    if (String(password || "").length < 4) throw new Error("密码至少 4 位");

    if (isCloud()) {
      const data = await global.Ts12Api.apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username: name,
          password,
          displayName: String(username).trim(),
        }),
      });
      const session = sessionFromApiResponse(data, true);
      setSession(session, true);
      return session;
    }

    throw new Error("请配置 scripts/ts12-api-config.js 中的 apiBase 以启用云端账户");
  }

  async function login(username, password, remember = false) {
    const name = normalizeUsername(username);
    if (String(password || "").length < 4) throw new Error("密码至少 4 位");

    if (isCloud()) {
      const data = await global.Ts12Api.apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: name, password, remember }),
      });
      const session = sessionFromApiResponse(data, remember);
      setSession(session, remember);
      return session;
    }

    throw new Error("请配置 scripts/ts12-api-config.js 中的 apiBase 以启用云端账户");
  }

  function logout() {
    clearSession();
  }

  function requireLogin() {
    if (getSession()) return getSession();
    const returnTo = encodeURIComponent(
      window.location.pathname + window.location.search + window.location.hash
    );
    window.location.replace(`login.html?return=${returnTo}`);
    return null;
  }

  function loginPagePath() {
    const base = window.location.pathname.replace(/[^/]+$/, "");
    return `${base}login.html`;
  }

  global.Ts12Auth = {
    normalizeUsername,
    isCloud,
    register,
    login,
    logout,
    getSession,
    requireLogin,
    loginPagePath,
  };
})(typeof window !== "undefined" ? window : globalThis);
