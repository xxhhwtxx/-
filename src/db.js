const path = require("path");
const fs = require("fs");
const { randomUUID, scryptSync, randomBytes, timingSafeEqual } = require("crypto");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key_salt TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  webhook_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_pools (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  card_type TEXT NOT NULL,
  product_code TEXT NOT NULL,
  face_value REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  card_no TEXT NOT NULL UNIQUE,
  card_secret_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  lock_token TEXT,
  lock_expired_at TEXT,
  issued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_pool_status ON cards(pool_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  external_order_no TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  product_code TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED',
  failure_code TEXT,
  failure_message TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel_id, idempotency_key),
  UNIQUE(channel_id, external_order_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_channel_status ON orders(channel_id, status);

CREATE TABLE IF NOT EXISTS issue_records (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  card_id TEXT,
  issue_status TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  response_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  webhook_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at);

CREATE TABLE IF NOT EXISTS risk_blacklist (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(type, target)
);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  order_id TEXT,
  event_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(tenant_id, created_at);
`;

function nowIso() {
  return new Date().toISOString();
}

function createApiKeyHash(apiKey) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(apiKey, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyApiKey(apiKey, salt, hash) {
  const candidate = scryptSync(apiKey, salt, 64).toString("hex");
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

async function initDb(dbFile) {
  if (dbFile !== ":memory:") {
    const dir = path.dirname(dbFile);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.exec("PRAGMA journal_mode = WAL;");
  await db.exec("PRAGMA foreign_keys = ON;");
  await db.exec(SCHEMA_SQL);
  await db.exec(`ALTER TABLE channels ADD COLUMN webhook_url TEXT`).catch(() => {});
  await db.exec(`ALTER TABLE orders ADD COLUMN paid_at TEXT`).catch(() => {});
  return db;
}

async function seedDefaults(db) {
  const now = nowIso();
  const channelId = "channel-demo";
  const apiKey = "demo-api-key";
  const poolId = "pool-demo";
  const { salt, hash } = createApiKeyHash(apiKey);
  await db.run(
    `INSERT OR IGNORE INTO channels (id, tenant_id, name, api_key_salt, api_key_hash, webhook_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [channelId, "tenant-demo", "Demo Channel", salt, hash, "http://127.0.0.1:65535/webhook", now, now],
  );
  await db.run(
    `INSERT OR IGNORE INTO card_pools (id, tenant_id, pool_name, card_type, product_code, face_value, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [poolId, "tenant-demo", "Demo Pool", "VIRTUAL", "DEMO100", 100, "CNY", now, now],
  );
  return { channelId, apiKey, poolId };
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

module.exports = { initDb, seedDefaults, nowIso, createApiKeyHash, verifyApiKey, newId };
