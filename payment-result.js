"use strict";

const orderId = new URLSearchParams(window.location.search).get("order_id");
const tokenStorageKey = "bhagath:razorpay-order-tokens";
const title = document.getElementById("payment-result-title");
const eyebrow = document.getElementById("payment-result-eyebrow");
const message = document.getElementById("payment-result-message");
const statusLabel = document.getElementById("payment-result-status");
const planLabel = document.getElementById("payment-result-plan");
const amountLabel = document.getElementById("payment-result-amount");
const referenceLabel = document.getElementById("payment-result-reference");
const retryButton = document.getElementById("payment-result-retry");

function getOrderToken() {
  try {
    const tokens = JSON.parse(sessionStorage.getItem(tokenStorageKey) || "{}");
    return typeof tokens[orderId] === "string" ? tokens[orderId] : "";
  } catch {
    return "";
  }
}

function formatPrice(amount) {
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function renderUnavailable(text) {
  eyebrow.textContent = "Payment status unavailable";
  title.textContent = "We couldn’t verify this order.";
  message.textContent = text;
  statusLabel.textContent = "Not confirmed";
  retryButton.hidden = true;
}

function renderOrder(order) {
  planLabel.textContent = order.planName;
  amountLabel.textContent = formatPrice(order.amount);
  referenceLabel.textContent = order.paymentReference || "Not available";

  if (order.status === "verified") {
    eyebrow.textContent = "Payment verified";
    title.textContent = "Thank you for your payment.";
    message.textContent = "Razorpay confirmed this payment with our server. Keep the payment reference for your membership or course follow-up.";
    statusLabel.textContent = "Successful";
    retryButton.hidden = true;
    return;
  }
  if (order.status === "failed") {
    eyebrow.textContent = "Payment not completed";
    title.textContent = "The payment was not captured.";
    message.textContent = "Razorpay confirmed that this payment attempt failed. No successful payment is recorded.";
    statusLabel.textContent = "Failed";
    retryButton.hidden = true;
    return;
  }
  if (order.status === "cancelled") {
    eyebrow.textContent = "Checkout closed";
    title.textContent = "This checkout was cancelled.";
    message.textContent = "Checkout closed before a verified payment was recorded. If you approved a payment, contact the studio before trying again.";
    statusLabel.textContent = "Cancelled";
    retryButton.hidden = true;
    return;
  }

  eyebrow.textContent = "Payment status pending";
  title.textContent = "Your payment is not confirmed yet.";
  message.textContent = "The server has not confirmed this payment. Do not start another payment while its status is pending.";
  statusLabel.textContent = "Pending verification";
  retryButton.hidden = !sessionStorage.getItem(`bhagath:razorpay-verification:${orderId}`);
}

async function retryVerification() {
  const storageKey = `bhagath:razorpay-verification:${orderId}`;
  let pending;
  try {
    pending = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  } catch {
    return;
  }
  if (!pending || pending.razorpay_order_id !== orderId) return;

  const response = await fetch("/api/payments/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pending),
    credentials: "same-origin",
    cache: "no-store"
  });
  if (response.ok) {
    const result = await response.json();
    if (result.status === "verified") sessionStorage.removeItem(storageKey);
  } else if (response.status === 400 || response.status === 422) {
    sessionStorage.removeItem(storageKey);
  }
}

async function loadOrder() {
  const token = getOrderToken();
  if (!/^order_[A-Za-z0-9]+$/.test(orderId || "") || !token) {
    renderUnavailable("This result cannot be verified in this browser session. Return to the plans page or contact Bhagath Yoga Center. No successful payment is being displayed.");
    return;
  }

  try {
    await retryVerification();
  } catch {
    message.textContent = "The payment verification service could not be reached. This payment is not confirmed here; check again or contact the studio.";
  }

  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, {
      headers: { "X-Order-Token": token },
      credentials: "same-origin",
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      renderUnavailable(result.error || "The payment server could not verify this order. No successful payment is being displayed.");
      return;
    }
    renderOrder(result);
  } catch {
    renderUnavailable("The payment server could not be reached. No successful payment is being displayed.");
  }
}

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  await loadOrder();
  retryButton.disabled = false;
});

document.title = "Payment Status | Bhagath Yoga Center";
loadOrder();
