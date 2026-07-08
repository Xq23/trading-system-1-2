import cors from "cors";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  clearAllVolumeAlerts,
  clearBreakScan,
  createUser,
  findUserById,
  findUserByUsername,
  getUserSync,
  insertVolumeAlerts,
  listLatestVolumeAlertBatch,
  listVolumeAlertHistory,
  listVolumeAlerts,
  logVolumeAlertScan,
  setSystemMeta,
  upsertBreakScan,
  upsertPrefs,
  listTradeRecords,
  getTradeRecord,
  createTradeRecord,
  updateTradeRecord,
  deleteTradeRecord,
  listTradeJournal,
  listTradePlans,
  getTradePlan,
  createTradePlan,
  createTradePlanWithRecord,
  executeTradePlan,
  updateTradePlan,
  deleteTradePlan,
} from "./db.js";
import {
  startVolumeAlertScheduler,
  runVolumeAlertBacktest,
  runVolumeAlertBacktestToday,
  runVolumeAlertScanTriggers,
  isVolumeAlertScanning,
  getVolumeAlertScanStatus,
} from "./volume-alert-scanner.js";

const PORT = Number(process.env.PORT) || 8787;
const JWT_SECRET = process.env.JWT_SECRET || "dev-change-me-in-production";
const REMEMBER_DAYS = 30;
const BCRYPT_ROUNDS = 10;

const app = express();
app.use(express.json({ limit: "12mb" }));

const corsOrigins = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || corsOrigins.includes("*") || corsOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      cb(new Error("CORS blocked"));
    },
    credentials: true,
  })
);

function createUserId() {
  return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeUsername(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function signToken(user, remember) {
  const expiresIn = remember ? `${REMEMBER_DAYS}d` : "12h";
  const token = jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn }
  );
  const decoded = jwt.decode(token);
  return { token, expiresAt: decoded.exp * 1000 };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "未登录" });
    return;
  }
  try {
    const payload = jwt.verify(match[1], JWT_SECRET);
    const user = findUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "用户不存在" });
      return;
    }
    req.user = user;
    req.token = match[1];
    next();
  } catch (_) {
    res.status(401).json({ error: "登录已过期，请重新登录" });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const displayName = String(req.body?.displayName || req.body?.username || "").trim() || username;
    if (username.length < 2) {
      res.status(400).json({ error: "用户名至少 2 个字符" });
      return;
    }
    if (password.length < 4) {
      res.status(400).json({ error: "密码至少 4 位" });
      return;
    }
    if (findUserByUsername(username)) {
      res.status(409).json({ error: "用户名已存在" });
      return;
    }
    const id = createUserId();
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const createdAt = Date.now();
    createUser({ id, username, displayName, passwordHash, createdAt });
    const user = findUserById(id);
    const { token, expiresAt } = signToken(user, true);
    res.status(201).json({
      token,
      expiresAt,
      user: { id: user.id, username: user.username, displayName: user.displayName },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "注册失败" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const remember = Boolean(req.body?.remember);
    const row = findUserByUsername(username);
    if (!row) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    const ok = await bcrypt.compare(password, row.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "用户名或密码错误" });
      return;
    }
    const user = findUserById(row.id);
    const { token, expiresAt } = signToken(user, remember);
    res.json({
      token,
      expiresAt,
      user: { id: user.id, username: user.username, displayName: user.displayName },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "登录失败" });
  }
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/sync/prefs", authMiddleware, (req, res) => {
  const row = getUserSync(req.user.id);
  let prefs = {};
  try {
    prefs = row?.prefsJson ? JSON.parse(row.prefsJson) : {};
  } catch (_) {
    prefs = {};
  }
  res.json({ prefs, updatedAt: row?.updatedAt || null });
});

app.put("/api/sync/prefs", authMiddleware, (req, res) => {
  const prefs = req.body?.prefs;
  if (!prefs || typeof prefs !== "object") {
    res.status(400).json({ error: "prefs 无效" });
    return;
  }
  const updatedAt = Date.now();
  upsertPrefs(req.user.id, JSON.stringify(prefs), updatedAt);
  res.json({ ok: true, updatedAt });
});

app.get("/api/sync/break-scan", authMiddleware, (req, res) => {
  const row = getUserSync(req.user.id);
  let breakScan = null;
  try {
    breakScan = row?.breakScanJson ? JSON.parse(row.breakScanJson) : null;
  } catch (_) {
    breakScan = null;
  }
  res.json({ breakScan, updatedAt: row?.updatedAt || null });
});

app.put("/api/sync/break-scan", authMiddleware, (req, res) => {
  const breakScan = req.body?.breakScan;
  const updatedAt = Date.now();
  if (breakScan == null) {
    clearBreakScan(req.user.id, updatedAt);
    res.json({ ok: true, updatedAt });
    return;
  }
  upsertBreakScan(req.user.id, JSON.stringify(breakScan), updatedAt);
  res.json({ ok: true, updatedAt });
});

app.delete("/api/sync/break-scan", authMiddleware, (req, res) => {
  const updatedAt = Date.now();
  clearBreakScan(req.user.id, updatedAt);
  res.json({ ok: true, updatedAt });
});

app.get("/api/volume-alerts", authMiddleware, (req, res) => {
  const limit = req.query?.limit;
  const offset = req.query?.offset;
  res.json(listVolumeAlerts({ limit, offset }));
});

app.get("/api/volume-alerts/latest", authMiddleware, (_req, res) => {
  res.json(listLatestVolumeAlertBatch());
});

app.get("/api/volume-alerts/status", authMiddleware, (_req, res) => {
  res.json(getVolumeAlertScanStatus());
});

app.get("/api/volume-alerts/history", authMiddleware, (req, res) => {
  const limit = req.query?.limit;
  const offset = req.query?.offset;
  res.json(listVolumeAlertHistory({ limit, offset }));
});

app.delete("/api/volume-alerts", authMiddleware, (_req, res) => {
  if (isVolumeAlertScanning()) {
    res.status(409).json({ error: "扫描进行中，请稍后再清空" });
    return;
  }
  clearAllVolumeAlerts();
  res.json({ ok: true });
});

app.post("/api/volume-alerts/batch", authMiddleware, (req, res) => {
  const alerts = req.body?.alerts;
  if (!Array.isArray(alerts)) {
    res.status(400).json({ error: "alerts 无效" });
    return;
  }
  const inserted = insertVolumeAlerts(alerts, Date.now());
  res.json({ ok: true, inserted });
});

app.post("/api/volume-alerts/scan-complete", authMiddleware, (req, res) => {
  const triggerCandleOpenTime = Number(req.body?.triggerCandleOpenTime);
  const symbolCount = Number(req.body?.symbolCount) || 0;
  const alerts = req.body?.alerts;
  if (!Number.isFinite(triggerCandleOpenTime)) {
    res.status(400).json({ error: "triggerCandleOpenTime 无效" });
    return;
  }
  if (!Array.isArray(alerts)) {
    res.status(400).json({ error: "alerts 无效" });
    return;
  }
  const scannedAt = Date.now();
  const inserted = insertVolumeAlerts(alerts, scannedAt);
  logVolumeAlertScan({
    triggerCandleOpenTime,
    scannedAt,
    symbolCount,
    alertCount: alerts.length,
    inserted,
  });
  setSystemMeta("volume_alert_last_trigger", String(triggerCandleOpenTime));
  res.json({ ok: true, inserted, alertCount: alerts.length });
});

app.post("/api/volume-alerts/backtest", authMiddleware, (req, res) => {
  const periods = Number(req.body?.periods) || 2;
  const force = Boolean(req.body?.force);
  const clearFirst = Boolean(req.body?.clearFirst);
  const today = Boolean(req.body?.today);
  const timeZone = String(req.body?.timeZone || "Asia/Shanghai");
  const triggerOpenTimes = req.body?.triggerOpenTimes ?? req.body?.triggerOpenTime;
  if (isVolumeAlertScanning()) {
    res.status(409).json({ error: "已有扫描任务进行中，请稍后再试" });
    return;
  }
  if (clearFirst) clearAllVolumeAlerts();
  if (today) {
    res.json({
      ok: true,
      message: clearFirst
        ? "已清空历史，正在重跑今天所有已收线 4h 批次…"
        : "已开始重跑今天所有已收线 4h 批次…",
      today: true,
      force,
      clearFirst,
      timeZone,
    });
    void runVolumeAlertBacktestToday({ force: true, timeZone }).catch((err) => {
      console.error("[volume-alert] 今日回测失败", err);
    });
    return;
  }
  if (triggerOpenTimes != null) {
    const list = Array.isArray(triggerOpenTimes) ? triggerOpenTimes : [triggerOpenTimes];
    res.json({
      ok: true,
      message: `已开始检测指定 ${list.length} 个 4h 批次，请稍后刷新历史列表`,
      triggerOpenTimes: list,
      force,
    });
    void runVolumeAlertScanTriggers(list, { force }).catch((err) => {
      console.error("[volume-alert] 指定批次检测失败", err);
    });
    return;
  }
  res.json({
    ok: true,
    message: `已开始回测最近 ${Math.min(Math.max(periods, 1), 7)} 根 4h K 线，请稍后刷新历史列表查看`,
    periods,
    force,
  });
  void runVolumeAlertBacktest({ periods, force }).catch((err) => {
    console.error("[volume-alert] 回测失败", err);
  });
});

app.get("/api/trade-records", authMiddleware, (req, res) => {
  const limit = req.query?.limit;
  const offset = req.query?.offset;
  const journal = String(req.query?.journal || "") === "1";
  if (journal) {
    try {
      res.json(listTradeJournal(req.user.id, { limit, offset }));
    } catch (err) {
      console.error("[trade-journal]", err);
      res.status(500).json({ error: "加载交易记录失败" });
    }
    return;
  }
  res.json(listTradeRecords(req.user.id, { limit, offset }));
});

app.get("/api/trade-plans", authMiddleware, (req, res) => {
  const limit = req.query?.limit;
  const offset = req.query?.offset;
  const executed = req.query?.executed;
  res.json(listTradePlans(req.user.id, { limit, offset, executed }));
});

app.get("/api/trade-plans/:id", authMiddleware, (req, res) => {
  const plan = getTradePlan(req.user.id, req.params.id);
  if (!plan) {
    res.status(404).json({ error: "计划不存在" });
    return;
  }
  res.json({ plan });
});

app.post("/api/trade-plans", authMiddleware, (req, res) => {
  const result = createTradePlan(req.user.id, req.body);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, ...result });
});

app.put("/api/trade-plans/:id", authMiddleware, (req, res) => {
  const result = updateTradePlan(req.user.id, req.params.id, req.body);
  if (result.error) {
    const status = result.error === "计划不存在" ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, plan: result.plan });
});

app.post("/api/trade-plans/:id/execute", authMiddleware, (req, res) => {
  const result = executeTradePlan(req.user.id, req.params.id, req.body);
  if (result.error) {
    const status = result.error === "计划不存在" ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, ...result });
});

app.delete("/api/trade-plans/:id", authMiddleware, (req, res) => {
  const ok = deleteTradePlan(req.user.id, req.params.id);
  if (!ok) {
    res.status(404).json({ error: "计划不存在或已执行，无法删除" });
    return;
  }
  res.json({ ok: true });
});

app.get("/api/trade-records/:id", authMiddleware, (req, res) => {
  const record = getTradeRecord(req.user.id, req.params.id);
  if (!record) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.json({ record });
});

app.post("/api/trade-records", authMiddleware, (req, res) => {
  const result = createTradeRecord(req.user.id, req.body);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, record: result.record });
});

app.put("/api/trade-records/:id", authMiddleware, (req, res) => {
  const result = updateTradeRecord(req.user.id, req.params.id, req.body);
  if (result.error) {
    const status = result.error === "记录不存在" ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  res.json({ ok: true, record: result.record });
});

app.delete("/api/trade-records/:id", authMiddleware, (req, res) => {
  const ok = deleteTradeRecord(req.user.id, req.params.id);
  if (!ok) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  if (err?.message === "CORS blocked") {
    res.status(403).json({ error: "来源未授权（请配置 CORS_ORIGINS）" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "服务器错误" });
});

app.listen(PORT, () => {
  console.log(`ts12-api listening on :${PORT}`);
  startVolumeAlertScheduler();
});
