const express = require("express");
const { initDb, seedDefaults, hashApiKey, nowIso, newId } = require("./db");
const { createOrder, getOrderResponse, badRequest } = require("./service");
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

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const adminToken = process.env.ADMIN_TOKEN || "admin-dev-token";
  const requireAdmin = (req, res, next) => {
    if (req.headers["x-admin-token"] !== adminToken) return res.status(401).json({ error: "unauthorized" });
    next();
  };

  const requireChannel = asyncRoute(async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || typeof apiKey !== "string") return res.status(401).json({ error: "missing api key" });
    const channel = await db.get(`SELECT * FROM channels WHERE api_key_hash = ? AND status = 'ACTIVE'`, [hashApiKey(apiKey)]);
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
    req.channel = channel;
    next();
  });

  app.post(
    "/v1/admin/channels",
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { tenantId, name, apiKey } = req.body || {};
      if (!tenantId || !name || !apiKey) throw badRequest("tenantId, name, apiKey are required");
      const now = nowIso();
      const id = newId("chn");
      await db.run(
        `INSERT INTO channels (id, tenant_id, name, api_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, tenantId, name, hashApiKey(apiKey), now, now],
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

  app.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message || "internal error" });
  });

  return app;
}

module.exports = { createApp };
