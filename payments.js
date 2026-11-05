"use strict";

const configStatus = document.getElementById("payment-config-status");
const paymentStatus = document.getElementById("payment-status");
const planButtons = [...document.querySelectorAll("[data-plan-pay]")];
const tokenStorageKey = "bhagath:razorpay-order-tokens";
const expectedPlans = {
  monthly: { name: "Monthly Membership", amount: 2500 },
  "three-months": { name: "3-Month Membership", amount: 6500 },
  "six-months": { name: "6-Month Membership", amount: 12000 },
  yearly: { name: "Yearly Membership", amount: 18000 },
  "complete-course": { name: "Complete Yoga & Fitness Course", amount: 25000 }
};

let gatewayConfig = null;
let checkoutInProgress = false;
let checkoutTerminal = false;
const pendingOrderKeys = new Map();

function formatPrice(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function setButtonsDisabled(disabled) {
  planButtons.forEach(button => {
    button.disabled = disabled;
    button.setAttribute("aria-busy", String(disabled && checkoutInProgress));
  });
}

function saveOrderToken(orderId, accessToken) {
  const tokens = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "{}");
  tokens[orderId] = accessToken;
  sessionStorage.setItem(tokenStorageKey, JSON.stringify(tokens));
}

function savePendingVerification(orderId, payment) {
  sessionStorage.setItem(
    `bhagath:razorpay-verification:${orderId}`,
    JSON.stringify(payment)
  );
}

function navigateToResult(orderId) {
  window.location.assign(`payment-result.html?order_id=${encodeURIComponent(orderId)}`);
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Payment request failed (${response.status}).`);
  return data;
}

async function requestOrder(planId, idempotencyKey) {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId, idempotencyKey }),
    credentials: "same-origin",
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status !== 409 || !String(data.error || "").includes("still being prepared")) {
      pendingOrderKeys.delete(planId);
    }
    throw new Error(data.error || `A secure order could not be created (${response.status}).`);
  }
  return data;
}

async function verifyPayment(order, payment) {
  savePendingVerification(order.orderId, payment);
  const result = await postJson("/api/payments/verify", payment);
  if (result.status !== "verified") {
    throw new Error(result.error || "Razorpay has not confirmed this payment yet.");
  }
  sessionStorage.removeItem(`bhagath:razorpay-verification:${order.orderId}`);
  navigateToResult(order.orderId);
}

async function reportFailure(order, paymentId) {
  await postJson("/api/payments/failure", { orderId: order.orderId, paymentId });
}

async function cancelOrder(order) {
  await postJson(
    `/api/orders/${encodeURIComponent(order.orderId)}/cancel`,
    {},
    { "X-Order-Token": order.accessToken }
  );
}

async function startCheckout(planId) {
  if (checkoutInProgress || !gatewayConfig?.configured || !gatewayConfig.databaseReady) return;
  if (typeof window.Razorpay !== "function") {
    paymentStatus.textContent = "Secure Razorpay Checkout could not be loaded. Check your connection and try again.";
    paymentStatus.classList.add("payment-status-error");
    return;
  }

  const plan = gatewayConfig.plans.find(item => item.id === planId);
  if (!plan) {
    paymentStatus.textContent = "This payment plan could not be loaded. Refresh the page and try again.";
    paymentStatus.classList.add("payment-status-error");
    return;
  }

  if (!pendingOrderKeys.has(planId)) {
    if (typeof window.crypto?.randomUUID !== "function") {
      paymentStatus.textContent = "Secure payment setup needs an up-to-date browser over HTTPS.";
      paymentStatus.classList.add("payment-status-error");
      return;
    }
    pendingOrderKeys.set(planId, window.crypto.randomUUID());
  }

  checkoutInProgress = true;
  setButtonsDisabled(true);
  paymentStatus.classList.remove("payment-status-error");
  paymentStatus.textContent = `Creating a secure order for ${plan.name} (${formatPrice(plan.amount)})…`;

  let order;
  try {
    order = await requestOrder(planId, pendingOrderKeys.get(planId));
    saveOrderToken(order.orderId, order.accessToken);
  } catch (error) {
    checkoutInProgress = false;
    setButtonsDisabled(false);
    paymentStatus.textContent = error.message;
    paymentStatus.classList.add("payment-status-error");
    return;
  }

  if (order.status === "verified") {
    navigateToResult(order.orderId);
    return;
  }
  if (order.status !== "created") {
    checkoutInProgress = false;
    pendingOrderKeys.delete(planId);
    setButtonsDisabled(false);
    paymentStatus.textContent = "This order is no longer available. Start a new payment attempt.";
    paymentStatus.classList.add("payment-status-error");
    return;
  }

  checkoutTerminal = false;
  try {
    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amountPaise,
      currency: order.currency,
      name: "Bhagath Yoga Center",
      description: order.planName,
      image: new URL("assets/logo.jpeg", window.location.href).href,
      order_id: order.orderId,
      theme: { color: "#223b31" },
      handler: async response => {
        if (checkoutTerminal) return;
        checkoutTerminal = true;
        pendingOrderKeys.delete(planId);
        paymentStatus.textContent = "Verifying your payment securely with Razorpay…";
        try {
          await verifyPayment(order, {
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          });
        } catch (error) {
          paymentStatus.textContent = `${error.message} Checking the payment status…`;
          navigateToResult(order.orderId);
        }
      },
      modal: {
        ondismiss: async () => {
          if (checkoutTerminal) return;
          checkoutTerminal = true;
          pendingOrderKeys.delete(planId);
          try {
            await cancelOrder(order);
          } catch {
            paymentStatus.textContent = "Checkout closed. Payment status will be checked before showing a result.";
          }
          navigateToResult(order.orderId);
        }
      }
    });

    checkout.on("payment.failed", async event => {
      if (checkoutTerminal) return;
      checkoutTerminal = true;
      pendingOrderKeys.delete(planId);
      const paymentId = event?.error?.metadata?.payment_id;
      if (typeof paymentId === "string") {
        try {
          await reportFailure(order, paymentId);
        } catch {
          paymentStatus.textContent = "Razorpay has not confirmed the payment status yet. Checking before showing a result…";
        }
      }
      navigateToResult(order.orderId);
    });
    checkout.open();
  } catch {
    checkoutInProgress = false;
    pendingOrderKeys.delete(planId);
    setButtonsDisabled(false);
    paymentStatus.textContent = "Razorpay Checkout could not be opened. No payment is confirmed. Please try again.";
    paymentStatus.classList.add("payment-status-error");
  }
}

async function loadGatewayConfig() {
  try {
    const response = await fetch("/api/config", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "The payment service is unavailable.");
    if (!Array.isArray(data.plans) || data.plans.length !== Object.keys(expectedPlans).length) {
      throw new Error("The payment plan list could not be verified.");
    }

    for (const [planId, expected] of Object.entries(expectedPlans)) {
      const actual = data.plans.find(plan => plan.id === planId);
      if (!actual || actual.name !== expected.name || actual.amount !== expected.amount || actual.currency !== "INR") {
        throw new Error("The plan details do not match the studio's approved price list.");
      }
      const price = document.querySelector(`[data-plan-price="${planId}"]`);
      if (price) price.textContent = formatPrice(actual.amount);
    }

    gatewayConfig = data;
    if (!data.configured) {
      configStatus.textContent = "Razorpay is not configured. Please contact the studio.";
      configStatus.dataset.state = "error";
      setButtonsDisabled(true);
    } else if (!data.databaseReady) {
      configStatus.textContent = "Secure payment records are unavailable right now. Please try again later or contact the studio.";
      configStatus.dataset.state = "error";
      setButtonsDisabled(true);
    } else if (typeof window.Razorpay !== "function") {
      configStatus.textContent = "Razorpay Checkout did not load. Check your connection and refresh this page.";
      configStatus.dataset.state = "error";
      setButtonsDisabled(true);
    } else {
      configStatus.textContent = "Secure checkout is ready. Payment is confirmed only after server verification.";
      configStatus.dataset.state = "ready";
      setButtonsDisabled(false);
    }
  } catch (error) {
    configStatus.textContent = error.message || "Payment setup could not be checked. Please refresh or contact the studio.";
    configStatus.dataset.state = "error";
    setButtonsDisabled(true);
  }
}

planButtons.forEach(button => {
  button.addEventListener("click", () => startCheckout(button.dataset.planPay));
});

loadGatewayConfig();
