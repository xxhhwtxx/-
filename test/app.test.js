const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

let app;
let originalFetch;

test.before(async () => {
  originalFetch = global.fetch;
});

test.beforeEach(async () => {
  app = await createApp({ dbFile: ":memory:" });
  global.fetch = async () => ({ ok: true, status: 200 });
});

test.after(() => {
  global.fetch = originalFetch;
});

test("health check", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("payment callback triggers issuing with idempotency", async () => {
  const importRes = await request(app)
    .post("/v1/inventory/cards/import")
    .set("x-admin-token", "admin-dev-token")
    .send({
      poolId: "pool-demo",
      cards: [
        { cardNo: "1234567890123456", cardSecret: "s-123" },
        { cardNo: "8888666677779999", cardSecret: "s-456" },
      ],
    });
  assert.equal(importRes.status, 200);
  assert.equal(importRes.body.inserted >= 1, true);

  const payload = {
    idempotencyKey: "idem-1",
    externalOrderNo: "ext-1",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  };
  const first = await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(payload);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "CREATED");
  assert.equal(first.body.cardNo, null);

  const callback = await request(app)
    .post("/v1/payments/callback")
    .set("x-api-key", "demo-api-key")
    .send({ externalOrderNo: "ext-1", paymentStatus: "SUCCESS" });
  assert.equal(callback.status, 200);
  assert.equal(callback.body.status, "SUCCESS");
  assert.equal(callback.body.cardNo.length > 0, true);

  const second = await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.orderId, first.body.orderId);
  assert.equal(second.body.cardNo, callback.body.cardNo);

  const query = await request(app)
    .get(`/v1/orders/${callback.body.orderId}`)
    .set("x-api-key", "demo-api-key");
  assert.equal(query.status, 200);
  assert.equal(query.body.status, "SUCCESS");
});

test("webhook retry endpoint retries pending receipts", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network-down");
    return { ok: true, status: 200 };
  };

  await request(app)
    .post("/v1/inventory/cards/import")
    .set("x-admin-token", "admin-dev-token")
    .send({
      poolId: "pool-demo",
      cards: [{ cardNo: "7011223344556677", cardSecret: "sec-1" }],
    });

  await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send({
    idempotencyKey: "idem-wh-1",
    externalOrderNo: "ext-wh-1",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  });
  await request(app).post("/v1/payments/callback").set("x-api-key", "demo-api-key").send({
    externalOrderNo: "ext-wh-1",
    paymentStatus: "SUCCESS",
  });

  const retryRes = await request(app)
    .post("/v1/admin/webhooks/retry")
    .set("x-admin-token", "admin-dev-token")
    .send({ limit: 10 });
  assert.equal(retryRes.status, 200);
  assert.equal(retryRes.body.retried, 1);
  assert.equal(calls >= 2, true);
});

test("channel blacklist blocks order request", async () => {
  const blockRes = await request(app)
    .post("/v1/admin/risk/blacklist")
    .set("x-admin-token", "admin-dev-token")
    .send({ type: "CHANNEL", target: "channel-demo", reason: "fraud" });
  assert.equal(blockRes.status, 201);

  const orderRes = await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send({
    idempotencyKey: "idem-block-1",
    externalOrderNo: "ext-block-1",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  });
  assert.equal(orderRes.status, 403);
});

test("admin dashboard page is available", async () => {
  const res = await request(app).get("/v1/admin/dashboard").set("x-admin-token", "admin-dev-token");
  assert.equal(res.status, 200);
  assert.equal(res.text.includes("发卡后台"), true);
});

test("out of stock returns failed order", async () => {
  await request(app)
    .post("/v1/inventory/cards/import")
    .set("x-admin-token", "admin-dev-token")
    .send({
      poolId: "pool-demo",
      cards: [
        { cardNo: "2234567890123456", cardSecret: "s-123" },
        { cardNo: "2888666677779999", cardSecret: "s-456" },
      ],
    });

  const p1 = {
    idempotencyKey: "idem-2",
    externalOrderNo: "ext-2",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  };
  const p2 = {
    idempotencyKey: "idem-3",
    externalOrderNo: "ext-3",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  };
  const p3 = {
    idempotencyKey: "idem-4",
    externalOrderNo: "ext-4",
    productCode: "DEMO100",
    amount: 100,
    currency: "CNY",
  };
  await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(p1);
  await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(p2);
  await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(p3);
  await request(app).post("/v1/payments/callback").set("x-api-key", "demo-api-key").send({
    externalOrderNo: "ext-2",
    paymentStatus: "SUCCESS",
  });
  await request(app).post("/v1/payments/callback").set("x-api-key", "demo-api-key").send({
    externalOrderNo: "ext-3",
    paymentStatus: "SUCCESS",
  });
  const res = await request(app).post("/v1/payments/callback").set("x-api-key", "demo-api-key").send({
    externalOrderNo: "ext-4",
    paymentStatus: "SUCCESS",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAILED");
  assert.equal(res.body.failureCode, "OUT_OF_STOCK");
});
