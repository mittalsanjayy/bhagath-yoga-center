"use strict";

const path = require("node:path");
require("dotenv").config({
  path: [path.join(__dirname, "..", ".env.local"), path.join(__dirname, "..", ".env")],
  quiet: true
});

const { createPaymentStore } = require("../payment-store");

async function main() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local or your shell, then retry.");
  }
  const store = createPaymentStore({ connectionString });
  try {
    await store.ensureSchema();
    const { rows } = await store.pool.query("SELECT count(*)::int AS orders FROM payment_orders");
    console.log(`payment_orders table is ready (${rows[0].orders} existing order records).`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`Database setup failed (${error.code || "configuration error"}). Check DATABASE_URL and network access.`);
  process.exitCode = 1;
});
