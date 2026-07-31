const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");

let app;

test.before(async () => {
  app = await createApp({ dbFile: ":memory:" });
});

test("health check", async () => {
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("import cards then issue with idempotency", async () => {
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
  assert.equal(first.body.status, "SUCCESS");
  assert.equal(first.body.cardNo.length > 0, true);

  const second = await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.orderId, first.body.orderId);
  assert.equal(second.body.cardNo, first.body.cardNo);

  const query = await request(app)
    .get(`/v1/orders/${first.body.orderId}`)
    .set("x-api-key", "demo-api-key");
  assert.equal(query.status, 200);
  assert.equal(query.body.status, "SUCCESS");
});

test("out of stock returns failed order", async () => {
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
  const res = await request(app).post("/v1/orders").set("x-api-key", "demo-api-key").send(p3);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "FAILED");
  assert.equal(res.body.failureCode, "OUT_OF_STOCK");
});
