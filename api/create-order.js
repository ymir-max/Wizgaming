
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

// Tinatanggap ang values ng kasalukuyang HTML form.
const PAYMENT_METHOD_MAP = {
  GCASH: "ewallet",
  MAYA: "ewallet",
  "BANK TRANSFER": "bank_transfer",
  "QR PH": "qr_ph",
  ewallet: "ewallet",
  bank_transfer: "bank_transfer",
  qr_ph: "qr_ph"
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

    // Support JSON request bodies.
    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return sendError(res, 400, "Invalid request body.");
      }
    }

    const {
      game_name,
      game_username,
      customer_email,
      game_cash,
      payment_method
    } = body;

    const submittedGame = String(game_name || "").trim().toUpperCase();
    const gameUsername = String(game_username || "").trim();
    const email = String(customer_email || "").trim();
    const cash = Number(game_cash);

    const submittedMethod = String(payment_method || "")
      .trim()
      .toUpperCase();

    if (!ALLOWED_GAMES.includes(submittedGame)) {
      return sendError(res, 400, "Please select a valid game.");
    }

    if (!gameUsername || gameUsername.length > 100) {
      return sendError(res, 400, "Please enter a valid game username.");
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return sendError(res, 400, "Please enter a valid email address.");
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
        "Game Cash must be between 50 and 5000 in increments of 50."
      );
    }

    const method = PAYMENT_METHOD_MAP[submittedMethod];

    if (!method) {
      return sendError(res, 400, "Please select a valid payment method.");
    }

    // Store ROM under a consistent game name.
    const gameName = submittedGame.startsWith("ROM")
      ? "ROM"
      : submittedGame;

    const priceUSD = Number(
      (cash * USD_PER_GAME_CASH).toFixed(2)
    );

    const pricePHP = Number(
      (priceUSD * PHP_PER_USD).toFixed(2)
    );

    // Correctly formatted order number.
    const orderNumber =
      `WIZ-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;

    // Step 1: Create a pending order in Supabase.
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

    // Step 2: Request a HitPay checkout.
    // HitPay will display the payment methods enabled for your account.
    const paymentPayload = {
      amount: pricePHP.toFixed(2),
      currency: "PHP",
      email,
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

    let hitpayData;

    try {
      hitpayData = JSON.parse(responseText);
    } catch {
      hitpayData = {};
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
    const checkoutUrl = hitpayData.url || hitpayData.checkout_url;

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

    // Step 3: Save the checkout details.
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
        "Your checkout was created, but we could not finish saving the order. Contact support before trying again."
      );
    }

    // Step 4: Return the checkout URL to the frontend.
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
    // Keep detailed errors in server logs, not in the public response.
    console.error("Create order error:", {
      message: error?.message,
      stack: error?.stack
    });

    return sendError(
      res,
      500,
      "A server error occurred while creating your order. Please try again."
    );
  }
}
