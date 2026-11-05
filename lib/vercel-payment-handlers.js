"use strict";

const { createPaymentHandlers } = require("./payment-api");

const handlers = createPaymentHandlers();

module.exports = { handlers };
