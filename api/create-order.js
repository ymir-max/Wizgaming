import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { getPricingRates, calculatePrice } from "./_rates.js";

// Defaults are PRODUCTION. For sandbox testing, set these in Vercel:
//   HITPAY_API_URL=https://api.sandbox.hit-pay.com
//   HITPAY_CURRENCY=SGD
const HITPAY_BASE_URL =
  process.env.HITPAY_API_URL?.trim() || "https://api.hit-pay.com";
const HITPAY_CURRENCY =
  (process.env.HITPAY_CURRENCY?.trim() || "PHP").toUpperCase();

const ALLOWED_GAMES = [
  "LEGEND AEGIS",
  "MIR4 RED FRUIT",
  "ASTRAL",
  "ROM",
  "ROM: REMEMBER OF MAJESTY"
];

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value.trim();
}

function getSupabase() {
  return createClient(
    getRequiredEnv("SUPABASE_URL"),
    getRequiredEnv("SUPABASE_SECRET_KEY"),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  );
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

// Verifies the Cloudflare Turnstile token (bot protection).
// If TURNSTILE_SECRET_KEY is not set, verification is skipped so the site
// keeps working while you set it up. Set it in Vercel to turn protection on.
async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();

  if (!secret) {
    console.warn("TURNSTILE_SECRET_KEY is not set; skipping bot verification.");
    return true;
  }

  if (typeof token !== "string" || !token || token.length > 2048) {
    return false;
  }

  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);

    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(8000)
      }
    );

    const result = await response.json();
    return result.success === true;
  } catch (error) {
    console.error("Turnstile verification error:", error?.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Method not allowed.");
  }

  let supabase;
  let orderId = null;

  try {
    const apiKey = getRequiredEnv("HITPAY_API_KEY");
    supabase = getSupabase();

    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return sendError(res, 400, "Invalid request body.");
      }
    }

    // Support sa kasalukuyang HTML form field names
    // at sa mga pangalan na ginagamit ng API.
    const gameNameInput =
      body.game_name ?? body.game ?? "";

    const gameUsernameInput =
      body.game_username ?? body.username ?? "";

    const emailInput =
      body.customer_email ?? body.email ?? "";

    const cashInput =
      body.game_cash ?? body.amount;

    const submittedGame = String(gameNameInput)
      .trim()
      .toUpperCase();

    const gameUsername = String(gameUsernameInput).trim();
    const email = String(emailInput).trim();
    const cash = Number(cashInput);

    if (!ALLOWED_GAMES.includes(submittedGame)) {
      return sendError(res, 400, "Please select a valid game.");
    }

    if (!gameUsername || gameUsername.length > 100) {
      return sendError(
        res,
        400,
        "Please enter a valid in-game username."
      );
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return sendError(
        res,
        400,
        "Please enter a valid email address."
      );
    }

    if (
      !Number.isInteger(cash) ||
      cash < 50 ||
      cash > 5000 ||
      cash % 50 !== 0
    ) {
      return sendError(
        res,
        400,
        "Game Cash must be 50–5000 in increments of 50."
      );
    }

    // Honeypot: real visitors never fill this hidden field.
    if (body.website) {
      return sendError(res, 400, "Unable to process your request.");
    }

    // Bot protection (Cloudflare Turnstile).
    const clientIp = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();

    if (!(await verifyTurnstile(body.turnstile_token, clientIp))) {
      return sendError(
        res,
        400,
        "Verification failed. Please refresh and try again."
      );
    }

    // The customer must agree to the Terms & Conditions (no refunds once processed).
    if (body.accepted_terms !== true) {
      return sendError(
        res,
        400,
        "Please agree to the Terms & Conditions to continue."
      );
    }

    // Normalize the game name before saving.
    const gameName = submittedGame.startsWith("ROM")
      ? "ROM"
      : submittedGame;

    // Server-side price calculation (1 Game Cash = 1 RMB, live RMB rate).
    const rates = await getPricingRates();
    const { totalRMB, pricePHP, priceUSD } = calculatePrice(cash, rates);

    // Generate a unique order number.
    const orderNumber =
      `WIZ-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;

    // STEP 1: Save the pending order in Supabase.
    const { data: order, error: insertError } = await supabase
      .from("game_recharge_orders")
      .insert({
        order_number: orderNumber,
        game_name: gameName,
        game_username: gameUsername,
        customer_email: email,
        game_cash: cash,
        price_usd: priceUSD,
        price_php: pricePHP,
        payment_method: "hitpay",
        payment_status: "pending"
      })
      .select("id, order_number")
      .single();

    if (insertError) {
      console.error("Supabase insert error:", {
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint
      });

      return sendError(
        res,
        500,
        "Unable to save your order. Please try again."
      );
    }

    orderId = order.id;

    // STEP 2: Create the HitPay checkout.
    // Customer picks the payment method on the HitPay checkout page.
    const paymentPayload = {
      amount: pricePHP.toFixed(2),
      currency: HITPAY_CURRENCY,
      email: email,
      purpose: `WIZ GAMING ${gameName} - ${cash} Game Cash`,
      reference_number: orderNumber,
      redirect_url: `https://wizgaming.vercel.app/?payment=return&order=${encodeURIComponent(orderNumber)}`
    };

    const hitpayResponse = await fetch(
      `${HITPAY_BASE_URL}/v1/payment-requests`,
      {
        method: "POST",
        headers: {
          "X-BUSINESS-API-KEY": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(paymentPayload)
      }
    );

    const responseText = await hitpayResponse.text();

    let hitpayData = {};

    try {
      hitpayData = JSON.parse(responseText);
    } catch {
      // Handled below if HitPay returns an unexpected response.
    }

    if (!hitpayResponse.ok) {
      console.error("HitPay request failed:", {
        status: hitpayResponse.status,
        error:
          hitpayData.error ||
          hitpayData.message ||
          responseText.slice(0, 1000)
      });

      await supabase
        .from("game_recharge_orders")
        .update({ payment_status: "failed" })
        .eq("id", orderId);

      return sendError(
        res,
        502,
        "Unable to create the payment checkout. Please try again."
      );
    }

    const paymentRequestId = hitpayData.id;
    const checkoutUrl =
      hitpayData.url || hitpayData.checkout_url;

    if (
      !paymentRequestId ||
      !checkoutUrl ||
      typeof checkoutUrl !== "string" ||
      !checkoutUrl.startsWith("https://")
    ) {
      console.error("Unexpected HitPay response:", {
        id: hitpayData.id,
        hasUrl: Boolean(hitpayData.url),
        hasCheckoutUrl: Boolean(hitpayData.checkout_url)
      });

      await supabase
        .from("game_recharge_orders")
        .update({ payment_status: "failed" })
        .eq("id", orderId);

      return sendError(
        res,
        502,
        "The payment provider did not return a valid checkout link."
      );
    }

    // STEP 3: Save the HitPay checkout information.
    const { error: updateError } = await supabase
      .from("game_recharge_orders")
      .update({
        hitpay_payment_request_id: String(paymentRequestId),
        hitpay_checkout_url: checkoutUrl
      })
      .eq("id", orderId);

    if (updateError) {
      console.error("Supabase checkout update error:", {
        code: updateError.code,
        message: updateError.message,
        details: updateError.details
      });

      return sendError(
        res,
        500,
        "Checkout was created, but saving the checkout details failed. Contact support before retrying."
      );
    }

    // STEP 4: Send the checkout URL to the frontend.
    return res.status(200).json({
      success: true,
      order_id: order.id,
      order_number: orderNumber,
      game_name: gameName,
      game_username: gameUsername,
      game_cash: cash,
      price_usd: priceUSD,
      price_php: pricePHP,
      price_rmb: totalRMB,
      php_per_rmb: rates.php_per_rmb,
      currency: "PHP",
      checkout_url: checkoutUrl
    });
  } catch (error) {
    console.error("Create order error:", {
      message: error?.message,
      stack: error?.stack
    });

    return sendError(
      res,
      500,
      "A server error occurred while creating your order."
    );
  }
}
