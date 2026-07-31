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
    issueStatus: issue?.issue_status || null,
    failureCode: order.failure_code || null,
    failureMessage: order.failure_message || null,
    cardMasked: payload?.cardMasked || null,
    cardNo: payload?.cardNo || null,
    cardSecret: payload?.cardSecret || null,
  };
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

async function processIssue(db, orderId) {
  const now = nowIso();
  await db.exec("BEGIN IMMEDIATE");
  try {
    const order = await db.get(`SELECT * FROM orders WHERE id = ?`, [orderId]);
    if (!order) throw badRequest("order not found");

    await db.run(`UPDATE orders SET status='PROCESSING', updated_at=? WHERE id=?`, [now, orderId]);
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

  await processIssue(db, orderId);
  return getOrderResponse(db, orderId, channel.id);
}

module.exports = { createOrder, getOrderResponse, badRequest };
