const { newId, nowIso } = require("./db");
const { decryptSecret, maskCard } = require("./security");

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

async function getOrderResponse(db, orderId, channelId) {
  const order = await db.get(`SELECT * FROM orders WHERE id = ? AND channel_id = ?`, [orderId, channelId]);
  if (!order) {
    const err = new Error("order not found");
    err.statusCode = 404;
    throw err;
  }
  const issue = await db.get(`SELECT * FROM issue_records WHERE order_id = ?`, [order.id]);
  const payload = issue?.response_payload ? JSON.parse(issue.response_payload) : null;
  return {
    orderId: order.id,
    status: order.status,
    paidAt: order.paid_at || null,
    issueStatus: issue?.issue_status || null,
    failureCode: order.failure_code || null,
    failureMessage: order.failure_message || null,
    cardMasked: payload?.cardMasked || null,
    cardNo: payload?.cardNo || null,
    cardSecret: payload?.cardSecret || null,
  };
}

async function createRiskEvent(db, { tenantId, orderId = null, eventType, riskLevel, details }) {
  const now = nowIso();
  await db.run(
    `INSERT INTO risk_events (id, tenant_id, order_id, event_type, risk_level, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("risk"), tenantId, orderId, eventType, riskLevel, JSON.stringify(details || {}), now],
  );
}

async function findBlacklistRule(db, { channelId, sourceIp }) {
  const conditions = [`(type = 'CHANNEL' AND target = ?)`];
  const args = [channelId];
  if (sourceIp) {
    conditions.push(`(type = 'IP' AND target = ?)`);
    args.push(sourceIp);
  }
  return db.get(
    `SELECT * FROM risk_blacklist WHERE status='ACTIVE' AND (${conditions.join(" OR ")}) ORDER BY created_at ASC LIMIT 1`,
    args,
  );
}

async function isRequestBlocked(db, { channel, sourceIp }) {
  const rule = await findBlacklistRule(db, { channelId: channel.id, sourceIp });
  if (!rule) return null;
  await createRiskEvent(db, {
    tenantId: channel.tenant_id,
    eventType: "BLACKLIST_HIT",
    riskLevel: "HIGH",
    details: { type: rule.type, target: rule.target, reason: rule.reason || "" },
  });
  return rule;
}

async function failOrder(db, orderId, failureCode, failureMessage) {
  const now = nowIso();
  await db.run(`UPDATE orders SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?`, [
    failureCode,
    failureMessage,
    now,
    orderId,
  ]);
  await db.run(
    `INSERT INTO issue_records (id, order_id, issue_status, response_payload, created_at, updated_at)
     VALUES (?, ?, 'FAILED', ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET issue_status='FAILED', response_payload=excluded.response_payload, updated_at=excluded.updated_at`,
    [newId("iss"), orderId, JSON.stringify({ failureCode, failureMessage }), now, now],
  );
}

async function postWebhook(url, payload, timeoutMs = 5_000) {
  if (typeof fetch !== "function") throw new Error("fetch unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function nextRetryAt(attemptCount) {
  const delaySeconds = Math.min(30 * attemptCount, 300);
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function attemptWebhookDelivery(db, deliveryId, maxAttempts = 3) {
  const delivery = await db.get(`SELECT * FROM webhook_deliveries WHERE id = ?`, [deliveryId]);
  if (!delivery || delivery.status === "SUCCESS" || delivery.status === "FAILED") return delivery;

  const attemptCount = Number(delivery.attempt_count || 0) + 1;
  try {
    const response = await postWebhook(delivery.webhook_url, JSON.parse(delivery.payload));
    if (response.ok) {
      await db.run(
        `UPDATE webhook_deliveries
         SET status='SUCCESS', attempt_count=?, last_error=NULL, next_retry_at=NULL, updated_at=?
         WHERE id=?`,
        [attemptCount, nowIso(), deliveryId],
      );
      return { ...delivery, status: "SUCCESS", attempt_count: attemptCount };
    }
    throw new Error(`http_${response.status}`);
  } catch (error) {
    const isFinal = attemptCount >= maxAttempts;
    const status = isFinal ? "FAILED" : "PENDING";
    await db.run(
      `UPDATE webhook_deliveries
       SET status=?, attempt_count=?, last_error=?, next_retry_at=?, updated_at=?
       WHERE id=?`,
      [status, attemptCount, error.message, isFinal ? null : nextRetryAt(attemptCount), nowIso(), deliveryId],
    );
    return { ...delivery, status, attempt_count: attemptCount };
  }
}

async function enqueueWebhookDelivery(db, order, issue) {
  const channel = await db.get(`SELECT id, webhook_url FROM channels WHERE id = ?`, [order.channel_id]);
  if (!channel?.webhook_url) return null;
  const now = nowIso();
  const payload = {
    eventId: newId("evt"),
    type: "ORDER_ISSUED",
    orderId: order.id,
    externalOrderNo: order.external_order_no,
    status: order.status,
    issueStatus: issue?.issue_status || null,
    response: issue?.response_payload ? JSON.parse(issue.response_payload) : null,
    sentAt: now,
  };
  const deliveryId = newId("wh");
  await db.run(
    `INSERT INTO webhook_deliveries
     (id, order_id, channel_id, webhook_url, payload, status, attempt_count, next_retry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
    [deliveryId, order.id, channel.id, channel.webhook_url, JSON.stringify(payload), now, now, now],
  );
  await attemptWebhookDelivery(db, deliveryId);
  return deliveryId;
}

async function notifyOrderResult(db, orderId) {
  const order = await db.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order) return;
  const issue = await db.get(`SELECT * FROM issue_records WHERE order_id = ?`, [order.id]);
  await enqueueWebhookDelivery(db, order, issue);
}

async function processIssue(db, orderId) {
  const now = nowIso();
  let shouldNotify = false;
  await db.exec("BEGIN IMMEDIATE");
  try {
    const order = await db.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    if (!order) throw badRequest("order not found");
    if (order.status === "SUCCESS" || order.status === "FAILED") {
      await db.exec("COMMIT");
      return;
    }
    shouldNotify = true;

    if (!order.paid_at) {
      await failOrder(db, orderId, "PAYMENT_REQUIRED", "Payment callback required before issuing");
      await db.exec("COMMIT");
      return;
    }

    await db.run(`UPDATE orders SET status='PROCESSING', updated_at=? WHERE id=?`, [now, orderId]);

    const blockedRule = await findBlacklistRule(db, { channelId: order.channel_id });
    if (blockedRule) {
      await failOrder(db, orderId, "BLACKLISTED", "Order blocked by risk blacklist");
      await createRiskEvent(db, {
        tenantId: order.tenant_id,
        orderId,
        eventType: "ORDER_BLOCKED",
        riskLevel: "HIGH",
        details: { type: blockedRule.type, target: blockedRule.target, reason: blockedRule.reason || "" },
      });
      await db.exec("COMMIT");
      return;
    }

    const pool = await db.get(
      `SELECT * FROM card_pools WHERE tenant_id = ? AND product_code = ? AND status = 'ACTIVE' LIMIT 1`,
      [order.tenant_id, order.product_code],
    );
    if (!pool) {
      await failOrder(db, orderId, "POOL_NOT_FOUND", "No card pool matched product");
      await db.exec("COMMIT");
      return;
    }

    const card = await db.get(
      `SELECT * FROM cards WHERE pool_id = ? AND status = 'AVAILABLE' ORDER BY created_at ASC LIMIT 1`,
      [pool.id],
    );
    if (!card) {
      await failOrder(db, orderId, "OUT_OF_STOCK", "No available card inventory");
      await db.exec("COMMIT");
      return;
    }

    const lockToken = newId("lock");
    const lockUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const lockResult = await db.run(
      `UPDATE cards
       SET status='LOCKED', lock_token=?, lock_expired_at=?, updated_at=?
       WHERE id=? AND status='AVAILABLE'`,
      [lockToken, lockUntil, now, card.id],
    );
    if (lockResult.changes !== 1) {
      await failOrder(db, orderId, "LOCK_CONFLICT", "Failed to lock inventory");
      await db.exec("COMMIT");
      return;
    }

    const cardSecret = decryptSecret(card.card_secret_ciphertext);
    await db.run(
      `UPDATE cards
       SET status='ISSUED', issued_at=?, lock_token=NULL, lock_expired_at=NULL, updated_at=?
       WHERE id=?`,
      [now, now, card.id],
    );
    const responsePayload = {
      cardNo: card.card_no,
      cardSecret,
      cardMasked: maskCard(card.card_no),
    };
    await db.run(
      `INSERT INTO issue_records (id, order_id, card_id, issue_status, response_payload, created_at, updated_at)
       VALUES (?, ?, ?, 'SUCCESS', ?, ?, ?)`,
      [newId("iss"), orderId, card.id, JSON.stringify(responsePayload), now, now],
    );
    await db.run(`UPDATE orders SET status='SUCCESS', updated_at=? WHERE id=?`, [now, orderId]);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
  if (shouldNotify) {
    await notifyOrderResult(db, orderId);
  }
}

async function createOrder(db, channel, body) {
  const required = ["idempotencyKey", "externalOrderNo", "productCode", "amount", "currency"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw badRequest(`missing field: ${field}`);
    }
  }
  const quantity = Number(body.quantity || 1);
  if (quantity !== 1) throw badRequest("MVP only supports quantity=1");
  const now = nowIso();
  const orderId = newId("ord");
  try {
    await db.run(
      `INSERT INTO orders (id, tenant_id, channel_id, external_order_no, idempotency_key, product_code, quantity, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)`,
      [
        orderId,
        channel.tenant_id,
        channel.id,
        body.externalOrderNo,
        body.idempotencyKey,
        body.productCode,
        quantity,
        Number(body.amount),
        body.currency,
        now,
        now,
      ],
    );
  } catch {
    const existing = await db.get(
      `SELECT id FROM orders WHERE channel_id = ? AND idempotency_key = ?`,
      [channel.id, body.idempotencyKey],
    );
    if (existing) return getOrderResponse(db, existing.id, channel.id);
    throw badRequest("external order already exists");
  }
  return getOrderResponse(db, orderId, channel.id);
}

async function markOrderPaidAndIssue(db, channel, body) {
  const { externalOrderNo, paymentStatus, paidAt } = body || {};
  if (!externalOrderNo || !paymentStatus) throw badRequest("externalOrderNo and paymentStatus are required");
  const order = await db.get(`SELECT * FROM orders WHERE channel_id = ? AND external_order_no = ?`, [
    channel.id,
    externalOrderNo,
  ]);
  if (!order) {
    const err = new Error("order not found");
    err.statusCode = 404;
    throw err;
  }

  if (order.status === "SUCCESS" || order.status === "FAILED") {
    return getOrderResponse(db, order.id, channel.id);
  }

  if (paymentStatus !== "SUCCESS") {
    await failOrder(db, order.id, "PAYMENT_FAILED", `Payment status: ${paymentStatus}`);
    await notifyOrderResult(db, order.id);
    return getOrderResponse(db, order.id, channel.id);
  }

  await db.run(`UPDATE orders SET status='PAID', paid_at=?, updated_at=? WHERE id = ?`, [
    paidAt || nowIso(),
    nowIso(),
    order.id,
  ]);
  await processIssue(db, order.id);
  return getOrderResponse(db, order.id, channel.id);
}

async function processWebhookRetries(db, limit = 20) {
  const now = nowIso();
  const items = await db.all(
    `SELECT id FROM webhook_deliveries
     WHERE status = 'PENDING' AND next_retry_at <= ?
     ORDER BY next_retry_at ASC
     LIMIT ?`,
    [now, Number(limit)],
  );
  let retried = 0;
  for (const item of items) {
    await attemptWebhookDelivery(db, item.id);
    retried += 1;
  }
  return { retried };
}

module.exports = {
  createOrder,
  getOrderResponse,
  badRequest,
  markOrderPaidAndIssue,
  processWebhookRetries,
  isRequestBlocked,
};
