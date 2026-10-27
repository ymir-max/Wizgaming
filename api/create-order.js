import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

// LIVE HitPay API URL — huwag palitan ng Sandbox URL.
const HITPAY_BASE_URL = "https://api.hit-pay.com";

// Pricing configuration
const USD_PER_GAME_CASH = 0.15;
const PHP_PER_USD = 64;

// Allowed games and payment methods
const ALLOWED_GAMES = [
  "LEGEND AEGIS",
  "ASTRAL",
  "ROM"
];

const ALLOWED_PAYMENT_METHODS = [
  "ewallet",
  "binance_usdt",
  "bank_transfer",
  "qr_ph"
];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables.");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

export default async function handler(req, res) {
  // Allow POST requests only
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  let supabase;
  let orderId;

  try {
    const apiKey = getRequiredEnv("HITPAY_API_KEY");
    supabase = getSupabase();

    // Read submitted order details
    const {
      game_name,
      game_username,
      customer_email,
      game_cash,
      payment_method
    } = req.body || {};

    const gameName = String(game_name || "").trim();
    const gameUsername = String(game_username || "").trim();
    const email = String(customer_email || "").trim();
    const cash = Number(game_cash);
    const method = String(payment_method || "").trim();

    // Validate game
    if (!ALLOWED_GAMES.includes(gameName)) {
      return res.status(400).json({
        error: "Invalid game selected."
      });
    }

    // Validate game username
    if (
      !gameUsername ||
      gameUsername.length > 100
    ) {
      return res.status(400).json({
        error: "Please enter a valid game username."
      });
    }

    // Validate email
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254
    ) {
      return res.status(400).json({
        error: "Please enter a valid email address."
      });
    }

    // Validate Game Cash: 50–5000, increments of 50
    if (
      !Number.isInteger(cash) ||
      cash < 50 ||
      cash > 5000 ||
      cash % 50 !== 0
    ) {
      return res.status(400).json({
        error: "Game Cash must be 50–5000 in increments of 50."
      });
    }

    // Validate payment method
    if (!ALLOWED_PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({
        error: "Invalid payment method selected."
      });
    }

    // Calculate prices
    const priceUSD = Number(
      (cash * USD_PER_GAME_CASH).toFixed(2)
    );

    const pricePHP = Number(
      (priceUSD * PHP_PER_USD).toFixed(2)
    );

    // Create unique order number
    const orderNumber =
      `WIZ-${Date.now()}-${randomUUID()
        .slice(0, 8)
        .toUpperCase()}`;

    // Save pending order in Supabase
    const { data: order, error: insertError } =
      await supabase
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
        .select()
        .single();

    if (insertError) {
      console.error("Supabase insert error:", insertError);

      return res.status(500).json({
        error: "Unable to create your order. Please try again."
      });
    }

    orderId = order.id;

    // Create HitPay Live payment request.
    // Payment methods must be enabled and supported
    // by your HitPay account.
    const paymentPayload = {
      amount: pricePHP.toFixed(2),
      currency: "PHP",
      email: email,
      purpose: `WIZ GAMING ${gameName} - ${cash} Game Cash`,
      reference_number: orderNumber,
      redirect_url:
        "https://wizgaming.vercel.app/?payment=return",
      payment_methods: [
        "gcash",
        "qrph_netbank",
        "card"
      ]
    };

    const hitpayResponse = await fetch(
      `${HITPAY_BASE_URL}/v1/payment-requests`,
      {
        method: "POST",
        headers: {
          "X-BUSINESS-API-KEY": apiKey,
          "Content-Type": "application/json"
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
        error: hitpayData.error || hitpayData.message || responseText
      });

      // Keep the order in the database for troubleshooting.
      await supabase
        .from("game_recharge_orders")
        .update({
          payment_status: "failed"
        })
        .eq("id", orderId);

      return res.status(502).json({
        error: "Unable to create the HitPay checkout. Please try again."
      });
    }

    const paymentRequestId = hitpayData.id;
    const checkoutUrl =
      hitpayData.url || hitpayData.checkout_url;

    if (!paymentRequestId || !checkoutUrl) {
      console.error(
        "Unexpected HitPay response:",
        hitpayData
      );

      await supabase
        .from("game_recharge_orders")
        .update({
          payment_status: "failed"
        })
        .eq("id", orderId);

      return res.status(502).json({
        error: "HitPay did not return a valid checkout link."
      });
    }

    // Save HitPay checkout details
    const { error: updateError } = await supabase
      .from("game_recharge_orders")
      .update({
        hitpay_payment_request_id: String(paymentRequestId),
        hitpay_checkout_url: checkoutUrl
      })
      .eq("id", orderId);

    if (updateError) {
      console.error("Supabase update error:", updateError);

      return res.status(500).json({
        error: "Checkout was created, but the order could not be updated. Contact support before retrying."
      });
    }

    // Return checkout details to the website
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
    console.error("Create order error:", error);

    return res.status(500).json({
      error: "A server error occurred while creating your order."
    });
  }
}
```
