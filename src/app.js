const express = require("express");
const rateLimit = require("express-rate-limit");
const { initDb, seedDefaults, createApiKeyHash, verifyApiKey, nowIso, newId } = require("./db");
const {
  createOrder,
  getOrderResponse,
  badRequest,
  markOrderPaidAndIssue,
  processWebhookRetries,
  isRequestBlocked,
} = require("./service");
const { encryptSecret, verifySignature, isTimestampFresh } = require("./security");

function parseJson() {
  return express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function createApp({ dbFile = process.env.DB_FILE || "/home/runner/work/-/-/data/card_issuing.db" } = {}) {
  const db = await initDb(dbFile);
  const defaults = await seedDefaults(db);

  const app = express();
  app.set("db", db);
  app.set("defaults", defaults);
  app.use(parseJson());
  app.use(
    "/v1",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "too many requests" },
    }),
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const adminToken = process.env.ADMIN_TOKEN || "admin-dev-token";
  const requireAdmin = (req, res, next) => {
    if (req.headers["x-admin-token"] !== adminToken) return res.status(401).json({ error: "unauthorized" });
    next();
  };

  const requireChannel = asyncRoute(async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || typeof apiKey !== "string") return res.status(401).json({ error: "missing api key" });
    const channels = await db.all(`SELECT * FROM channels WHERE status = 'ACTIVE'`);
    const channel = channels.find((item) => verifyApiKey(apiKey, item.api_key_salt, item.api_key_hash));
    if (!channel) return res.status(401).json({ error: "invalid api key" });

    const signature = req.headers["x-signature"];
    const timestamp = req.headers["x-timestamp"];
    const requireSignature = process.env.REQUIRE_SIGNATURE === "true";
    if (requireSignature || signature || timestamp) {
      if (!signature || !timestamp || !isTimestampFresh(timestamp)) {
        return res.status(401).json({ error: "invalid signature headers" });
      }
      const ok = verifySignature({
        method: req.method,
        path: req.path,
        timestamp,
        rawBody: req.rawBody || "",
        signature,
        secret: apiKey,
      });
      if (!ok) return res.status(401).json({ error: "signature verification failed" });
    }
    const blockedRule = await isRequestBlocked(db, { channel, sourceIp: req.ip });
    if (blockedRule) return res.status(403).json({ error: "blocked by risk policy" });
    req.channel = channel;
    next();
  });

  app.post(
    "/v1/admin/channels",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { tenantId, name, apiKey, webhookUrl = null } = req.body || {};
      if (!tenantId || !name || !apiKey) throw badRequest("tenantId, name, apiKey are required");
      const now = nowIso();
      const id = newId("chn");
      const { salt, hash } = createApiKeyHash(apiKey);
      await db.run(
        `INSERT INTO channels (id, tenant_id, name, api_key_salt, api_key_hash, webhook_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, name, salt, hash, webhookUrl, now, now],
      );
      res.status(201).json({ channelId: id });
    }),
  );

  app.post(
    "/v1/admin/card-pools",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { tenantId, poolName, productCode, faceValue, currency, cardType = "VIRTUAL" } = req.body || {};
      if (!tenantId || !poolName || !productCode || !faceValue || !currency) {
        throw badRequest("tenantId, poolName, productCode, faceValue, currency are required");
      }
      const now = nowIso();
      const id = newId("pool");
      await db.run(
        `INSERT INTO card_pools (id, tenant_id, pool_name, card_type, product_code, face_value, currency, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, tenantId, poolName, cardType, productCode, Number(faceValue), currency, now, now],
      );
      res.status(201).json({ poolId: id });
    }),
  );

  app.post(
    "/v1/inventory/cards/import",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { poolId, cards } = req.body || {};
      if (!poolId || !Array.isArray(cards) || cards.length === 0) throw badRequest("poolId and cards are required");
      const pool = await db.get(`SELECT id FROM card_pools WHERE id = ?`, [poolId]);
      if (!pool) throw badRequest("pool not found");

      let inserted = 0;
      const now = nowIso();
      for (const item of cards) {
        if (!item?.cardNo || !item?.cardSecret) continue;
        const result = await db.run(
          `INSERT OR IGNORE INTO cards (id, pool_id, card_no, card_secret_ciphertext, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'AVAILABLE', ?, ?)`,
          [newId("card"), poolId, item.cardNo, encryptSecret(item.cardSecret), now, now],
        );
        inserted += result.changes;
      }
      res.json({ inserted });
    }),
  );

  app.post(
    "/v1/orders",
    requireChannel,
    asyncRoute(async (req, res) => {
      const result = await createOrder(db, req.channel, req.body || {});
      res.status(200).json(result);
    }),
  );

  app.get(
    "/v1/orders/:orderId",
    requireChannel,
    asyncRoute(async (req, res) => {
      const result = await getOrderResponse(db, req.params.orderId, req.channel.id);
      res.json(result);
    }),
  );

  app.post(
    "/v1/payments/callback",
    requireChannel,
    asyncRoute(async (req, res) => {
      const result = await markOrderPaidAndIssue(db, req.channel, req.body || {});
      res.json(result);
    }),
  );

  app.post(
    "/v1/admin/webhooks/retry",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const limit = Number(req.body?.limit || 20);
      const result = await processWebhookRetries(db, limit);
      res.json(result);
    }),
  );

  app.get(
    "/v1/admin/risk/blacklist",
    requireAdmin,
    asyncRoute(async (_req, res) => {
      const items = await db.all(`SELECT id, type, target, reason, status, created_at, updated_at FROM risk_blacklist ORDER BY created_at DESC`);
      res.json({ items });
    }),
  );

  app.post(
    "/v1/admin/risk/blacklist",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { type, target, reason = "" } = req.body || {};
      if (!type || !target) throw badRequest("type and target are required");
      if (!["CHANNEL", "IP"].includes(type)) throw badRequest("type must be CHANNEL or IP");
      const now = nowIso();
      await db.run(
        `INSERT INTO risk_blacklist (id, type, target, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)
         ON CONFLICT(type, target) DO UPDATE SET reason=excluded.reason, status='ACTIVE', updated_at=excluded.updated_at`,
        [newId("blk"), type, target, reason, now, now],
      );
      res.status(201).json({ ok: true });
    }),
  );

  app.delete(
    "/v1/admin/risk/blacklist",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { type, target } = req.body || {};
      if (!type || !target) throw badRequest("type and target are required");
      await db.run(`UPDATE risk_blacklist SET status='INACTIVE', updated_at=? WHERE type=? AND target=?`, [nowIso(), type, target]);
      res.json({ ok: true });
    }),
  );

  app.get(
    "/v1/admin/dashboard",
    requireAdmin,
    asyncRoute(async (_req, res) => {
      const orderStats = await db.all(`SELECT status, COUNT(1) AS count FROM orders GROUP BY status`);
      const pendingWebhooks = await db.get(`SELECT COUNT(1) AS count FROM webhook_deliveries WHERE status='PENDING'`);
      const activeBlacklist = await db.get(`SELECT COUNT(1) AS count FROM risk_blacklist WHERE status='ACTIVE'`);
      const latestRisks = await db.all(
        `SELECT event_type, risk_level, details, created_at FROM risk_events ORDER BY created_at DESC LIMIT 10`,
      );
      const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>发卡后台</title></head>
<body>
<h1>发卡后台</h1>
<h2>订单状态</h2>
<ul>${orderStats.map((s) => `<li>${s.status}: ${s.count}</li>`).join("") || "<li>暂无数据</li>"}</ul>
<h2>Webhook</h2>
<p>待重试: ${pendingWebhooks?.count || 0}</p>
<h2>风控黑名单</h2>
<p>生效规则: ${activeBlacklist?.count || 0}</p>
<h2>最新风险事件</h2>
<ul>${latestRisks
  .map((item) => `<li>${item.created_at} ${item.event_type} ${item.risk_level} ${item.details || ""}</li>`)
  .join("") || "<li>暂无事件</li>"}</ul>
</body></html>`;
      res.type("html").send(html);
    }),
  );

  app.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || "internal error" });
  });

  return app;
}

module.exports = { createApp };
