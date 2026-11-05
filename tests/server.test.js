"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { newDb } = require("pg-mem");
const { createPaymentStore } = require("../payment-store");
const { createApp } = require("../dev-server");

const credentials = {
  RAZORPAY_KEY_ID: "rzp_test_unitTestKey123",
  RAZORPAY_KEY_SECRET: "unit_test_secret"
};

async function createTestService({ env = credentials, store, gatewayFactory } = {}) {
  if (!store) {
    const { Pool } = newDb().adapters.createPg();
    store = createPaymentStore({ pool: emulatePostgresAdvisoryLocks(new Pool()) });
  }
  if (store.isConfigured()) await store.ensureSchema();

  const payments = new Map();
  const orders = [];
  let orderNumber = 0;
  const createGateway = gatewayFactory || (() => ({
    orders: {
      create: async order => {
        orders.push(order);
        orderNumber += 1;
        return {
          id: `order_test${orderNumber}`,
          amount: order.amount,
          currency: order.currency
        };
      }
    },
    payments: {
      fetch: async paymentId => {
        if (!payments.has(paymentId)) throw new Error("Payment not found in test gateway.");
        return payments.get(paymentId);
      }
    }
  }));
  const app = createApp({ env, store, gatewayFactory: createGateway });
  const server = await listen(app);
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    store,
    pool: store.pool,
    payments,
    orders,
    close: async () => {
      await closeServer(server);
      await store.close();
    }
  };
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  return server;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

async function postJson(baseUrl, route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

function signatureFor(orderId, paymentId) {
  return crypto.createHmac("sha256", credentials.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

function emulatePostgresAdvisoryLocks(pool) {
  // pg-mem lacks PostgreSQL advisory locks; model the lock at the pool boundary.
  const connect = pool.connect.bind(pool);
  const locks = new Map();
  pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    let releaseLock;
    client.query = async (sql, params) => {
      if (typeof sql === "string" && sql.includes("pg_advisory_xact_lock")) {
        const key = params[0];
        const previous = locks.get(key) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        locks.set(key, current);
        await previous;
        releaseLock = () => {
          release();
          if (locks.get(key) === current) locks.delete(key);
        };
        return { rows: [{}], rowCount: 1 };
      }
      const result = await query(sql, params);
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        releaseLock?.();
        releaseLock = undefined;
      }
      return result;
    };
    const release = client.release.bind(client);
    client.release = (...args) => {
      releaseLock?.();
      return release(...args);
    };
    return client;
  };
  return pool;
}

test("publishes the five approved plans without exposing the secret", async t => {
  const service = await createTestService();
  t.after(service.close);

  const response = await fetch(`${service.baseUrl}/api/config`);
  const config = await response.json();
  assert.equal(config.configured, true);
  assert.equal(config.databaseReady, true);
  assert.equal(config.keyId, credentials.RAZORPAY_KEY_ID);
  assert.equal(JSON.stringify(config).includes(credentials.RAZORPAY_KEY_SECRET), false);
  assert.deepEqual(config.plans, [
    { id: "monthly", name: "Monthly Membership", amount: 2500, currency: "INR" },
    { id: "three-months", name: "3-Month Membership", amount: 6500, currency: "INR" },
    { id: "six-months", name: "6-Month Membership", amount: 12000, currency: "INR" },
    { id: "yearly", name: "Yearly Membership", amount: 18000, currency: "INR" },
    { id: "complete-course", name: "Complete Yoga & Fitness Course", amount: 25000, currency: "INR" }
  ]);
});

test("creates exact server-priced orders and stores every plan", async t => {
  const service = await createTestService();
  t.after(service.close);
  const plans = [
    { id: "monthly", name: "Monthly Membership", amount: 2500 },
    { id: "three-months", name: "3-Month Membership", amount: 6500 },
    { id: "six-months", name: "6-Month Membership", amount: 12000 },
    { id: "yearly", name: "Yearly Membership", amount: 18000 },
    { id: "complete-course", name: "Complete Yoga & Fitness Course", amount: 25000 }
  ];

  for (const [index, plan] of plans.entries()) {
    const result = await postJson(service.baseUrl, "/api/orders", {
      planId: plan.id,
      idempotencyKey: crypto.randomUUID(),
      amount: 1,
      currency: "USD"
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.data.planName, plan.name);
    assert.equal(result.data.amount, plan.amount);
    assert.equal(result.data.amountPaise, plan.amount * 100);
    assert.equal(service.orders[index].amount, plan.amount * 100);
    assert.equal(service.orders[index].currency, "INR");
    assert.equal(service.orders[index].notes.plan_id, plan.id);
  }

  const { rows } = await service.pool.query(
    "SELECT plan_id, plan_name, amount_paise, status, created_at FROM payment_orders"
  );
  assert.equal(rows.length, plans.length);
  for (const plan of plans) {
    const row = rows.find(item => item.plan_id === plan.id);
    assert.equal(row.plan_name, plan.name);
    assert.equal(row.amount_paise, plan.amount * 100);
    assert.equal(row.status, "created");
    assert.ok(row.created_at);
  }
});

test("rejects unapproved plans without creating an order", async t => {
  let gatewayCalls = 0;
  const service = await createTestService({
    gatewayFactory: () => ({
      orders: { create: async () => { gatewayCalls += 1; return {}; } }
    })
  });
  t.after(service.close);

  const result = await postJson(service.baseUrl, "/api/orders", {
    planId: "unapproved-plan",
    amount: 1,
    currency: "USD",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(result.response.status, 400);
  assert.equal(gatewayCalls, 0);
  const { rows } = await service.pool.query("SELECT count(*)::int AS count FROM payment_orders");
  assert.equal(rows[0].count, 0);
});

test("reuses one order when independent instances race on the same idempotency key", async t => {
  const { Pool } = newDb().adapters.createPg();
  const database = createPaymentStore({ pool: emulatePostgresAdvisoryLocks(new Pool()) });
  let gatewayCalls = 0;
  const gatewayFactory = () => ({
    orders: {
      create: async order => {
        gatewayCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return { id: "order_test_concurrent", amount: order.amount, currency: order.currency };
      }
    }
  });
  const service = await createTestService({ store: database, gatewayFactory });
  t.after(service.close);
  const secondServer = await listen(createApp({
    env: credentials,
    store: database,
    gatewayFactory
  }));
  t.after(() => closeServer(secondServer));
  const idempotencyKey = crypto.randomUUID();
  const secondUrl = `http://127.0.0.1:${secondServer.address().port}`;
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    postJson(index % 2 ? service.baseUrl : secondUrl, "/api/orders", {
      planId: "yearly",
      idempotencyKey
    })
  ));

  assert.equal(gatewayCalls, 1);
  assert.equal(results.filter(result => result.response.status === 201).length, 1);
  assert.ok(results.every(result => [200, 201, 409].includes(result.response.status)));
  const { rows } = await service.pool.query("SELECT count(*)::int AS count FROM payment_orders");
  assert.equal(rows[0].count, 1);
});

test("verifies signatures, captured payments and idempotent confirmations", async t => {
  const service = await createTestService();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "three-months",
    idempotencyKey: crypto.randomUUID()
  });
  const paymentId = "pay_test_captured";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 650000,
    currency: "INR",
    status: "captured"
  });
  const verification = {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  };

  const first = await postJson(service.baseUrl, "/api/payments/verify", verification);
  const duplicate = await postJson(service.baseUrl, "/api/payments/verify", verification);
  const stored = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  const order = await stored.json();

  assert.equal(first.data.status, "verified");
  assert.equal(first.data.order.amount, 6500);
  assert.equal(first.data.order.planName, "3-Month Membership");
  assert.equal(duplicate.data.status, "verified");
  assert.equal(order.status, "verified");
  assert.equal(order.paymentReference, paymentId);
  assert.ok(order.verifiedAt);
  assert.equal(JSON.stringify(first.data).includes("order_token_hash"), false);
  assert.equal(JSON.stringify(first.data).includes("idempotency_key"), false);
});

test("rejects forged, authorized and wrong-amount payment details", async t => {
  const service = await createTestService();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "yearly",
    idempotencyKey: crypto.randomUUID()
  });
  const forged = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: "pay_test_forged",
    razorpay_signature: "0".repeat(64)
  });
  assert.equal(forged.response.status, 400);
  assert.equal(service.payments.size, 0);

  const paymentId = "pay_test_authorized";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 1800000,
    currency: "INR",
    status: "authorized"
  });
  const authorized = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  });
  assert.equal(authorized.response.status, 409);

  const wrongAmountId = "pay_test_wrong_amount";
  service.payments.set(wrongAmountId, {
    id: wrongAmountId,
    order_id: created.data.orderId,
    amount: 1,
    currency: "INR",
    status: "captured"
  });
  const wrongAmount = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: wrongAmountId,
    razorpay_signature: signatureFor(created.data.orderId, wrongAmountId)
  });
  assert.equal(wrongAmount.response.status, 400);
  const order = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  assert.equal((await order.json()).status, "created");
});

test("keeps pending payments unconfirmed", async t => {
  const service = await createTestService();
  t.after(service.close);
  const created = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  const paymentId = "pay_test_pending";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: created.data.orderId,
    amount: 250000,
    currency: "INR",
    status: "pending"
  });
  const result = await postJson(service.baseUrl, "/api/payments/verify", {
    razorpay_order_id: created.data.orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signatureFor(created.data.orderId, paymentId)
  });

  assert.equal(result.response.status, 409);
  assert.notEqual(result.data.status, "verified");
  const order = await fetch(`${service.baseUrl}/api/orders/${created.data.orderId}`, {
    headers: { "X-Order-Token": created.data.accessToken }
  });
  assert.equal((await order.json()).status, "created");
});

test("records provider-confirmed failures and cancellations without success", async t => {
  const service = await createTestService();
  t.after(service.close);
  const failedOrder = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  const paymentId = "pay_test_failed";
  service.payments.set(paymentId, {
    id: paymentId,
    order_id: failedOrder.data.orderId,
    amount: 250000,
    currency: "INR",
    status: "failed"
  });
  const failure = await postJson(service.baseUrl, "/api/payments/failure", {
    orderId: failedOrder.data.orderId,
    paymentId
  });
  assert.equal(failure.data.status, "failed");
  const { rows: failedRows } = await service.pool.query(
    "SELECT status, razorpay_payment_id FROM payment_orders WHERE razorpay_order_id = $1",
    [failedOrder.data.orderId]
  );
  assert.equal(failedRows[0].status, "failed");
  assert.equal(failedRows[0].razorpay_payment_id, paymentId);

  const cancelledOrder = await postJson(service.baseUrl, "/api/orders", {
    planId: "complete-course",
    idempotencyKey: crypto.randomUUID()
  });
  const unauthorisedCancel = await postJson(
    service.baseUrl,
    `/api/orders/${cancelledOrder.data.orderId}/cancel`,
    {}
  );
  assert.equal(unauthorisedCancel.response.status, 404);
  const cancel = await postJson(
    service.baseUrl,
    `/api/orders/${cancelledOrder.data.orderId}/cancel`,
    {},
    { "X-Order-Token": cancelledOrder.data.accessToken }
  );
  assert.equal(cancel.data.status, "cancelled");

  for (const [created, expectedStatus] of [[failedOrder.data, "failed"], [cancelledOrder.data, "cancelled"]]) {
    const response = await fetch(`${service.baseUrl}/api/orders/${created.orderId}`, {
      headers: { "X-Order-Token": created.accessToken }
    });
    const result = await response.json();
    assert.equal(result.status, expectedStatus);
  }
});

test("reports missing Razorpay credentials without opening checkout", async t => {
  let gatewayCalls = 0;
  const service = await createTestService({
    env: {},
    gatewayFactory: () => {
      gatewayCalls += 1;
      throw new Error("Gateway must not be constructed without credentials.");
    }
  });
  t.after(service.close);

  const config = await (await fetch(`${service.baseUrl}/api/config`)).json();
  const result = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(config.configured, false);
  assert.equal(config.databaseReady, true);
  assert.equal(result.response.status, 503);
  assert.equal(gatewayCalls, 0);
});

test("reports database outages and does not call Razorpay", async t => {
  let gatewayCalls = 0;
  const pool = {
    query: async () => {
      throw Object.assign(new Error("Database unavailable."), { code: "28P01" });
    },
    end: async () => {}
  };
  const store = createPaymentStore({ pool });
  const app = createApp({
    env: credentials,
    store,
    gatewayFactory: () => {
      gatewayCalls += 1;
      throw new Error("Gateway must not be constructed while database is unavailable.");
    }
  });
  const server = await listen(app);
  t.after(async () => {
    await closeServer(server);
    await store.close();
  });

  const config = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
  const result = await postJson(`http://127.0.0.1:${server.address().port}`, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(config.configured, true);
  assert.equal(config.databaseReady, false);
  assert.equal(result.response.status, 503);
  assert.match(result.data.error, /records are temporarily unavailable/i);
  assert.equal(gatewayCalls, 0);
});

test("handles Razorpay authentication failures without leaking provider details", async t => {
  const service = await createTestService({
    gatewayFactory: () => ({
      orders: {
        create: async () => {
          throw Object.assign(new Error("Authentication failed key_secret=private-test-secret"), {
            statusCode: 401,
            code: "BAD_REQUEST_ERROR"
          });
        }
      }
    })
  });
  t.after(service.close);

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = await postJson(service.baseUrl, "/api/orders", {
      planId: "monthly",
      idempotencyKey: crypto.randomUUID()
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.response.status, 502);
  assert.doesNotMatch(result.data.error, /secret|BAD_REQUEST_ERROR|401/i);
  assert.doesNotMatch(JSON.stringify(logged), /private-test-secret/);
  assert.match(JSON.stringify(logged), /razorpay/);
});

test("serves the site and payment pages without exposing backend files", async t => {
  const service = await createTestService();
  t.after(service.close);
  for (const file of ["/", "/payments.html", "/payments.js", "/payments.css", "/payment-result.html", "/payment-result.js", "/assets/logo.jpeg"]) {
    assert.equal((await fetch(`${service.baseUrl}${file}`)).status, 200, file);
  }
  for (const file of ["/dev-server.js", "/payment-store.js", "/package.json", "/.env.example", "/lib/payment-api.js", "/api/orders/index.js"]) {
    assert.notEqual((await fetch(`${service.baseUrl}${file}`)).status, 200, file);
  }
  const resultPage = await (await fetch(`${service.baseUrl}/payment-result.html`)).text();
  assert.match(resultPage, /Payment Status/);
  assert.match(resultPage, /Membership or course/);
  assert.match(resultPage, /Payment reference/);
  assert.match(resultPage, /Return to plans/);
  const resultScript = await (await fetch(`${service.baseUrl}/payment-result.js`)).text();
  assert.match(resultScript, /statusLabel\.textContent = "Successful"/);
  assert.match(resultScript, /statusLabel\.textContent = "Failed"/);
  assert.match(resultScript, /statusLabel\.textContent = "Cancelled"/);
  assert.match(resultScript, /statusLabel\.textContent = "Pending verification"/);
});

test("does not create Razorpay orders without database storage", async t => {
  let gatewayCalls = 0;
  const service = await createTestService({
    store: createPaymentStore({}),
    gatewayFactory: () => ({
      orders: { create: async () => { gatewayCalls += 1; return {}; } }
    })
  });
  t.after(service.close);
  const result = await postJson(service.baseUrl, "/api/orders", {
    planId: "monthly",
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(result.response.status, 503);
  assert.equal(gatewayCalls, 0);
});
