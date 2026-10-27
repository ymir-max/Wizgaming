
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const HITPAY_BASE_URL = "https://api.hit-pay.com";

const USD_PER_GAME_CASH = 0.15;
const PHP_PER_USD = 64;

const ALLOWED_GAMES = [
  "LEGEND AEGIS",
  "ASTRAL",
  "ROM",
  "ROM: REMEMBER OF MAJESTY"
];

// Tinatanggap ang values mula sa HTML payment form.
const PAYMENT_METHOD_MAP = {
  "GCASH / MAYA": "ewallet",
  "GCASH": "ewallet",
  "MAYA": "ewallet",
  "QR PH": "qr_ph",
  "BANK": "bank_transfer",
  "BANK TRANSFER": "bank_transfer",
  "USDT": "binance_usdt",
  "BINANCE USDT": "binance_usdt",
  "EWALLET": "ewallet",
  "QR_PH": "qr_ph",
  "BANK_TRANSFER": "bank_transfer",
  "BINANCE_USDT": "binance_usdt"
};

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

    const paymentMethodInput =
      body.payment_method ?? "";

    const submittedGame = String(gameNameInput)
      .trim()
      .toUpperCase();

    const gameUsername = String(gameUsernameInput).trim();
    const email = String(emailInput).trim();
    const cash = Number(cashInput);

    const submittedMethod = String(paymentMethodInput)
      .trim()
      .toUpperCase();

    const method = PAYMENT_METHOD_MAP[submittedMethod];

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

    if (!method) {
      return sendError(
        res,
        400,
        "Please select a valid payment method."
      );
    }

    // Normalize the game name before saving.
    const gameName = submittedGame.startsWith("ROM")
      ? "ROM"
      : submittedGame;

    // Server-side price calculation.
    const priceUSD = Number(
      (cash * USD_PER_GAME_CASH).toFixed(2)
    );

    const pricePHP = Number(
      (priceUSD * PHP_PER_USD).toFixed(2)
    );

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
        payment_method: method,
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
    // The final payment methods depend on your HitPay account.
    const paymentPayload = {
      amount: pricePHP.toFixed(2),
      currency: "PHP",
      email: email,
      purpose: `WIZ GAMING ${gameName} - ${cash} Game Cash`,
      reference_number: orderNumber,
      redirect_url: "https://wizgaming.vercel.app/?payment=return"
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
