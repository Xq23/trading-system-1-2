/**
 * 币种偏好：云端开启时以 API 为准，localStorage 作离线缓存
 */
(function (global) {
  const LEGACY_STORAGE_KEY = "ts12-editable-symbols-v1";
  const LEGACY_MIGRATED_FLAG = "ts12-legacy-migrated-v1";
  let saveTimer = null;

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

  function mergeSymbolGroups(a, b) {
    const map = new Map();
    for (const g of [...(a || []), ...(b || [])]) {
      if (!g?.id) continue;
      const prev = map.get(g.id);
      if (!prev) {
        map.set(g.id, { ...g, symbols: [...(g.symbols || [])] });
        continue;
      }
      map.set(g.id, {
        id: g.id,
        name: String(g.name || prev.name || "").trim() || prev.name,
        symbols: [...new Set([...(prev.symbols || []), ...(g.symbols || [])])],
      });
    }
    return normalizeSymbolGroups([...map.values()]);
  }

  /** 以较新的 clientUpdatedAt / 服务端时间为准，避免删除被另一端旧缓存合并回来 */
  function reconcilePrefs(local, remote, serverUpdatedAt) {
    const l = normalizePrefs(local || {});
    const r = normalizePrefs(remote || {});
    const localTs = l.clientUpdatedAt || 0;
    const remoteTs = Math.max(r.clientUpdatedAt || 0, Number(serverUpdatedAt) || 0);

    if (remoteTs > localTs) return { ...r, clientUpdatedAt: remoteTs };
    if (localTs > remoteTs) return { ...l, clientUpdatedAt: localTs };

    if (prefsHasContent(r)) return { ...r, clientUpdatedAt: remoteTs || localTs || Date.now() };
    if (prefsHasContent(l)) return { ...l, clientUpdatedAt: localTs || Date.now() };
    return emptyPrefs();
  }

  /** @deprecated 并集会复活已删除分组，仅保留供调试 */
  function mergePrefs(local, remote) {
    return reconcilePrefs(local, remote, 0);
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

  function loadLocal(userId) {
    if (!userId) return emptyPrefs();
    try {
      const raw = localStorage.getItem(storageKey(userId));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.accounts)) {
          const flat = flattenLegacyParsed(parsed);
          saveLocal(flat, userId);
          return flat;
        }
        return normalizePrefs(parsed);
      }
    } catch (_) {}
    if (!localStorage.getItem(LEGACY_MIGRATED_FLAG)) {
      const migrated = flattenLegacyParsed(readLegacyParsed());
      if (migrated) {
        saveLocal(migrated, userId);
        localStorage.setItem(LEGACY_MIGRATED_FLAG, userId);
        return migrated;
      }
    }
    return emptyPrefs();
  }

  function saveLocal(prefs, userId) {
    if (!userId) return;
    try {
      const payload = {
        ...normalizePrefs(prefs),
        clientUpdatedAt: Date.now(),
      };
      localStorage.setItem(storageKey(userId), JSON.stringify(payload));
    } catch (_) {}
  }

  function load(userId) {
    return loadLocal(userId);
  }

  async function pushPrefsToCloud(userId) {
    if (!global.Ts12Api?.isEnabled?.()) return;
    const latest = loadLocal(userId);
    await global.Ts12Api.putPrefs(latest);
  }

  async function loadAsync(userId) {
    const local = loadLocal(userId);
    if (!global.Ts12Api?.isEnabled?.()) return local;
    try {
      const { prefs: remote, updatedAt: serverUpdatedAt } = await global.Ts12Api.getPrefs();
      const normalized = normalizePrefs(remote || {});
      const localTs = local.clientUpdatedAt || 0;
      const remoteTs = Math.max(normalized.clientUpdatedAt || 0, Number(serverUpdatedAt) || 0);
      const reconciled = reconcilePrefs(local, normalized, serverUpdatedAt);
      saveLocal(reconciled, userId);

      const shouldPushLocal =
        localTs > remoteTs || (!prefsHasContent(normalized) && prefsHasContent(local));
      if (shouldPushLocal && !prefsEqual(reconciled, normalized)) {
        try {
          await pushPrefsToCloud(userId);
        } catch (err) {
          console.warn("本地偏好上传云端失败", err);
        }
      }
      return loadLocal(userId);
    } catch (err) {
      console.warn("云端偏好加载失败，使用本地缓存", err);
      return local;
    }
  }

  function save(prefs, userId) {
    saveLocal(prefs, userId);
  }

  function saveAsync(prefs, userId) {
    saveLocal(prefs, userId);
    if (!global.Ts12Api?.isEnabled?.()) return Promise.resolve();
    clearTimeout(saveTimer);
    return new Promise((resolve) => {
      saveTimer = setTimeout(async () => {
        try {
          await pushPrefsToCloud(userId);
        } catch (err) {
          console.warn("云端偏好保存失败", err);
        }
        resolve();
      }, 400);
    });
  }

  function saveAsyncNow(prefs, userId) {
    saveLocal(prefs, userId);
    if (!global.Ts12Api?.isEnabled?.()) return Promise.resolve();
    clearTimeout(saveTimer);
    return pushPrefsToCloud(userId).catch((err) => {
      console.warn("云端偏好保存失败", err);
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
    save,
    saveAsync,
    saveAsyncNow,
    reconcilePrefs,
    mergePrefs,
    buildSymbolConfig,
    removeSymbolFromAllGroups,
  };
})(typeof window !== "undefined" ? window : globalThis);
