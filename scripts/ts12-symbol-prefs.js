/**
 * 币种偏好：云端开启时以 API 为准，localStorage 仅作离线缓存
 */
(function (global) {
  const LEGACY_STORAGE_KEY = "ts12-editable-symbols-v1";
  const LEGACY_MIGRATED_FLAG = "ts12-legacy-migrated-v1";
  let saveTimer = null;
  let saveChain = Promise.resolve();

  function storageKey(userId) {
    return `${LEGACY_STORAGE_KEY}:${userId}`;
  }

  function makeSymbolKey(exchangeSymbol) {
    return String(exchangeSymbol || "").toUpperCase();
  }

  function normalizeSymbolGroups(groups) {
    if (!Array.isArray(groups)) return [];
    return groups
      .map((g) => ({
        id: String(g?.id || ""),
        name: String(g?.name || "").trim(),
        symbols: Array.isArray(g?.symbols)
          ? [...new Set(g.symbols.map((s) => makeSymbolKey(s)).filter(Boolean))]
          : [],
      }))
      .filter((g) => g.id && g.name);
  }

  function normalizePrefs(parsed) {
    let activeSymbolGroupId =
      typeof parsed?.activeSymbolGroupId === "string" ? parsed.activeSymbolGroupId : null;
    if (
      !activeSymbolGroupId &&
      Array.isArray(parsed?.activeSymbolGroupIds) &&
      parsed.activeSymbolGroupIds.length === 1
    ) {
      activeSymbolGroupId = parsed.activeSymbolGroupIds[0];
    }
    return {
      customSymbols: Array.isArray(parsed?.customSymbols)
        ? parsed.customSymbols.map((s) => makeSymbolKey(s)).filter(Boolean)
        : [],
      hiddenDefaults: Array.isArray(parsed?.hiddenDefaults) ? [...parsed.hiddenDefaults] : [],
      symbolGroups: normalizeSymbolGroups(parsed?.symbolGroups),
      activeSymbolGroupId,
      clientUpdatedAt:
        typeof parsed?.clientUpdatedAt === "number" && Number.isFinite(parsed.clientUpdatedAt)
          ? parsed.clientUpdatedAt
          : 0,
    };
  }

  function prefsEqual(a, b) {
    const strip = (p) => {
      const n = normalizePrefs(p || {});
      return JSON.stringify({
        customSymbols: n.customSymbols,
        hiddenDefaults: n.hiddenDefaults,
        symbolGroups: n.symbolGroups,
        activeSymbolGroupId: n.activeSymbolGroupId,
      });
    };
    return strip(a) === strip(b);
  }

  function flattenLegacyParsed(parsed) {
    if (!parsed) return null;
    if (Array.isArray(parsed.accounts) && parsed.accounts.length) {
      const acc =
        parsed.accounts.find((a) => a.id === parsed.activeAccountId) || parsed.accounts[0];
      return normalizePrefs(acc);
    }
    return normalizePrefs(parsed);
  }

  function readLegacyParsed() {
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      return legacy ? JSON.parse(legacy) : null;
    } catch (_) {
      return null;
    }
  }

  function emptyPrefs() {
    return {
      customSymbols: [],
      hiddenDefaults: [],
      symbolGroups: [],
      activeSymbolGroupId: null,
      clientUpdatedAt: 0,
    };
  }

  function prefsHasContent(prefs) {
    return (
      (prefs.customSymbols && prefs.customSymbols.length > 0) ||
      (prefs.hiddenDefaults && prefs.hiddenDefaults.length > 0) ||
      (prefs.symbolGroups && prefs.symbolGroups.length > 0) ||
      Boolean(prefs.activeSymbolGroupId)
    );
  }

  /** 写入本地缓存；syncedAt 为服务端时间或用户编辑时间 */
  function cacheLocal(prefs, userId, syncedAt) {
    if (!userId) return;
    try {
      const payload = {
        ...normalizePrefs(prefs),
        clientUpdatedAt: syncedAt || Date.now(),
      };
      localStorage.setItem(storageKey(userId), JSON.stringify(payload));
    } catch (_) {}
  }

  function loadLocal(userId) {
    if (!userId) return emptyPrefs();
    try {
      const raw = localStorage.getItem(storageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.accounts)) {
          const flat = flattenLegacyParsed(parsed);
          cacheLocal(flat, userId, flat.clientUpdatedAt || Date.now());
          return flat;
        }
        return normalizePrefs(parsed);
      }
    } catch (_) {}
    if (!localStorage.getItem(LEGACY_MIGRATED_FLAG)) {
      const migrated = flattenLegacyParsed(readLegacyParsed());
      if (migrated) {
        cacheLocal(migrated, userId, Date.now());
        localStorage.setItem(LEGACY_MIGRATED_FLAG, userId);
        return migrated;
      }
    }
    return emptyPrefs();
  }

  function load(userId) {
    return loadLocal(userId);
  }

  /** 从云端拉取并覆盖本地（云端为权威数据源） */
  async function pullPrefsFromCloud(userId) {
    const { prefs: remote, updatedAt } = await global.Ts12Api.getPrefs();
    const serverTs = Number(updatedAt) || 0;
    const normalized = normalizePrefs(remote || {});
    if (serverTs <= 0 && !prefsHasContent(normalized)) return null;
    const synced = {
      ...normalized,
      clientUpdatedAt: serverTs || normalized.clientUpdatedAt || Date.now(),
    };
    cacheLocal(synced, userId, synced.clientUpdatedAt);
    return synced;
  }

  async function pushPrefsToCloud(userId, prefs) {
    if (!global.Ts12Api?.isEnabled?.()) return 0;
    const latest = normalizePrefs(prefs || loadLocal(userId));
    const res = await global.Ts12Api.putPrefs(latest);
    const serverTs = Number(res?.updatedAt) || Date.now();
    cacheLocal(latest, userId, serverTs);
    return serverTs;
  }

  function enqueueSave(task) {
    saveChain = saveChain.then(task, task);
    return saveChain;
  }

  async function loadAsync(userId) {
    if (!userId) return emptyPrefs();
    if (!global.Ts12Api?.isEnabled?.()) return loadLocal(userId);
    try {
      const local = loadLocal(userId);
      const remoteRes = await global.Ts12Api.getPrefs();
      const remote = normalizePrefs(remoteRes?.prefs || {});
      const serverTs = Number(remoteRes?.updatedAt) || 0;
      const localTs = Number(local.clientUpdatedAt) || 0;

      if (localTs > serverTs && prefsHasContent(local)) {
        await pushPrefsToCloud(userId, local);
        return loadLocal(userId);
      }

      if (serverTs <= 0 && !prefsHasContent(remote)) {
        if (prefsHasContent(local)) {
          await pushPrefsToCloud(userId, local);
          return loadLocal(userId);
        }
        return emptyPrefs();
      }

      const synced = {
        ...remote,
        clientUpdatedAt: serverTs || remote.clientUpdatedAt || Date.now(),
      };
      cacheLocal(synced, userId, synced.clientUpdatedAt);
      return synced;
    } catch (err) {
      console.warn("云端偏好加载失败，使用本地缓存", err);
      return loadLocal(userId);
    }
  }

  function save(prefs, userId) {
    cacheLocal(prefs, userId, Date.now());
  }

  function saveAsync(prefs, userId) {
    cacheLocal(prefs, userId, Date.now());
    if (!global.Ts12Api?.isEnabled?.()) return Promise.resolve();
    clearTimeout(saveTimer);
    return new Promise((resolve, reject) => {
      saveTimer = setTimeout(() => {
        enqueueSave(async () => {
          try {
            await pushPrefsToCloud(userId, loadLocal(userId));
            resolve();
          } catch (err) {
            console.warn("云端偏好保存失败", err);
            reject(err);
          }
        });
      }, 400);
    });
  }

  async function saveAsyncNow(prefs, userId) {
    return enqueueSave(async () => {
      cacheLocal(prefs, userId, Date.now());
      if (!global.Ts12Api?.isEnabled?.()) return;
      clearTimeout(saveTimer);
      await pushPrefsToCloud(userId, prefs);
    });
  }

  function buildSymbolConfig(defaultSymbolConfig, prefs) {
    const hidden = new Set(prefs.hiddenDefaults || []);
    const next = {};
    for (const [key, cfg] of Object.entries(defaultSymbolConfig)) {
      if (!hidden.has(key)) next[key] = { ...cfg };
    }
    const existingSymbols = new Set(Object.values(next).map((cfg) => cfg.exchangeSymbol));
    for (const symbol of prefs.customSymbols || []) {
      const exchangeSymbol = makeSymbolKey(symbol);
      if (!exchangeSymbol || existingSymbols.has(exchangeSymbol)) continue;
      const pair = formatExchangePair(exchangeSymbol);
      next[exchangeSymbol] = {
        exchangeSymbol,
        pairName: `${pair} 永续合约（币安）`,
        title: `币安 ${pair} 永续 K 线`,
      };
      existingSymbols.add(exchangeSymbol);
    }
    if (Object.keys(next).length === 0) {
      const fallbackKey = Object.keys(defaultSymbolConfig)[0] || "BTC";
      next[fallbackKey] = { ...defaultSymbolConfig[fallbackKey] };
    }
    return next;
  }

  function formatExchangePair(exchangeSymbol) {
    const s = makeSymbolKey(exchangeSymbol);
    for (const quote of ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"]) {
      if (s.endsWith(quote)) return `${s.slice(0, -quote.length)}/${quote}`;
    }
    return s;
  }

  function formatSymbolDisplay(exchangeSymbol) {
    const s = makeSymbolKey(exchangeSymbol);
    for (const quote of ["USDT", "USDC", "FDUSD", "TUSD", "BUSD"]) {
      if (s.endsWith(quote)) return s.slice(0, -quote.length);
    }
    return s;
  }

  function removeSymbolFromAllGroups(prefs, exchangeSymbol) {
    const ex = makeSymbolKey(exchangeSymbol);
    prefs.symbolGroups = (prefs.symbolGroups || []).map((g) => ({
      ...g,
      symbols: g.symbols.filter((s) => s !== ex),
    }));
  }

  function breakScanStorageKey(userId) {
    return `ts12-break-scan-cache-v1:${userId}`;
  }

  global.Ts12SymbolPrefs = {
    LEGACY_STORAGE_KEY,
    storageKey,
    breakScanStorageKey,
    makeSymbolKey,
    formatExchangePair,
    formatSymbolDisplay,
    normalizeSymbolGroups,
    normalizePrefs,
    load,
    loadAsync,
    pullPrefsFromCloud,
    save,
    saveAsync,
    saveAsyncNow,
    buildSymbolConfig,
    removeSymbolFromAllGroups,
  };
})(typeof window !== "undefined" ? window : globalThis);
