/**
 * SQLite memory store — L0 (conversations) + L1 (memories).
 *
 * Uses better-sqlite3 (Node 20+ compatible).
 * FTS5 for keyword search.
 *
 * File: data/memory.db (path from TDAI_DATA_DIR env).
 */

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import type { MemoryRecord } from "../tencentdb/record/l1-writer";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = process.env.TDAI_DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "memory.db");

  const db = new Database(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  // ── L0: raw conversations ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      auth_provider TEXT NOT NULL DEFAULT 'credentials',
      provider_account_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_provider ON users(auth_provider, provider_account_id);

    CREATE TABLE IF NOT EXISTS l0_conversations (
      record_id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_conversations(session_key, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
      record_id UNINDEXED,
      message_text,
      content='l0_conversations',
      content_rowid='rowid',
      tokenize='trigram'
    );
    DROP TRIGGER IF EXISTS l0_fts_insert;
    CREATE TRIGGER l0_fts_insert AFTER INSERT ON l0_conversations BEGIN
      INSERT INTO l0_fts(rowid, record_id, message_text) VALUES (new.rowid, new.record_id, new.message_text);
    END;
  `);

  // ── L1: structured memories ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS l1_records (
      record_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      scene_name TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp_str TEXT NOT NULL DEFAULT '',
      source_message_ids TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_time TEXT NOT NULL,
      updated_time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l1_session ON l1_records(session_key);
    CREATE INDEX IF NOT EXISTS idx_l1_updated ON l1_records(updated_time DESC);
    CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
      record_id UNINDEXED,
      content,
      content='l1_records',
      content_rowid='rowid',
      tokenize='trigram'
    );
    DROP TRIGGER IF EXISTS l1_fts_insert;
    DROP TRIGGER IF EXISTS l1_fts_update;
    DROP TRIGGER IF EXISTS l1_fts_delete;
    CREATE TRIGGER l1_fts_insert AFTER INSERT ON l1_records BEGIN
      INSERT INTO l1_fts(rowid, record_id, content) VALUES (new.rowid, new.record_id, new.content);
    END;
    CREATE TRIGGER l1_fts_update AFTER UPDATE ON l1_records BEGIN
      INSERT INTO l1_fts(l1_fts, rowid, record_id, content) VALUES ('delete', old.rowid, old.record_id, old.content);
      INSERT INTO l1_fts(rowid, record_id, content) VALUES (new.rowid, new.record_id, new.content);
    END;
    CREATE TRIGGER l1_fts_delete AFTER DELETE ON l1_records BEGIN
      INSERT INTO l1_fts(l1_fts, rowid, record_id, content) VALUES ('delete', old.rowid, old.record_id, old.content);
    END;
  `);

  // ── Pipeline state ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── Aha history (every detected Aha is appended; nothing is overwritten) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS aha_history (
      id TEXT PRIMARY KEY,
      detected_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aha_history_detected ON aha_history(detected_at DESC);
  `);

  // ── Migration: rebuild FTS with trigram tokenizer if needed ──
  migrateFtsTrigram(db);
  seedTestUser(db);

  _db = db;
  return _db;
}

function migrateFtsTrigram(db: Database.Database) {
  const FTS_VERSION = 4;
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version >= FTS_VERSION) return;

  const rebuild = (table: string, parent: string, col: string) => {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
    db.exec(`
      CREATE VIRTUAL TABLE ${table} USING fts5(
        record_id UNINDEXED,
        ${col},
        content='${parent}',
        content_rowid='rowid',
        tokenize='trigram'
      );
    `);
    // For contentless FTS, 'rebuild' scans the source table using its rowids.
    db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild');`);
  };

  rebuild("l0_fts", "l0_conversations", "message_text");
  rebuild("l1_fts", "l1_records", "content");
  db.exec(`PRAGMA user_version = ${FTS_VERSION}`);
}

export interface UserRecord {
  user_id: string;
  email: string;
  name: string;
  image: string;
  password_hash: string | null;
  auth_provider: string;
  provider_account_id: string;
  created_at: string;
  updated_at: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function seedTestUser(db: Database.Database) {
  const email = process.env.AUTH_TEST_EMAIL?.trim().toLowerCase();
  const password = process.env.AUTH_TEST_PASSWORD ?? "";
  if (!email || !password) return;

  const existing = db.prepare("SELECT user_id FROM users WHERE email = ?").get(email);
  if (existing) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users
      (user_id, email, name, image, password_hash, auth_provider, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `user_test_${crypto.createHash("sha256").update(email).digest("hex").slice(0, 12)}`,
    email,
    "Test User",
    "",
    hashPassword(password),
    "credentials",
    "",
    now,
    now,
  );
}

export function createEmailUser(email: string, password: string): UserRecord {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const now = new Date().toISOString();
  const userId = `user_${crypto.randomBytes(8).toString("hex")}`;
  db.prepare(`
    INSERT INTO users
      (user_id, email, name, image, password_hash, auth_provider, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, normalized, normalized, "", hashPassword(password), "credentials", "", now, now);
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRecord;
}

export function getUserByEmail(email: string): UserRecord | null {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  return db.prepare("SELECT * FROM users WHERE email = ?").get(normalized) as UserRecord | undefined ?? null;
}

export function getUserById(userId: string): UserRecord | null {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as UserRecord | undefined ?? null;
}

export function findOrCreateOAuthUser(params: {
  provider: string;
  providerAccountId: string;
  email: string;
  name?: string | null;
  image?: string | null;
}): UserRecord {
  const db = getDb();
  const email = params.email.trim().toLowerCase();
  const now = new Date().toISOString();
  const existing = getUserByEmail(email);
  if (existing) {
    db.prepare(`
      UPDATE users
      SET name = COALESCE(NULLIF(?, ''), name),
          image = COALESCE(NULLIF(?, ''), image),
          auth_provider = ?,
          provider_account_id = ?,
          updated_at = ?
      WHERE user_id = ?
    `).run(params.name ?? "", params.image ?? "", params.provider, params.providerAccountId, now, existing.user_id);
    return getUserById(existing.user_id) ?? existing;
  }

  const userId = `user_${crypto.randomUUID()}`;
  db.prepare(`
    INSERT INTO users
      (user_id, email, name, image, password_hash, auth_provider, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    userId,
    email,
    params.name ?? "",
    params.image ?? "",
    params.provider,
    params.providerAccountId,
    now,
    now,
  );
  return getUserById(userId)!;
}

// ============================
// L0 Operations
// ============================

export interface L0Message {
  record_id: string;
  session_key: string;
  session_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

export function insertL0(msg: L0Message): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO l0_conversations
      (record_id, session_key, session_id, role, message_text, recorded_at, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(msg.record_id, msg.session_key, msg.session_id, msg.role, msg.message_text, msg.recorded_at, msg.timestamp);
}

export function queryL0ForSession(sessionKey: string, limit = 100): L0Message[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM l0_conversations
    WHERE session_key = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(sessionKey, limit) as L0Message[];
}

export function queryL0HistoryForSession(sessionKey: string, limit = 100): L0Message[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM (
      SELECT * FROM l0_conversations
      WHERE session_key = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
    ORDER BY timestamp ASC
  `).all(sessionKey, limit) as L0Message[];
}

export function queryL0RecentMessages(sessionKey: string, afterTimestamp: number, limit = 50): L0Message[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM l0_conversations
    WHERE session_key = ? AND timestamp > ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(sessionKey, afterTimestamp, limit) as L0Message[];
}

export function searchL0Fts(query: string, limit = 20): L0Message[] {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT c.* FROM l0_fts f
      JOIN l0_conversations c ON c.record_id = f.record_id
      WHERE l0_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(buildFtsQuery(query), limit) as L0Message[];
  } catch {
    return [];
  }
}

export function queryL0ByIds(ids: string[]): L0Message[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(`
    SELECT * FROM l0_conversations WHERE record_id IN (${placeholders})
  `).all(...ids) as L0Message[];
}

// ============================
// L1 Operations
// ============================

export function upsertL1(record: MemoryRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO l1_records
      (record_id, content, type, priority, scene_name, session_key, session_id,
       timestamp_str, source_message_ids, metadata_json, created_time, updated_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id, record.content, record.type, record.priority,
    record.scene_name, record.sessionKey, record.sessionId,
    record.timestamps[0] ?? record.createdAt,
    JSON.stringify(record.source_message_ids),
    JSON.stringify(record.metadata),
    record.createdAt, record.updatedAt,
  );
}

export function deleteL1(recordId: string): void {
  getDb().prepare("DELETE FROM l1_records WHERE record_id = ?").run(recordId);
}

export function deleteL1Batch(recordIds: string[]): void {
  if (recordIds.length === 0) return;
  const placeholders = recordIds.map(() => "?").join(",");
  getDb().prepare(`DELETE FROM l1_records WHERE record_id IN (${placeholders})`).run(...recordIds);
}

export function searchL1Fts(query: string, limit = 15): MemoryRecord[] {
  const db = getDb();
  const fts = buildFtsQuery(query);
  try {
    const rows = db.prepare(`
      SELECT r.* FROM l1_fts f
      JOIN l1_records r ON r.record_id = f.record_id
      WHERE l1_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(fts, limit) as any[];
    return rows.map(rowToMemoryRecord);
  } catch (err) {
    console.error("[searchL1Fts] query=%s fts=%s err=%s", query, fts, (err as Error).message);
    return [];
  }
}

export function queryAllL1(limit = 200): MemoryRecord[] {
  const rows = getDb().prepare(`
    SELECT * FROM l1_records ORDER BY updated_time DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToMemoryRecord);
}

export function queryL1ByIds(ids: string[]): MemoryRecord[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM l1_records WHERE record_id IN (${placeholders})
  `).all(...ids) as any[];
  return rows.map(rowToMemoryRecord);
}

export function countL1(): number {
  const row = getDb().prepare("SELECT COUNT(*) as n FROM l1_records").get() as { n: number };
  return row.n;
}

export function countL0(): number {
  const row = getDb().prepare("SELECT COUNT(*) as n FROM l0_conversations").get() as { n: number };
  return row.n;
}

// ============================
// Pipeline State
// ============================

export function getPipelineState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM pipeline_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPipelineState(key: string, value: string): void {
  getDb().prepare("INSERT OR REPLACE INTO pipeline_state (key, value) VALUES (?, ?)").run(key, value);
}

// ============================
// Aha History
// ============================

export interface AhaHistoryRow {
  id: string;
  detected_at: string;
  payload_json: string;
}

export function appendAhaHistory(id: string, detectedAt: string, payloadJson: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO aha_history (id, detected_at, payload_json) VALUES (?, ?, ?)")
    .run(id, detectedAt, payloadJson);
}

export function listAhaHistory(limit = 30): AhaHistoryRow[] {
  return getDb()
    .prepare("SELECT id, detected_at, payload_json FROM aha_history ORDER BY detected_at DESC LIMIT ?")
    .all(limit) as AhaHistoryRow[];
}

export function getAhaById(id: string): AhaHistoryRow | null {
  const row = getDb()
    .prepare("SELECT id, detected_at, payload_json FROM aha_history WHERE id = ?")
    .get(id) as AhaHistoryRow | undefined;
  return row ?? null;
}

// ============================
// Helpers
// ============================

function buildFtsQuery(text: string): string {
  // trigram tokenizer wants quoted substrings; FTS5 OR over phrases.
  const cleaned = text.replace(/["']/g, " ").trim();
  if (!cleaned) return '""';
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length >= 3 || /^[a-zA-Z0-9]+$/.test(t))
    .slice(0, 6);
  if (tokens.length === 0) {
    return cleaned.length >= 3 ? `"${cleaned.replace(/"/g, "")}"` : '""';
  }
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

function rowToMemoryRecord(row: any): MemoryRecord {
  return {
    id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name ?? "",
    source_message_ids: JSON.parse(row.source_message_ids ?? "[]"),
    metadata: JSON.parse(row.metadata_json ?? "{}"),
    timestamps: [row.timestamp_str].filter(Boolean),
    createdAt: row.created_time,
    updatedAt: row.updated_time,
    sessionKey: row.session_key,
    sessionId: row.session_id,
  };
}
