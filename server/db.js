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

function normalizeTradeRecordInput(raw) {
  const exchangeSymbol = String(raw?.exchangeSymbol || raw?.exchange_symbol || "")
    .trim()
    .toUpperCase();
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
      (id, user_id, exchange_symbol, entry_condition, entry_condition_30m, entry_condition_4h,
       entry_condition_12h, entry_condition_1d, entry_price, take_profit_price,
       stop_loss_price, risk_reward_ratio, trade_result, review, review_matches_record,
       entry_condition_images, review_images, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    data.exchangeSymbol,
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
  const info = db.prepare(`DELETE FROM trade_records WHERE user_id = ? AND id = ?`).run(userId, id);
  return info.changes > 0;
}

export default db;
