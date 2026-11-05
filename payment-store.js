"use strict";

/**
 * Durable payment-order storage backed by PostgreSQL (Neon on Vercel).
 *
 * Vercel functions run on ephemeral, per-instance filesystems, so payment
 * records must never live in a local/temporary file such as SQLite in /tmp.
 * Payment-order claims use a transaction-scoped PostgreSQL advisory lock and a
 * unique idempotency key so concurrent serverless instances share one claim.
 */

const { Pool } = require("pg");
const { HttpError } = require("./lib/http-error");

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS payment_orders (
    idempotency_key     TEXT PRIMARY KEY,
    order_token_hash    TEXT NOT NULL,
    plan_id             TEXT NOT NULL,
    plan_name           TEXT NOT NULL,
    amount_paise        INTEGER NOT NULL CHECK (amount_paise > 0),
    receipt             TEXT NOT NULL UNIQUE,
    razorpay_order_id   TEXT UNIQUE,
    razorpay_payment_id TEXT UNIQUE,
    status              TEXT NOT NULL CHECK (status IN ('creating', 'created', 'verified', 'failed', 'cancelled', 'creation_failed')),
    failure_reason      TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at         TIMESTAMPTZ
  )
`;

function createPool(connectionString) {
  const pool = new Pool({
    connectionString,
    max: process.env.VERCEL ? 1 : 5,
    connectionTimeoutMillis: 10000
  });
  // An idle-client error must not crash the process.
  pool.on("error", error => console.error("Postgres pool error:", error.message));

  if (process.env.VERCEL) {
    try {
      // Closes idle connections before Vercel suspends the function (Fluid compute).
      require("@vercel/functions").attachDatabasePool(pool);
    } catch (error) {
      console.warn("Could not attach database pool to Vercel lifecycle:", error.message);
    }
  }
  return pool;
}

/**
 * @param {object}  [options]
 * @param {string}  [options.connectionString]  Postgres URL (DATABASE_URL).
 * @param {object}  [options.pool]              Pre-built pg-compatible pool (used by tests).
 */
function createPaymentStore({ connectionString, pool } = {}) {
  const activePool = pool || (connectionString ? createPool(connectionString) : null);
  let schemaReady = null;

  function requirePool() {
    if (!activePool) {
      console.error("DATABASE_URL is not set; payment records cannot be stored.");
      throw new HttpError(503, "Payment record storage is not configured. Please contact the center.");
    }
    return activePool;
  }

  // Makes sure the table exists, once per instance. Normally the table already exists
  // (created by `npm run db:init`), so a cold start only runs a cheap lookup and no DDL.
  // The CREATE ... IF NOT EXISTS fallback makes a brand-new database self-initialising.
  async function initialiseSchema(db) {
    const { rows } = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'payment_orders'"
    );
    if (rows.length === 0) await db.query(SCHEMA_SQL);
  }

  async function ready() {
    const db = requirePool();
    if (!schemaReady) {
      schemaReady = initialiseSchema(db).catch(error => {
        schemaReady = null; // retry on the next request
        throw error;
      });
    }
    await schemaReady;
    return db;
  }

  async function one(sql, params, executor) {
    const db = executor || await ready();
    const { rows } = await db.query(sql, params);
    return rows[0];
  }

  async function withIdempotencyLock(key, operation) {
    const db = await ready();
    const client = await db.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      const lockedStore = {
        findByIdempotencyKey: idempotencyKey =>
          one("SELECT * FROM payment_orders WHERE idempotency_key = $1", [idempotencyKey], client),
        insertCreating: ({ idempotencyKey, tokenHash, planId, planName, amountPaise, receipt }) =>
          one(
            `INSERT INTO payment_orders
               (idempotency_key, order_token_hash, plan_id, plan_name, amount_paise, receipt, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'creating')
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING *`,
            [idempotencyKey, tokenHash, planId, planName, amountPaise, receipt],
            client
          ),
        markCreated: (idempotencyKey, razorpayOrderId) =>
          one(
            `UPDATE payment_orders
                SET razorpay_order_id = $2, status = 'created', updated_at = now()
              WHERE idempotency_key = $1 AND status = 'creating'
              RETURNING *`,
            [idempotencyKey, razorpayOrderId],
            client
          ),
        markCreationFailed: idempotencyKey =>
          one(
            `UPDATE payment_orders
                SET status = 'creation_failed', failure_reason = 'Order creation failed.', updated_at = now()
              WHERE idempotency_key = $1 AND status = 'creating'
              RETURNING *`,
            [idempotencyKey],
            client
          )
      };
      const result = await operation(lockedStore);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Could not roll back payment-order transaction:", rollbackError.message);
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    isConfigured: () => Boolean(activePool),
    pool: activePool,
    ensureSchema: ready,
    withIdempotencyLock,

    findByIdempotencyKey: key =>
      one("SELECT * FROM payment_orders WHERE idempotency_key = $1", [key]),

    findByRazorpayOrderId: orderId =>
      one("SELECT * FROM payment_orders WHERE razorpay_order_id = $1", [orderId]),

    // Returns the new row, or undefined if this idempotency key already exists
    // (two simultaneous requests with the same key: only one can insert).
    insertCreating: ({ idempotencyKey, tokenHash, planId, planName, amountPaise, receipt }) =>
      one(
        `INSERT INTO payment_orders
           (idempotency_key, order_token_hash, plan_id, plan_name, amount_paise, receipt, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'creating')
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [idempotencyKey, tokenHash, planId, planName, amountPaise, receipt]
      ),

    markCreated: (idempotencyKey, razorpayOrderId) =>
      one(
        `UPDATE payment_orders
            SET razorpay_order_id = $2, status = 'created', updated_at = now()
          WHERE idempotency_key = $1 AND status = 'creating'
          RETURNING *`,
        [idempotencyKey, razorpayOrderId]
      ),

    markCreationFailed: idempotencyKey =>
      one(
        `UPDATE payment_orders
            SET status = 'creation_failed', failure_reason = 'Order creation failed.', updated_at = now()
          WHERE idempotency_key = $1 AND status = 'creating'
          RETURNING *`,
        [idempotencyKey]
      ),

    // Never downgrades an order that is already verified.
    markFailed: (razorpayOrderId, paymentId) =>
      one(
        `UPDATE payment_orders
            SET razorpay_payment_id = $2, status = 'failed',
                failure_reason = 'Payment was not captured.', updated_at = now()
          WHERE razorpay_order_id = $1 AND status <> 'verified'
          RETURNING *`,
        [razorpayOrderId, paymentId]
      ),

    // Returns the row that was updated, or undefined if it was already verified.
    markVerified: (razorpayOrderId, paymentId) =>
      one(
        `UPDATE payment_orders
            SET razorpay_payment_id = $2, status = 'verified', failure_reason = NULL,
                updated_at = now(), verified_at = now()
          WHERE razorpay_order_id = $1 AND status <> 'verified'
          RETURNING *`,
        [razorpayOrderId, paymentId]
      ),

    markCancelled: razorpayOrderId =>
      one(
        `UPDATE payment_orders
            SET status = 'cancelled', updated_at = now()
          WHERE razorpay_order_id = $1 AND status = 'created'
          RETURNING *`,
        [razorpayOrderId]
      ),

    close: async () => {
      if (activePool && typeof activePool.end === "function") await activePool.end();
    }
  };
}

module.exports = { createPaymentStore, SCHEMA_SQL };
