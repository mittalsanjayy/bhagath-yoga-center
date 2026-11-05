"use strict";

const crypto = require("node:crypto");
const Razorpay = require("razorpay");
const { HttpError } = require("./http-error");
const { createPaymentStore } = require("../payment-store");

const PLANS = Object.freeze({
  monthly: Object.freeze({ name: "Monthly Membership", amountRupees: 2500 }),
  "three-months": Object.freeze({ name: "3-Month Membership", amountRupees: 6500 }),
  "six-months": Object.freeze({ name: "6-Month Membership", amountRupees: 12000 }),
  yearly: Object.freeze({ name: "Yearly Membership", amountRupees: 18000 }),
  "complete-course": Object.freeze({ name: "Complete Yoga & Fitness Course", amountRupees: 25000 })
});

function getCredentials(env) {
  const keyId = typeof env.RAZORPAY_KEY_ID === "string" ? env.RAZORPAY_KEY_ID.trim() : "";
  const keySecret = typeof env.RAZORPAY_KEY_SECRET === "string" ? env.RAZORPAY_KEY_SECRET.trim() : "";
  const keyIdIsValid = /^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId);

  return {
    configured: keyIdIsValid && Boolean(keySecret) && keySecret !== "YOUR_RAZORPAY_KEY_SECRET",
    keyId: keyIdIsValid ? keyId : "",
    keySecret
  };
}

function createOrderToken(keySecret, idempotencyKey) {
  return crypto.createHmac("sha256", keySecret).update(`order-access:${idempotencyKey}`).digest("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest();
}

function tokenMatches(token, storedHash) {
  if (typeof token !== "string" || !storedHash) return false;
  const candidate = hashToken(token);
  const saved = Buffer.from(storedHash, "hex");
  return candidate.length === saved.length && crypto.timingSafeEqual(candidate, saved);
}

function isValidIdempotencyKey(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toPublicOrder(order) {
  return {
    orderId: order.razorpay_order_id,
    planId: order.plan_id,
    planName: order.plan_name,
    amount: order.amount_paise / 100,
    amountPaise: order.amount_paise,
    currency: "INR",
    status: order.status
  };
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body !== undefined) {
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
    if (typeof req.body === "string" && req.body.length <= 10240) {
      try {
        const parsed = JSON.parse(req.body || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch {
        throw new HttpError(400, "The request body must be valid JSON.");
      }
    }
    throw new HttpError(400, "The request body must be a JSON object.");
  }

  let rawBody = "";
  for await (const chunk of req) {
    rawBody += chunk;
    if (Buffer.byteLength(rawBody) > 10240) {
      throw new HttpError(413, "The request is too large.");
    }
  }
  if (!rawBody.trim()) return {};
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
  throw new HttpError(400, "The request body must be a JSON object.");
}

function safeErrorMessage(error) {
  const details = error && typeof error === "object" ? error : {};
  const providerError = details.error && typeof details.error === "object" ? details.error : {};
  const message = error instanceof Error
    ? error.message
    : providerError.description || details.description || (typeof error === "string" ? error : "Unknown service error");
  return String(message)
    .replace(/\bpostgres(?:ql)?:\/\/[^\s]+/gi, "[redacted database URL]")
    .replace(/\b(password|secret|authorization|key_secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function logFailure(stage, error) {
  const details = error && typeof error === "object" ? error : {};
  const providerError = details.error && typeof details.error === "object" ? details.error : {};
  console.error("Payment request failed", {
    stage,
    code: details.code || providerError.code || "unknown",
    statusCode: details.statusCode || details.status || "unknown",
    message: safeErrorMessage(error)
  });
}

function getOrderId(req) {
  if (typeof req.params?.orderId === "string") return req.params.orderId;
  const fromQuery = req.query?.orderId;
  if (typeof fromQuery === "string") return fromQuery;
  const path = new URL(req.url || "/", "http://localhost").pathname;
  const match = path.match(/^\/api\/orders\/([^/]+)(?:\/cancel)?\/?$/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

function createPaymentHandlers({
  env = process.env,
  store = createPaymentStore({ connectionString: env.DATABASE_URL || env.POSTGRES_URL }),
  gatewayFactory = credentials => new Razorpay({
    key_id: credentials.keyId,
    key_secret: credentials.keySecret
  })
} = {}) {
  const orderCreationLocks = new Map();

  async function withOrderCreationLock(key, operation) {
    const previous = orderCreationLocks.get(key);
    let release;
    const current = new Promise(resolve => {
      release = resolve;
    });
    orderCreationLocks.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (orderCreationLocks.get(key) === current) orderCreationLocks.delete(key);
    }
  }

  function handler(action, allowedMethods) {
    return async (req, res) => {
      let stage = "request";
      if (!allowedMethods.includes(req.method)) {
        res.setHeader("Allow", allowedMethods.join(", "));
        return sendJson(res, 405, { error: "This HTTP method is not allowed for this endpoint." });
      }
      try {
        await action(req, res, {
          setStage(nextStage) {
            stage = nextStage;
          },
          getStage() {
            return stage;
          }
        });
      } catch (error) {
        if (error instanceof HttpError) {
          return sendJson(res, error.status, { error: error.message });
        }
        logFailure(stage, error);
        const databaseFailure = stage === "database";
        return sendJson(
          res,
          databaseFailure ? 503 : 502,
          {
            error: databaseFailure
              ? "Payment records are temporarily unavailable. Please try again shortly."
              : "The payment service could not complete this request. Please try again or contact the center."
          }
        );
      }
    };
  }

  function requireGateway() {
    const credentials = getCredentials(env);
    if (!credentials.configured) {
      throw new HttpError(503, "Razorpay is not configured. Please contact the center.");
    }
    return credentials;
  }

  async function respondWithExistingOrder(res, order, planId, credentials, accessToken) {
    if (order.plan_id !== planId) {
      throw new HttpError(409, "This payment request was already used for a different plan. Start a new payment attempt.");
    }
    if (order.status === "created" || order.status === "verified") {
      return sendJson(res, 200, { ...toPublicOrder(order), keyId: credentials.keyId, accessToken });
    }
    if (order.status === "creating") {
      throw new HttpError(409, "This payment order is still being prepared. Please wait a moment and try again.");
    }
    throw new HttpError(409, "This payment request is no longer available. Start a new payment attempt.");
  }

  const config = handler(async (_req, res, context) => {
    const credentials = getCredentials(env);
    let databaseReady = false;
    if (store.isConfigured()) {
      context.setStage("database");
      try {
        await store.ensureSchema();
        databaseReady = true;
      } catch (error) {
        logFailure("database", error);
      }
    }
    sendJson(res, 200, {
      configured: credentials.configured,
      databaseReady,
      keyId: credentials.configured ? credentials.keyId : "",
      plans: Object.entries(PLANS).map(([id, plan]) => ({
        id,
        name: plan.name,
        amount: plan.amountRupees,
        currency: "INR"
      }))
    });
  }, ["GET"]);

  const createOrder = handler(async (req, res, context) => {
    const credentials = requireGateway();
    const { planId, idempotencyKey } = await readJsonBody(req);
    if (typeof planId !== "string" || !Object.hasOwn(PLANS, planId)) {
      throw new HttpError(400, "Choose a valid membership or course.");
    }
    if (!isValidIdempotencyKey(idempotencyKey)) {
      throw new HttpError(400, "A valid payment request ID is required. Please try again.");
    }

    const plan = PLANS[planId];
    const accessToken = createOrderToken(credentials.keySecret, idempotencyKey);
    context.setStage("database");
    const claim = await withOrderCreationLock(idempotencyKey, () =>
      store.withIdempotencyLock(idempotencyKey, async lockedStore => {
        const existing = await lockedStore.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          if (existing.plan_id !== planId) {
            throw new HttpError(409, "This payment request was already used for a different plan. Start a new payment attempt.");
          }
          return { order: existing, isNew: false };
        }

        const receipt = `bhg_${crypto.randomUUID().replaceAll("-", "")}`;
        const order = await lockedStore.insertCreating({
          idempotencyKey,
          tokenHash: hashToken(accessToken).toString("hex"),
          planId,
          planName: plan.name,
          amountPaise: plan.amountRupees * 100,
          receipt
        });
        if (!order) {
          const raced = await lockedStore.findByIdempotencyKey(idempotencyKey);
          if (!raced) throw new Error("Payment order record could not be created.");
          return { order: raced, isNew: false };
        }
        return { order, isNew: true };
      })
    );
    if (!claim.isNew) {
      return respondWithExistingOrder(res, claim.order, planId, credentials, accessToken);
    }

    let order = claim.order;
    try {
      context.setStage("razorpay");
      const gatewayOrder = await gatewayFactory(credentials).orders.create({
        amount: plan.amountRupees * 100,
        currency: "INR",
        receipt: order.receipt,
        notes: { plan_id: planId, center: "Bhagath Yoga Center" }
      });
      if (
        typeof gatewayOrder.id !== "string" ||
        gatewayOrder.amount !== plan.amountRupees * 100 ||
        gatewayOrder.currency !== "INR"
      ) {
        throw new Error("Razorpay returned an order with unexpected details.");
      }

      context.setStage("database");
      order = await store.markCreated(idempotencyKey, gatewayOrder.id);
      if (!order) throw new Error("Payment order record changed while the order was being created.");
      sendJson(res, 201, { ...toPublicOrder(order), keyId: credentials.keyId, accessToken });
    } catch (error) {
      const failureStage = context.getStage();
      try {
        context.setStage("database");
        await store.markCreationFailed(idempotencyKey);
      } catch (storeError) {
        logFailure("database", storeError);
      }
      context.setStage(failureStage);
      throw error;
    }
  }, ["POST"]);

  const verifyPayment = handler(async (req, res, context) => {
    const credentials = requireGateway();
    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature
    } = await readJsonBody(req);
    if (
      typeof orderId !== "string" || orderId.length > 64 ||
      typeof paymentId !== "string" || paymentId.length > 64 ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)
    ) {
      throw new HttpError(400, "Payment verification details are incomplete.");
    }

    context.setStage("database");
    const order = await store.findByRazorpayOrderId(orderId);
    if (!order) throw new HttpError(404, "This payment order could not be found.");

    const expectedSignature = crypto.createHmac("sha256", credentials.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest();
    const suppliedSignature = Buffer.from(signature, "hex");
    if (!crypto.timingSafeEqual(expectedSignature, suppliedSignature)) {
      throw new HttpError(400, "The payment signature could not be verified. No successful payment is confirmed.");
    }
    if (order.status === "verified") {
      if (order.razorpay_payment_id !== paymentId) {
        throw new HttpError(409, "A different payment has already been confirmed for this order.");
      }
      return sendJson(res, 200, { status: "verified", order: toPublicOrder(order), paymentReference: paymentId });
    }

    context.setStage("razorpay");
    const payment = await gatewayFactory(credentials).payments.fetch(paymentId);
    if (
      payment.id !== paymentId ||
      payment.order_id !== orderId ||
      payment.amount !== order.amount_paise ||
      payment.currency !== "INR"
    ) {
      throw new HttpError(400, "The payment details do not match this order. No successful payment is confirmed.");
    }
    if (payment.status !== "captured") {
      if (payment.status === "failed") {
        context.setStage("database");
        const failedOrder = await store.markFailed(orderId, paymentId);
        if (!failedOrder) {
          const currentOrder = await store.findByRazorpayOrderId(orderId);
          if (currentOrder?.status === "verified") {
            if (currentOrder.razorpay_payment_id === paymentId) {
              return sendJson(res, 200, {
                status: "verified",
                order: toPublicOrder(currentOrder),
                paymentReference: paymentId
              });
            }
            throw new HttpError(409, "A different payment has already been confirmed for this order.");
          }
        }
        return sendJson(res, 422, {
          status: "failed",
          error: "Razorpay reports that this payment failed. No enrollment is confirmed."
        });
      }
      throw new HttpError(409, "Razorpay has not captured this payment yet. No successful payment is confirmed.");
    }

    context.setStage("database");
    const updated = await store.markVerified(orderId, paymentId);
    const currentOrder = updated || await store.findByRazorpayOrderId(orderId);
    if (!currentOrder || currentOrder.razorpay_payment_id !== paymentId || currentOrder.status !== "verified") {
      throw new HttpError(409, "A different payment has already been confirmed for this order.");
    }
    sendJson(res, 200, {
      status: "verified",
      order: toPublicOrder(currentOrder),
      paymentReference: paymentId
    });
  }, ["POST"]);

  const reportFailure = handler(async (req, res, context) => {
    const credentials = requireGateway();
    const { orderId, paymentId } = await readJsonBody(req);
    if (
      typeof orderId !== "string" || orderId.length > 64 ||
      typeof paymentId !== "string" || paymentId.length > 64
    ) {
      throw new HttpError(400, "Payment failure details are incomplete.");
    }

    context.setStage("database");
    const order = await store.findByRazorpayOrderId(orderId);
    if (!order) throw new HttpError(404, "This payment order could not be found.");
    context.setStage("razorpay");
    const payment = await gatewayFactory(credentials).payments.fetch(paymentId);
    if (
      payment.id !== paymentId ||
      payment.order_id !== orderId ||
      payment.amount !== order.amount_paise ||
      payment.currency !== "INR" ||
      payment.status !== "failed"
    ) {
      throw new HttpError(409, "Razorpay has not confirmed a failed payment for this order.");
    }

    context.setStage("database");
    const updated = await store.markFailed(orderId, paymentId);
    if (!updated) {
      const current = await store.findByRazorpayOrderId(orderId);
      if (current?.status === "verified") {
        throw new HttpError(409, "This order already has a verified payment.");
      }
      if (current?.status !== "failed" || current.razorpay_payment_id !== paymentId) {
        throw new HttpError(409, "This order is no longer available for a failed-payment update.");
      }
    }
    sendJson(res, 200, { status: "failed" });
  }, ["POST"]);

  const cancelOrder = handler(async (req, res, context) => {
    requireGateway();
    const orderId = getOrderId(req);
    context.setStage("database");
    const order = await store.findByRazorpayOrderId(orderId);
    if (!order || !tokenMatches(req.headers?.["x-order-token"], order.order_token_hash)) {
      throw new HttpError(404, "This payment order could not be found.");
    }
    await store.markCancelled(orderId);
    const updated = await store.findByRazorpayOrderId(orderId);
    sendJson(res, 200, {
      ...toPublicOrder(updated),
      paymentReference: updated.razorpay_payment_id || ""
    });
  }, ["POST"]);

  const getOrder = handler(async (req, res, context) => {
    requireGateway();
    const orderId = getOrderId(req);
    context.setStage("database");
    const order = await store.findByRazorpayOrderId(orderId);
    if (!order || !tokenMatches(req.headers?.["x-order-token"], order.order_token_hash)) {
      throw new HttpError(404, "This payment order could not be found.");
    }
    sendJson(res, 200, {
      ...toPublicOrder(order),
      paymentReference: order.razorpay_payment_id || "",
      verifiedAt: order.verified_at
    });
  }, ["GET"]);

  return {
    config,
    createOrder,
    verifyPayment,
    reportFailure,
    cancelOrder,
    getOrder,
    store
  };
}

module.exports = { PLANS, createPaymentHandlers, getCredentials };
