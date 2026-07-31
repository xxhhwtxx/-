CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  role VARCHAR(32) NOT NULL,
  username VARCHAR(128) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE channels (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  api_key VARCHAR(128) NOT NULL UNIQUE,
  webhook_url VARCHAR(512),
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE card_pools (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  pool_name VARCHAR(128) NOT NULL,
  card_type VARCHAR(32) NOT NULL,
  product_code VARCHAR(64) NOT NULL,
  face_value DECIMAL(18,2) NOT NULL,
  currency VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE cards (
  id BIGINT PRIMARY KEY,
  pool_id BIGINT NOT NULL,
  card_no VARCHAR(128) NOT NULL UNIQUE,
  card_secret_ciphertext TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'AVAILABLE',
  lock_token VARCHAR(128),
  lock_expired_at TIMESTAMP,
  issued_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_cards_pool_status ON cards(pool_id, status);
CREATE INDEX idx_cards_lock_expired ON cards(lock_expired_at);

CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  external_order_no VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  product_code VARCHAR(64) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  amount DECIMAL(18,2) NOT NULL,
  currency VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'CREATED',
  failure_code VARCHAR(64),
  failure_message VARCHAR(255),
  paid_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  UNIQUE(channel_id, idempotency_key),
  UNIQUE(channel_id, external_order_no)
);

CREATE INDEX idx_orders_channel_status ON orders(channel_id, status);
CREATE INDEX idx_orders_created_at ON orders(created_at);

CREATE TABLE issue_records (
  id BIGINT PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE,
  card_id BIGINT,
  issue_status VARCHAR(32) NOT NULL,
  retry_count INT NOT NULL DEFAULT 0,
  response_payload TEXT,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE audit_logs (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  actor_id BIGINT,
  actor_role VARCHAR(32),
  action VARCHAR(128) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(128) NOT NULL,
  request_id VARCHAR(128),
  source_ip VARCHAR(64),
  metadata TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_audit_tenant_created ON audit_logs(tenant_id, created_at);

CREATE TABLE risk_events (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  order_id BIGINT,
  event_type VARCHAR(64) NOT NULL,
  risk_level VARCHAR(32) NOT NULL,
  details TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_risk_tenant_created ON risk_events(tenant_id, created_at);
