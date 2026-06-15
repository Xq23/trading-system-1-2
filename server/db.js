import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "ts12.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_sync (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs_json TEXT NOT NULL DEFAULT '{}',
    break_scan_json TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS volume_alerts (
    id TEXT PRIMARY KEY,
    exchange_symbol TEXT NOT NULL,
    condition_type TEXT NOT NULL,
    volume REAL NOT NULL,
    avg_volume REAL NOT NULL,
    ratio REAL NOT NULL,
    candle_open_time INTEGER NOT NULL,
    candle_close_time INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(exchange_symbol, candle_open_time, condition_type)
  );
  CREATE INDEX IF NOT EXISTS idx_volume_alerts_created ON volume_alerts(created_at DESC);
  CREATE TABLE IF NOT EXISTS system_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS volume_alert_scan_log (
    trigger_candle_open_time INTEGER PRIMARY KEY,
    scanned_at INTEGER NOT NULL,
    symbol_count INTEGER NOT NULL,
    alert_count INTEGER NOT NULL,
    inserted_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS trade_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_symbol TEXT NOT NULL,
    position_side TEXT NOT NULL DEFAULT '',
    entry_condition TEXT NOT NULL DEFAULT '',
    entry_condition_30m TEXT NOT NULL DEFAULT '',
    entry_condition_4h TEXT NOT NULL DEFAULT '',
    entry_condition_12h TEXT NOT NULL DEFAULT '',
    entry_condition_1d TEXT NOT NULL DEFAULT '',
    entry_price REAL NOT NULL,
    take_profit_price REAL NOT NULL,
    stop_loss_price REAL NOT NULL,
    risk_reward_ratio REAL,
    trade_result TEXT NOT NULL DEFAULT '',
    review TEXT NOT NULL DEFAULT '',
    review_matches_record TEXT NOT NULL DEFAULT '',
    entry_condition_images TEXT NOT NULL DEFAULT '[]',
    review_images TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trade_records_user ON trade_records(user_id, created_at DESC);
`);

try {
  db.exec(`ALTER TABLE volume_alerts ADD COLUMN trigger_candle_open_time INTEGER`);
} catch (_) {}

try {
  db.exec(
    `ALTER TABLE trade_records ADD COLUMN entry_condition_images TEXT NOT NULL DEFAULT '[]'`
  );
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN review_images TEXT NOT NULL DEFAULT '[]'`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN entry_condition_30m TEXT NOT NULL DEFAULT ''`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN entry_condition_4h TEXT NOT NULL DEFAULT ''`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN entry_condition_12h TEXT NOT NULL DEFAULT ''`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN entry_condition_1d TEXT NOT NULL DEFAULT ''`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN review_matches_record TEXT NOT NULL DEFAULT ''`);
} catch (_) {}
try {
  db.exec(`ALTER TABLE trade_records ADD COLUMN position_side TEXT NOT NULL DEFAULT ''`);
} catch (_) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_plans (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exchange_symbol TEXT NOT NULL,
    plan_text TEXT NOT NULL DEFAULT '',
    executed INTEGER NOT NULL DEFAULT 0,
    plan_status TEXT NOT NULL DEFAULT 'pending',
    trade_record_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trade_plans_user ON trade_plans(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trade_plans_record ON trade_plans(trade_record_id);
`);

try {
  db.exec(`ALTER TABLE trade_plans ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'pending'`);
} catch (_) {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_volume_alerts_trigger ON volume_alerts(trigger_candle_open_time DESC);
`);

export function findUserByUsername(username) {
  return db
    .prepare(
      `SELECT id, username, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt
       FROM users WHERE username = ? COLLATE NOCASE`
    )
    .get(username);
}

export function findUserById(id) {
  return db
    .prepare(
      `SELECT id, username, display_name AS displayName, created_at AS createdAt
       FROM users WHERE id = ?`
    )
    .get(id);
}

export function createUser({ id, username, displayName, passwordHash, createdAt }) {
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, username, displayName, passwordHash, createdAt);
  db.prepare(
    `INSERT INTO user_sync (user_id, prefs_json, break_scan_json, updated_at)
     VALUES (?, '{}', NULL, ?)`
  ).run(id, createdAt);
}

export function getUserSync(userId) {
  return db
    .prepare(
      `SELECT prefs_json AS prefsJson, break_scan_json AS breakScanJson, updated_at AS updatedAt
       FROM user_sync WHERE user_id = ?`
    )
    .get(userId);
}

export function upsertPrefs(userId, prefsJson, updatedAt) {
  db.prepare(
    `INSERT INTO user_sync (user_id, prefs_json, break_scan_json, updated_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       prefs_json = excluded.prefs_json,
       updated_at = excluded.updated_at`
  ).run(userId, prefsJson, updatedAt);
}

export function upsertBreakScan(userId, breakScanJson, updatedAt) {
  const row = getUserSync(userId);
  const prefs = row?.prefsJson || "{}";
  db.prepare(
    `INSERT INTO user_sync (user_id, prefs_json, break_scan_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       break_scan_json = excluded.break_scan_json,
       updated_at = excluded.updated_at`
  ).run(userId, prefs, breakScanJson, updatedAt);
}

export function clearBreakScan(userId, updatedAt) {
  db.prepare(`UPDATE user_sync SET break_scan_json = NULL, updated_at = ? WHERE user_id = ?`).run(
    updatedAt,
    userId
  );
}

function normalizeVolumeAlert(alert) {
  const exchangeSymbol = String(alert?.exchangeSymbol || alert?.exchange_symbol || "")
    .trim()
    .toUpperCase();
  const conditionType = String(alert?.conditionType || alert?.condition_type || "").trim();
  const volume = Number(alert?.volume);
  const avgVolume = Number(alert?.avgVolume ?? alert?.avg_volume);
  const ratio = Number(alert?.ratio);
  const candleOpenTime = Number(alert?.candleOpenTime ?? alert?.candle_open_time);
  const candleCloseTime = Number(alert?.candleCloseTime ?? alert?.candle_close_time);
  const triggerCandleOpenTime = Number(
    alert?.triggerCandleOpenTime ?? alert?.trigger_candle_open_time ?? candleOpenTime
  );
  if (
    !exchangeSymbol ||
    !conditionType ||
    !Number.isFinite(volume) ||
    !Number.isFinite(avgVolume) ||
    !Number.isFinite(ratio) ||
    !Number.isFinite(candleOpenTime) ||
    !Number.isFinite(candleCloseTime) ||
    !Number.isFinite(triggerCandleOpenTime)
  ) {
    return null;
  }
  return {
    exchangeSymbol,
    conditionType,
    volume,
    avgVolume,
    ratio,
    candleOpenTime,
    candleCloseTime,
    triggerCandleOpenTime,
  };
}

export function getSystemMeta(key) {
  const row = db.prepare(`SELECT value FROM system_meta WHERE key = ?`).get(key);
  return row?.value ?? null;
}

export function setSystemMeta(key, value) {
  db.prepare(
    `INSERT INTO system_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

export function isVolumeAlertScanDone(triggerCandleOpenTime) {
  const row = db
    .prepare(`SELECT 1 FROM volume_alert_scan_log WHERE trigger_candle_open_time = ?`)
    .get(triggerCandleOpenTime);
  return Boolean(row);
}

export function logVolumeAlertScan({
  triggerCandleOpenTime,
  scannedAt,
  symbolCount,
  alertCount,
  inserted = 0,
}) {
  db.prepare(
    `INSERT INTO volume_alert_scan_log
      (trigger_candle_open_time, scanned_at, symbol_count, alert_count, inserted_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(trigger_candle_open_time) DO UPDATE SET
       scanned_at = excluded.scanned_at,
       symbol_count = excluded.symbol_count,
       alert_count = excluded.alert_count,
       inserted_count = excluded.inserted_count`
  ).run(triggerCandleOpenTime, scannedAt, symbolCount, alertCount, inserted);
}

export function getLatestVolumeAlertScan() {
  return (
    db
      .prepare(
        `SELECT trigger_candle_open_time AS triggerCandleOpenTime,
                scanned_at AS scannedAt,
                symbol_count AS symbolCount,
                alert_count AS alertCount,
                inserted_count AS insertedCount
         FROM volume_alert_scan_log
         ORDER BY trigger_candle_open_time DESC
         LIMIT 1`
      )
      .get() || null
  );
}

export function listVolumeAlertsByTrigger(triggerCandleOpenTime) {
  const trigger = Number(triggerCandleOpenTime);
  if (!Number.isFinite(trigger)) return [];
  return db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              condition_type AS conditionType,
              volume,
              avg_volume AS avgVolume,
              ratio,
              candle_open_time AS candleOpenTime,
              candle_close_time AS candleCloseTime,
              trigger_candle_open_time AS triggerCandleOpenTime,
              created_at AS createdAt
       FROM volume_alerts
       WHERE trigger_candle_open_time = ?
       ORDER BY ratio DESC, exchange_symbol ASC`
    )
    .all(trigger);
}

export function listLatestVolumeAlertBatch() {
  const scan = getLatestVolumeAlertScan();
  if (scan) {
    return { scan, alerts: listVolumeAlertsByTrigger(scan.triggerCandleOpenTime) };
  }
  const latestRow = db
    .prepare(
      `SELECT trigger_candle_open_time AS triggerCandleOpenTime,
              MAX(created_at) AS scannedAt,
              COUNT(*) AS alertCount
       FROM volume_alerts
       WHERE trigger_candle_open_time IS NOT NULL
       GROUP BY trigger_candle_open_time
       ORDER BY trigger_candle_open_time DESC
       LIMIT 1`
    )
    .get();
  if (!latestRow) return { scan: null, alerts: [] };
  return {
    scan: {
      triggerCandleOpenTime: latestRow.triggerCandleOpenTime,
      scannedAt: latestRow.scannedAt,
      symbolCount: null,
      alertCount: latestRow.alertCount,
      insertedCount: null,
    },
    alerts: listVolumeAlertsByTrigger(latestRow.triggerCandleOpenTime),
  };
}

export function listVolumeAlerts({ limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              condition_type AS conditionType,
              volume,
              avg_volume AS avgVolume,
              ratio,
              candle_open_time AS candleOpenTime,
              candle_close_time AS candleCloseTime,
              trigger_candle_open_time AS triggerCandleOpenTime,
              created_at AS createdAt
       FROM volume_alerts
       ORDER BY trigger_candle_open_time DESC, ratio DESC, exchange_symbol ASC
       LIMIT ? OFFSET ?`
    )
    .all(safeLimit, safeOffset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM volume_alerts`).get()?.count || 0;
  return { alerts: rows, total, limit: safeLimit, offset: safeOffset };
}

export function clearAllVolumeAlerts() {
  db.prepare(`DELETE FROM volume_alerts`).run();
  db.prepare(`DELETE FROM volume_alert_scan_log`).run();
  db.prepare(`DELETE FROM system_meta WHERE key = 'volume_alert_last_trigger'`).run();
}

export function listVolumeAlertHistory({ limit = 30, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const scans = db
    .prepare(
      `SELECT trigger_candle_open_time AS triggerCandleOpenTime,
              scanned_at AS scannedAt,
              symbol_count AS symbolCount,
              alert_count AS alertCount,
              inserted_count AS insertedCount
       FROM volume_alert_scan_log
       ORDER BY trigger_candle_open_time DESC
       LIMIT ? OFFSET ?`
    )
    .all(safeLimit, safeOffset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM volume_alert_scan_log`).get()?.count || 0;
  const batches = scans.map((scan) => ({
    ...scan,
    alerts: listVolumeAlertsByTrigger(scan.triggerCandleOpenTime),
  }));
  return { batches, total, limit: safeLimit, offset: safeOffset };
}

export function insertVolumeAlerts(alerts, createdAt = Date.now()) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO volume_alerts
      (id, exchange_symbol, condition_type, volume, avg_volume, ratio, candle_open_time, candle_close_time, trigger_candle_open_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  const tx = db.transaction((items) => {
    for (const raw of items) {
      const alert = normalizeVolumeAlert(raw);
      if (!alert) continue;
      const id = `va_${alert.triggerCandleOpenTime}_${alert.exchangeSymbol}_${alert.conditionType}`;
      const info = stmt.run(
        id,
        alert.exchangeSymbol,
        alert.conditionType,
        alert.volume,
        alert.avgVolume,
        alert.ratio,
        alert.candleOpenTime,
        alert.candleCloseTime,
        alert.triggerCandleOpenTime,
        createdAt
      );
      if (info.changes > 0) inserted += 1;
    }
  });
  tx(Array.isArray(alerts) ? alerts : []);
  return inserted;
}

export function computeRiskRewardRatio(entryPrice, takeProfitPrice, stopLossPrice) {
  const entry = Number(entryPrice);
  const tp = Number(takeProfitPrice);
  const sl = Number(stopLossPrice);
  if (![entry, tp, sl].every(Number.isFinite) || entry <= 0) return null;
  let risk = 0;
  let reward = 0;
  if (tp > entry && sl < entry) {
    risk = entry - sl;
    reward = tp - entry;
  } else if (tp < entry && sl > entry) {
    risk = sl - entry;
    reward = entry - tp;
  } else {
    risk = Math.abs(entry - sl);
    reward = Math.abs(tp - entry);
  }
  if (!(risk > 0)) return null;
  return reward / risk;
}

function encodeTradeResult(type, amount) {
  const t = String(type || "").trim().toLowerCase();
  if (t !== "profit" && t !== "loss") return "";
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return { error: "请填写有效的盈亏金额" };
  return JSON.stringify({ type: t, amount: n });
}

function decodeTradeResult(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { tradeResult: "", tradeResultType: null, tradeResultAmount: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && (parsed.type === "profit" || parsed.type === "loss") && Number.isFinite(Number(parsed.amount))) {
      const amount = Number(parsed.amount);
      return {
        tradeResult: text,
        tradeResultType: parsed.type,
        tradeResultAmount: amount,
      };
    }
  } catch {
    /* legacy plain text */
  }
  return { tradeResult: text, tradeResultType: null, tradeResultAmount: null };
}

const MAX_TRADE_IMAGES = 6;
const MAX_TRADE_IMAGE_BYTES = 800 * 1024;

function normalizeImageList(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    if (out.length >= MAX_TRADE_IMAGES) break;
    const url = String(item || "").trim();
    if (!/^data:image\/(jpeg|png|webp|gif);base64,/i.test(url)) continue;
    const b64 = url.split(",")[1] || "";
    const approxBytes = (b64.length * 3) / 4;
    if (approxBytes > MAX_TRADE_IMAGE_BYTES) continue;
    out.push(url);
  }
  return out;
}

function serializeImageList(raw) {
  return JSON.stringify(normalizeImageList(raw));
}

function parseImageListFromDb(raw) {
  if (Array.isArray(raw)) return normalizeImageList(raw);
  return normalizeImageList(String(raw ?? "[]"));
}

function trimText(raw) {
  return String(raw ?? "").trim();
}

function normalizeEntryConditionFields(raw) {
  const entryCondition30m = trimText(raw?.entryCondition30m ?? raw?.entry_condition_30m);
  const entryCondition4h = trimText(raw?.entryCondition4h ?? raw?.entry_condition_4h);
  const entryCondition12h = trimText(raw?.entryCondition12h ?? raw?.entry_condition_12h);
  const entryCondition1d = trimText(raw?.entryCondition1d ?? raw?.entry_condition_1d);
  const entryCondition = trimText(raw?.entryCondition ?? raw?.entry_condition);
  return {
    entryCondition30m,
    entryCondition4h,
    entryCondition12h,
    entryCondition1d,
    entryCondition,
  };
}

function mapEntryConditionFieldsFromRow(row) {
  return {
    entryCondition30m: trimText(row.entryCondition30m),
    entryCondition4h: trimText(row.entryCondition4h),
    entryCondition12h: trimText(row.entryCondition12h),
    entryCondition1d: trimText(row.entryCondition1d),
    entryCondition: trimText(row.entryCondition),
  };
}

function normalizeReviewMatchesRecord(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "yes" || v === "是" || v === "true" || v === "1") return "yes";
  if (v === "no" || v === "否" || v === "false" || v === "0") return "no";
  return "";
}

function normalizePositionSide(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "long" || v === "做多" || v === "多") return "long";
  if (v === "short" || v === "做空" || v === "空") return "short";
  return "";
}

function normalizeTradeRecordInput(raw) {
  const exchangeSymbol = String(raw?.exchangeSymbol || raw?.exchange_symbol || "")
    .trim()
    .toUpperCase();
  const positionSide = normalizePositionSide(raw?.positionSide ?? raw?.position_side);
  const entryFields = normalizeEntryConditionFields(raw);
  const entryPrice = Number(raw?.entryPrice ?? raw?.entry_price);
  const takeProfitPrice = Number(raw?.takeProfitPrice ?? raw?.take_profit_price);
  const stopLossPrice = Number(raw?.stopLossPrice ?? raw?.stop_loss_price);
  const review = String(raw?.review ?? "").trim();
  const reviewMatchesRecord = normalizeReviewMatchesRecord(
    raw?.reviewMatchesRecord ?? raw?.review_matches_record
  );
  const entryConditionImages = normalizeImageList(
    raw?.entryConditionImages ?? raw?.entry_condition_images
  );
  const reviewImages = normalizeImageList(raw?.reviewImages ?? raw?.review_images);
  const resultType = String(raw?.tradeResultType ?? raw?.trade_result_type ?? "").trim().toLowerCase();
  const resultAmountRaw = raw?.tradeResultAmount ?? raw?.trade_result_amount;
  const hasType = resultType === "profit" || resultType === "loss";
  const hasAmount =
    resultAmountRaw !== "" && resultAmountRaw != null && String(resultAmountRaw).trim() !== "";
  let tradeResult = "";
  if (hasType || hasAmount) {
    if (!hasType) return { error: "请选择盈利或亏损" };
    if (!hasAmount) return { error: "请填写盈亏金额" };
    const encoded = encodeTradeResult(resultType, resultAmountRaw);
    if (encoded?.error) return encoded;
    tradeResult = encoded;
  }
  if (!exchangeSymbol) return { error: "请填写交易币种" };
  if (![entryPrice, takeProfitPrice, stopLossPrice].every(Number.isFinite)) {
    return { error: "入场价、止盈价、止损价须为有效数字" };
  }
  const riskRewardRatio = computeRiskRewardRatio(entryPrice, takeProfitPrice, stopLossPrice);
  if (riskRewardRatio == null) return { error: "无法计算盈亏比，请检查价格" };
  return {
    exchangeSymbol,
    positionSide,
    ...entryFields,
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    riskRewardRatio,
    tradeResult,
    review,
    reviewMatchesRecord,
    entryConditionImages,
    reviewImages,
  };
}

function mapTradeRecordRow(row) {
  if (!row) return null;
  const decoded = decodeTradeResult(row.tradeResult);
  const entryFields = mapEntryConditionFieldsFromRow(row);
  return {
    id: row.id,
    exchangeSymbol: row.exchangeSymbol,
    positionSide: normalizePositionSide(row.positionSide),
    ...entryFields,
    entryConditionImages: parseImageListFromDb(row.entryConditionImages),
    entryPrice: row.entryPrice,
    takeProfitPrice: row.takeProfitPrice,
    stopLossPrice: row.stopLossPrice,
    riskRewardRatio: row.riskRewardRatio,
    tradeResult: decoded.tradeResult,
    tradeResultType: decoded.tradeResultType,
    tradeResultAmount: decoded.tradeResultAmount,
    review: row.review,
    reviewMatchesRecord: normalizeReviewMatchesRecord(row.reviewMatchesRecord),
    reviewImages: parseImageListFromDb(row.reviewImages),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listTradeRecords(userId, { limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const records = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              position_side AS positionSide,
              entry_condition AS entryCondition,
              entry_condition_30m AS entryCondition30m,
              entry_condition_4h AS entryCondition4h,
              entry_condition_12h AS entryCondition12h,
              entry_condition_1d AS entryCondition1d,
              entry_price AS entryPrice,
              take_profit_price AS takeProfitPrice,
              stop_loss_price AS stopLossPrice,
              risk_reward_ratio AS riskRewardRatio,
              trade_result AS tradeResult,
              review,
              review_matches_record AS reviewMatchesRecord,
              entry_condition_images AS entryConditionImages,
              review_images AS reviewImages,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM trade_records
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, safeLimit, safeOffset)
    .map(mapTradeRecordRow);
  const total =
    db.prepare(`SELECT COUNT(*) AS count FROM trade_records WHERE user_id = ?`).get(userId)
      ?.count || 0;
  return { records, total, limit: safeLimit, offset: safeOffset };
}

export function getTradeRecord(userId, id) {
  const row = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              position_side AS positionSide,
              entry_condition AS entryCondition,
              entry_condition_30m AS entryCondition30m,
              entry_condition_4h AS entryCondition4h,
              entry_condition_12h AS entryCondition12h,
              entry_condition_1d AS entryCondition1d,
              entry_price AS entryPrice,
              take_profit_price AS takeProfitPrice,
              stop_loss_price AS stopLossPrice,
              risk_reward_ratio AS riskRewardRatio,
              trade_result AS tradeResult,
              review,
              review_matches_record AS reviewMatchesRecord,
              entry_condition_images AS entryConditionImages,
              review_images AS reviewImages,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM trade_records
       WHERE user_id = ? AND id = ?`
    )
    .get(userId, id);
  return mapTradeRecordRow(row);
}

export function createTradeRecord(userId, raw) {
  const data = normalizeTradeRecordInput(raw);
  if (data.error) return data;
  const now = Date.now();
  const id = `tr_${now}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO trade_records
      (id, user_id, exchange_symbol, position_side, entry_condition, entry_condition_30m, entry_condition_4h,
       entry_condition_12h, entry_condition_1d, entry_price, take_profit_price,
       stop_loss_price, risk_reward_ratio, trade_result, review, review_matches_record,
       entry_condition_images, review_images, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    data.exchangeSymbol,
    data.positionSide,
    data.entryCondition,
    data.entryCondition30m,
    data.entryCondition4h,
    data.entryCondition12h,
    data.entryCondition1d,
    data.entryPrice,
    data.takeProfitPrice,
    data.stopLossPrice,
    data.riskRewardRatio,
    data.tradeResult,
    data.review,
    data.reviewMatchesRecord,
    serializeImageList(data.entryConditionImages),
    serializeImageList(data.reviewImages),
    now,
    now
  );
  return { record: getTradeRecord(userId, id) };
}

export function updateTradeRecord(userId, id, raw) {
  const existing = getTradeRecord(userId, id);
  if (!existing) return { error: "记录不存在" };
  const data = normalizeTradeRecordInput(raw);
  if (data.error) return data;
  const now = Date.now();
  db.prepare(
    `UPDATE trade_records SET
       exchange_symbol = ?,
       position_side = ?,
       entry_condition = ?,
       entry_condition_30m = ?,
       entry_condition_4h = ?,
       entry_condition_12h = ?,
       entry_condition_1d = ?,
       entry_price = ?,
       take_profit_price = ?,
       stop_loss_price = ?,
       risk_reward_ratio = ?,
       trade_result = ?,
       review = ?,
       review_matches_record = ?,
       entry_condition_images = ?,
       review_images = ?,
       updated_at = ?
     WHERE user_id = ? AND id = ?`
  ).run(
    data.exchangeSymbol,
    data.positionSide,
    data.entryCondition,
    data.entryCondition30m,
    data.entryCondition4h,
    data.entryCondition12h,
    data.entryCondition1d,
    data.entryPrice,
    data.takeProfitPrice,
    data.stopLossPrice,
    data.riskRewardRatio,
    data.tradeResult,
    data.review,
    data.reviewMatchesRecord,
    serializeImageList(data.entryConditionImages),
    serializeImageList(data.reviewImages),
    now,
    userId,
    id
  );
  return { record: getTradeRecord(userId, id) };
}

export function deleteTradeRecord(userId, id) {
  db.prepare(`DELETE FROM trade_plans WHERE user_id = ? AND trade_record_id = ?`).run(userId, id);
  const info = db.prepare(`DELETE FROM trade_records WHERE user_id = ? AND id = ?`).run(userId, id);
  return info.changes > 0;
}

function normalizePlanCreateInput(raw) {
  const exchangeSymbol = String(raw?.exchangeSymbol || raw?.exchange_symbol || "")
    .trim()
    .toUpperCase();
  const planText = String(raw?.planText ?? raw?.plan_text ?? "").trim();
  if (!exchangeSymbol) return { error: "请填写目标币种" };
  if (!planText) return { error: "请填写交易计划" };
  return { exchangeSymbol, planText };
}

function normalizeExecutionDecision(raw) {
  const v = String(raw?.executionDecision ?? raw?.execution_decision ?? raw?.executed ?? "")
    .trim()
    .toLowerCase();
  if (!v || v === "pending" || v === "observe" || v === "继续观察" || v === "待观察") return "pending";
  if (v === "not_executed" || v === "no" || v === "false" || v === "0" || v === "不执行" || v === "skipped") {
    return "not_executed";
  }
  if (v === "executed" || v === "yes" || v === "true" || v === "1" || v === "执行" || v === "execute") {
    return "executed";
  }
  return null;
}

function normalizeTradePlanInput(raw) {
  return normalizePlanCreateInput(raw);
}

function mapTradePlanRow(row) {
  if (!row) return null;
  let planStatus = String(row.planStatus || "").trim();
  if (!planStatus) {
    planStatus = row.executed ? "executed" : "pending";
  }
  return {
    id: row.id,
    exchangeSymbol: row.exchangeSymbol,
    planText: row.planText,
    executed: Boolean(row.executed),
    planStatus,
    tradeRecordId: row.tradeRecordId || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listTradePlans(userId, { limit = 50, offset = 0, executed } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  let where = "WHERE user_id = ?";
  const params = [userId];
  if (executed === true || executed === "1" || executed === "true") {
    where += " AND executed = 1";
  } else if (executed === false || executed === "0" || executed === "false") {
    where += " AND executed = 0";
  }
  const plans = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              plan_text AS planText,
              executed,
              COALESCE(plan_status, CASE WHEN executed = 1 THEN 'executed' ELSE 'pending' END) AS planStatus,
              trade_record_id AS tradeRecordId,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM trade_plans
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, safeLimit, safeOffset)
    .map(mapTradePlanRow);
  const total =
    db.prepare(`SELECT COUNT(*) AS count FROM trade_plans ${where}`).get(...params)?.count || 0;
  return { plans, total, limit: safeLimit, offset: safeOffset };
}

export function getTradePlan(userId, id) {
  const row = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              plan_text AS planText,
              executed,
              COALESCE(plan_status, CASE WHEN executed = 1 THEN 'executed' ELSE 'pending' END) AS planStatus,
              trade_record_id AS tradeRecordId,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM trade_plans
       WHERE user_id = ? AND id = ?`
    )
    .get(userId, id);
  return mapTradePlanRow(row);
}

export function getTradePlanByRecordId(userId, recordId) {
  const row = db
    .prepare(
      `SELECT id,
              exchange_symbol AS exchangeSymbol,
              plan_text AS planText,
              executed,
              COALESCE(plan_status, CASE WHEN executed = 1 THEN 'executed' ELSE 'pending' END) AS planStatus,
              trade_record_id AS tradeRecordId,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM trade_plans
       WHERE user_id = ? AND trade_record_id = ?`
    )
    .get(userId, recordId);
  return mapTradePlanRow(row);
}

export function createTradePlan(userId, raw) {
  const data = normalizePlanCreateInput(raw);
  if (data.error) return data;
  const now = Date.now();
  const id = `tp_${now}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO trade_plans
      (id, user_id, exchange_symbol, plan_text, executed, plan_status, trade_record_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'pending', NULL, ?, ?)`
  ).run(id, userId, data.exchangeSymbol, data.planText, now, now);
  return { plan: getTradePlan(userId, id) };
}

export function createTradePlanWithRecord(userId, raw) {
  const planData = normalizePlanCreateInput(raw);
  if (planData.error) return planData;
  const recordData = normalizeTradeRecordInput(raw);
  if (recordData.error) return recordData;
  if (planData.exchangeSymbol !== recordData.exchangeSymbol) {
    recordData.exchangeSymbol = planData.exchangeSymbol;
  }
  const now = Date.now();
  const planId = `tp_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const recordId = `tr_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trade_records
        (id, user_id, exchange_symbol, position_side, entry_condition, entry_condition_30m, entry_condition_4h,
         entry_condition_12h, entry_condition_1d, entry_price, take_profit_price,
         stop_loss_price, risk_reward_ratio, trade_result, review, review_matches_record,
         entry_condition_images, review_images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      recordId,
      userId,
      recordData.exchangeSymbol,
      recordData.positionSide,
      recordData.entryCondition,
      recordData.entryCondition30m,
      recordData.entryCondition4h,
      recordData.entryCondition12h,
      recordData.entryCondition1d,
      recordData.entryPrice,
      recordData.takeProfitPrice,
      recordData.stopLossPrice,
      recordData.riskRewardRatio,
      recordData.tradeResult,
      recordData.review,
      recordData.reviewMatchesRecord,
      serializeImageList(recordData.entryConditionImages),
      serializeImageList(recordData.reviewImages),
      now,
      now
    );
    db.prepare(
      `INSERT INTO trade_plans
        (id, user_id, exchange_symbol, plan_text, executed, plan_status, trade_record_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'executed', ?, ?, ?)`
    ).run(planId, userId, planData.exchangeSymbol, planData.planText, recordId, now, now);
  });
  tx();
  return {
    plan: getTradePlan(userId, planId),
    record: getTradeRecord(userId, recordId),
  };
}

export function executeTradePlan(userId, planId, raw) {
  const existing = getTradePlan(userId, planId);
  if (!existing) return { error: "计划不存在" };
  if (existing.executed || existing.planStatus === "executed") {
    return { error: "该计划已执行" };
  }
  const planFields = normalizePlanCreateInput(raw);
  if (planFields.error) return planFields;
  const recordData = normalizeTradeRecordInput(raw);
  if (recordData.error) return recordData;
  recordData.exchangeSymbol = planFields.exchangeSymbol || existing.exchangeSymbol;
  const now = Date.now();
  const recordId = `tr_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO trade_records
        (id, user_id, exchange_symbol, position_side, entry_condition, entry_condition_30m, entry_condition_4h,
         entry_condition_12h, entry_condition_1d, entry_price, take_profit_price,
         stop_loss_price, risk_reward_ratio, trade_result, review, review_matches_record,
         entry_condition_images, review_images, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      recordId,
      userId,
      recordData.exchangeSymbol,
      recordData.positionSide,
      recordData.entryCondition,
      recordData.entryCondition30m,
      recordData.entryCondition4h,
      recordData.entryCondition12h,
      recordData.entryCondition1d,
      recordData.entryPrice,
      recordData.takeProfitPrice,
      recordData.stopLossPrice,
      recordData.riskRewardRatio,
      recordData.tradeResult,
      recordData.review,
      recordData.reviewMatchesRecord,
      serializeImageList(recordData.entryConditionImages),
      serializeImageList(recordData.reviewImages),
      now,
      now
    );
    db.prepare(
      `UPDATE trade_plans SET
         exchange_symbol = ?,
         plan_text = ?,
         executed = 1,
         plan_status = 'executed',
         trade_record_id = ?,
         updated_at = ?
       WHERE user_id = ? AND id = ?`
    ).run(
      planFields.exchangeSymbol,
      planFields.planText,
      recordId,
      now,
      userId,
      planId
    );
  });
  tx();
  return {
    plan: getTradePlan(userId, planId),
    record: getTradeRecord(userId, recordId),
  };
}

export function updateTradePlan(userId, id, raw) {
  const existing = getTradePlan(userId, id);
  if (!existing) return { error: "计划不存在" };
  if (existing.executed || existing.planStatus === "executed") {
    return { error: "已执行的计划不可编辑，请编辑对应交易记录" };
  }
  const data = normalizePlanCreateInput(raw);
  if (data.error) return data;
  const decision = normalizeExecutionDecision(raw);
  if (decision === "executed") {
    return { error: "选择执行请继续填写交易记录" };
  }
  if (decision === null) return { error: "请选择是否执行" };
  const planStatus = decision === "not_executed" ? "not_executed" : "pending";
  const now = Date.now();
  db.prepare(
    `UPDATE trade_plans SET
       exchange_symbol = ?,
       plan_text = ?,
       plan_status = ?,
       updated_at = ?
     WHERE user_id = ? AND id = ?`
  ).run(data.exchangeSymbol, data.planText, planStatus, now, userId, id);
  return { plan: getTradePlan(userId, id) };
}

export function deleteTradePlan(userId, id) {
  const existing = getTradePlan(userId, id);
  if (!existing) return false;
  if (existing.executed && existing.tradeRecordId) {
    return false;
  }
  const info = db.prepare(`DELETE FROM trade_plans WHERE user_id = ? AND id = ?`).run(userId, id);
  return info.changes > 0;
}

export function listTradeJournal(userId, { limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const rows = db
    .prepare(
      `SELECT kind, id, exchangeSymbol, planText, executed, planStatus, planId,
              positionSide, entryCondition, entryCondition30m, entryCondition4h, entryCondition12h, entryCondition1d,
              entryPrice, takeProfitPrice, stopLossPrice, riskRewardRatio, tradeResult,
              review, reviewMatchesRecord, entryConditionImages, reviewImages,
              createdAt, updatedAt, sortAt
       FROM (
         SELECT 'plan' AS kind,
                p.id AS id,
                p.exchange_symbol AS exchangeSymbol,
                p.plan_text AS planText,
                p.executed AS executed,
                COALESCE(p.plan_status, CASE WHEN p.executed = 1 THEN 'executed' ELSE 'pending' END) AS planStatus,
                p.id AS planId,
                '' AS positionSide,
                '' AS entryCondition,
                '' AS entryCondition30m,
                '' AS entryCondition4h,
                '' AS entryCondition12h,
                '' AS entryCondition1d,
                NULL AS entryPrice,
                NULL AS takeProfitPrice,
                NULL AS stopLossPrice,
                NULL AS riskRewardRatio,
                '' AS tradeResult,
                '' AS review,
                '' AS reviewMatchesRecord,
                '[]' AS entryConditionImages,
                '[]' AS reviewImages,
                p.created_at AS createdAt,
                p.updated_at AS updatedAt,
                p.updated_at AS sortAt
         FROM trade_plans p
         WHERE p.user_id = ? AND p.executed = 0
         UNION ALL
         SELECT 'record' AS kind,
                r.id AS id,
                r.exchange_symbol AS exchangeSymbol,
                COALESCE(p.plan_text, '') AS planText,
                1 AS executed,
                'executed' AS planStatus,
                p.id AS planId,
                r.position_side AS positionSide,
                r.entry_condition AS entryCondition,
                r.entry_condition_30m AS entryCondition30m,
                r.entry_condition_4h AS entryCondition4h,
                r.entry_condition_12h AS entryCondition12h,
                r.entry_condition_1d AS entryCondition1d,
                r.entry_price AS entryPrice,
                r.take_profit_price AS takeProfitPrice,
                r.stop_loss_price AS stopLossPrice,
                r.risk_reward_ratio AS riskRewardRatio,
                r.trade_result AS tradeResult,
                r.review AS review,
                r.review_matches_record AS reviewMatchesRecord,
                r.entry_condition_images AS entryConditionImages,
                r.review_images AS reviewImages,
                r.created_at AS createdAt,
                r.updated_at AS updatedAt,
                r.updated_at AS sortAt
         FROM trade_records r
         LEFT JOIN trade_plans p ON p.trade_record_id = r.id AND p.user_id = r.user_id
         WHERE r.user_id = ?
       )
       ORDER BY sortAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(userId, userId, safeLimit, safeOffset);
  const planCount =
    db.prepare(`SELECT COUNT(*) AS count FROM trade_plans WHERE user_id = ? AND executed = 0`).get(userId)
      ?.count || 0;
  const recordCount =
    db.prepare(`SELECT COUNT(*) AS count FROM trade_records WHERE user_id = ?`).get(userId)?.count || 0;
  const total = planCount + recordCount;
  const items = rows.map((row) => {
    if (row.kind === "plan") {
      return {
        kind: "plan",
        id: row.id,
        exchangeSymbol: row.exchangeSymbol,
        planText: row.planText,
        executed: false,
        planStatus: row.planStatus || "pending",
        tradeRecordId: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }
    const decoded = decodeTradeResult(row.tradeResult);
    const entryFields = mapEntryConditionFieldsFromRow(row);
    return {
      kind: "record",
      id: row.id,
      exchangeSymbol: row.exchangeSymbol,
      planText: row.planText || "",
      planId: row.planId || null,
      positionSide: normalizePositionSide(row.positionSide),
      ...entryFields,
      entryConditionImages: parseImageListFromDb(row.entryConditionImages),
      entryPrice: row.entryPrice,
      takeProfitPrice: row.takeProfitPrice,
      stopLossPrice: row.stopLossPrice,
      riskRewardRatio: row.riskRewardRatio,
      tradeResult: decoded.tradeResult,
      tradeResultType: decoded.tradeResultType,
      tradeResultAmount: decoded.tradeResultAmount,
      review: row.review,
      reviewMatchesRecord: normalizeReviewMatchesRecord(row.reviewMatchesRecord),
      reviewImages: parseImageListFromDb(row.reviewImages),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
  return { items, total, limit: safeLimit, offset: safeOffset };
}

export default db;
