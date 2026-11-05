"use strict";

const path = require("node:path");
require("dotenv").config({
  path: [path.join(__dirname, ".env.local"), path.join(__dirname, ".env")],
  quiet: true
});

const express = require("express");
const { createPaymentHandlers } = require("./lib/payment-api");

const ROOT_DIR = __dirname;
const ASSET_DIR = path.join(ROOT_DIR, "assets");
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/script.js", "script.js"],
  ["/style.css", "style.css"],
  ["/payments.html", "payments.html"],
  ["/payments.js", "payments.js"],
  ["/payments.css", "payments.css"],
  ["/payment-result.html", "payment-result.html"],
  ["/payment-result.js", "payment-result.js"]
]);

function createApp(options = {}) {
  const handlers = options.handlers || createPaymentHandlers(options);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.get("/api/config", handlers.config);
  app.post("/api/orders", handlers.createOrder);
  app.post("/api/payments/verify", handlers.verifyPayment);
  app.post("/api/payments/failure", handlers.reportFailure);
  app.post("/api/orders/:orderId/cancel", handlers.cancelOrder);
  app.get("/api/orders/:orderId", handlers.getOrder);
  app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found." }));

  for (const [route, fileName] of STATIC_FILES) {
    app.get(route, (_req, res, next) => {
      res.sendFile(path.join(ROOT_DIR, fileName), error => {
        if (error) next(error);
      });
    });
  }
  app.use("/assets", express.static(ASSET_DIR, { dotfiles: "deny", index: false }));
  app.use((_req, res) => res.status(404).type("text/plain").send("Not found."));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    console.error("Website request failed:", error.message || "unknown error");
    res.status(500).type("text/plain").send("The website could not complete this request.");
  });

  app.locals.store = handlers.store;
  return app;
}

const app = createApp();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Bhagath Yoga Center is available at http://localhost:${port}`);
  });
  server.on("close", () => app.locals.store.close());
}

module.exports = Object.assign(app, { createApp });
