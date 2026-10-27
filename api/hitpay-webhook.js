
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const MAX_BODY_SIZE = 1024 * 1024;

function requiredEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value.trim();
}

function getSupabase() {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SECRET_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_SIZE) {
      throw new Error("Webhook body too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function validSignature(rawBody, receivedSignature, salt) {
  if (
    typeof receivedSignature !== "string" ||
    !/^[a-f0-9]{64}$/i.test(receivedSignature)
  ) {
    return false;
  }

  const expectedSignature = createHmac("sha256", salt)
    .update(rawBody)
    .digest();

  const suppliedSignature = Buffer.from(
    receivedSignature,
    "hex"
  );

  return (
    suppliedSignature.length === expectedSignature.length &&
    timingSafeEqual(suppliedSignature, expectedSignature)
  );
}

function sameAmount(actual, expected) {
  const actualNumber = Number(actual);
  const expectedNumber = Number(expected);

  return (
    Number.isFinite(actualNumber) &&
    Number.isFinite(expectedNumber) &&
    Math.round(actualNumber * 100) ===
      Math.round(expectedNumber * 100)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }

  try {
    const salt = requiredEnv("HITPAY_SALT");
    const rawBody = await readRawBody(req);

    // Verify the signature against the original, unmodified body.
    const signature =
      req.headers["hitpay-signature"];

    if (!validSignature(rawBody, signature, salt)) {
      console.warn("HitPay webhook rejected: invalid signature.");

      return res.status(401).json({
        success: false,
        error: "Invalid webhook signature."
      });
    }

    let payload;

    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({
        success: false,
        error: "Invalid JSON payload."
      });
    }

    // Support common payment-request webhook field layouts.
    const payment =
      payload.data ||
      payload.payment_request ||
      payload;

    const event = String(
      payload.event ||
      payload.event_type ||
      payload.type ||
      ""
    ).toLowerCase();

    const status = String(
      payment.status ||
      payload.status ||
      ""
    ).toLowerCase();

    const orderNumber =
      payment.reference_number ||
      payload.reference_number ||
      payment.reference ||
      payload.reference;

    const paymentRequestId =
      payment.payment_request_id ||
      payment.id ||
      payload.payment_request_id;

    const amount =
      payment.amount ??
      payload.amount;

    const currency = String(
      payment.currency ||
      payload.currency ||
      ""
    ).toUpperCase();

    // Only process successful payment-request events.
    if (
      event &&
      !event.includes("payment_request.completed")
    ) {
      console.info("Ignoring unrelated HitPay event:", event);

      return res.status(200).json({
        success: true,
        ignored: true
      });
    }

    if (status !== "completed") {
      console.info("Ignoring non-completed payment event:", status);

      return res.status(200).json({
        success: true,
        ignored: true
      });
    }

    if (
      typeof orderNumber !== "string" ||
      !orderNumber.startsWith("WIZ-") ||
      !paymentRequestId
    ) {
      console.warn("HitPay webhook missing order identifiers.");

      return res.status(400).json({
        success: false,
        error: "Missing payment identifiers."
      });
    }

    const supabase = getSupabase();

    // Find the exact order created by our server.
    const { data: order, error: lookupError } = await supabase
      .from("game_recharge_orders")
      .select(
        "id, order_number, price_php, payment_status, hitpay_payment_request_id"
      )
      .eq("order_number", orderNumber)
      .maybeSingle();

    if (lookupError) {
      console.error("Webhook order lookup failed:", {
        code: lookupError.code,
        message: lookupError.message
      });

      return res.status(500).json({
        success: false,
        error: "Unable to look up order."
      });
    }

    if (!order) {
      console.warn("Webhook order not found:", orderNumber);

      return res.status(404).json({
        success: false,
        error: "Order not found."
      });
    }

    // Idempotency: do not process an already-paid order again.
    if (order.payment_status === "paid") {
      return res.status(200).json({
        success: true,
        already_processed: true
      });
    }

    // Do not accept a payment request ID that differs from
    // the one saved when our server created the checkout.
    if (
      !order.hitpay_payment_request_id ||
      String(order.hitpay_payment_request_id) !==
        String(paymentRequestId)
    ) {
      console.warn("Webhook payment request ID mismatch:", orderNumber);

      return res.status(400).json({
        success: false,
        error: "Payment request ID mismatch."
      });
    }

    // Verify the amount and currency before marking paid.
    if (
      currency !== "PHP" ||
      !sameAmount(amount, order.price_php)
    ) {
      console.error("Webhook amount/currency mismatch:", {
        orderNumber,
        currency,
        amount
      });

      return res.status(400).json({
        success: false,
        error: "Payment amount or currency mismatch."
      });
    }

    // Only transition a pending order to paid.
    // The filter prevents concurrent duplicate webhook updates.
    const { data: updatedOrders, error: updateError } =
      await supabase
        .from("game_recharge_orders")
        .update({
          payment_status: "paid",
          payment_reference: String(paymentRequestId),
          paid_at: new Date().toISOString()
        })
        .eq("id", order.id)
        .eq("payment_status", "pending")
        .select("id");

    if (updateError) {
      console.error("Webhook order update failed:", {
        code: updateError.code,
        message: updateError.message
      });

      return res.status(500).json({
        success: false,
        error: "Unable to update payment status."
      });
    }

    // Another webhook may have processed the order first.
    if (!updatedOrders || updatedOrders.length === 0) {
      return res.status(200).json({
        success: true,
        already_processed: true
      });
    }

    console.info("WIZ GAMING payment verified:", orderNumber);

    return res.status(200).json({
      success: true,
      verified: true
    });
  } catch (error) {
    console.error("HitPay webhook error:", {
      message: error?.message
    });

    return res.status(500).json({
      success: false,
      error: "Webhook processing failed."
    });
  }
}
