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
  if (
    !exchangeSymbol ||
    !conditionType ||
    !Number.isFinite(volume) ||
    !Number.isFinite(avgVolume) ||
    !Number.isFinite(ratio) ||
    !Number.isFinite(candleOpenTime) ||
    !Number.isFinite(candleCloseTime)
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
              created_at AS createdAt
       FROM volume_alerts
       ORDER BY created_at DESC, exchange_symbol ASC
       LIMIT ? OFFSET ?`
    )
    .all(safeLimit, safeOffset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM volume_alerts`).get()?.count || 0;
  return { alerts: rows, total, limit: safeLimit, offset: safeOffset };
}

export function insertVolumeAlerts(alerts, createdAt = Date.now()) {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO volume_alerts
      (id, exchange_symbol, condition_type, volume, avg_volume, ratio, candle_open_time, candle_close_time, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  const tx = db.transaction((items) => {
    for (const raw of items) {
      const alert = normalizeVolumeAlert(raw);
      if (!alert) continue;
      const id = `va_${alert.candleOpenTime}_${alert.exchangeSymbol}_${alert.conditionType}`;
      const info = stmt.run(
        id,
        alert.exchangeSymbol,
        alert.conditionType,
        alert.volume,
        alert.avgVolume,
        alert.ratio,
        alert.candleOpenTime,
        alert.candleCloseTime,
        createdAt
      );
      if (info.changes > 0) inserted += 1;
    }
  });
  tx(Array.isArray(alerts) ? alerts : []);
  return inserted;
}

export default db;
