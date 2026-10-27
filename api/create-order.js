```javascript
// api/create-order.js

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Allowed games
const GAMES = ["LEGEND AEGIS", "ASTRAL", "ROM"];

// Accepted payment selections from your website
const METHODS = [
  "ewallet",
  "binance_usdt",
  "bank_transfer",
  "qr_ph"
];

// HitPay Live API base URL
const HITPAY_BASE_URL =
  process.env.HITPAY_API_BASE_URL ||
  "https://api.hit-pay.com";

// Pricing configuration
const USD_PER_GAME_CASH = 0.15;
const PHP_PER_USD = 64;

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // Check required environment variables
  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.HITPAY_API_KEY
  ) {
    return res.status(500).json({
      error: "Server configuration is incomplete"
    });
  }

  try {
    const {
      game_name,
      game_username,
      customer_email,
      game_cash,
      payment_method
    } = req.body || {};

    const cash = Number(game_cash);

    // Validate order details
    if (
      !GAMES.includes(game_name) ||
      typeof game_username !== "string" ||
      game_username.trim().length < 1 ||
      game_username.trim().length > 100 ||
      typeof customer_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        customer_email.trim()
      ) ||
      !Number.isInteger(cash) ||
      cash < 50 ||
      cash > 5000 ||
      cash % 50 !== 0 ||
      !METHODS.includes(payment_method)
    ) {
      return res.status(400).json({
        error: "Invalid order details"
      });
    }

    // Calculate USD reference price and PHP checkout price
    const priceUSD = Number(
      (cash * USD_PER_GAME_CASH).toFixed(2)
    );

    const pricePHP = Number(
      (priceUSD * PHP_PER_USD).toFixed(2)
    );

    const orderNumber =
      "WIZ-" +
      randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)
        .toUpperCase();

    // 1. Create pending order in Supabase
    const { data: order, error: insertError } =
      await supabase
        .from("game_recharge_orders")
        .insert({
          order_number: orderNumber,
          game_name,
          game_username: game_username.trim(),
          customer_email: customer_email
            .trim()
            .toLowerCase(),
          game_cash: cash,
          price_usd: priceUSD,
          price_php: pricePHP,
          payment_method,
          payment_status: "pending"
        })
        .select(
          "order_number, game_name, game_username, customer_email, game_cash, price_usd, price_php, payment_method, payment_status"
        )
        .single();

    if (insertError) {
      console.error(
        "Order creation failed:",
        insertError.message
      );

      return res.status(500).json({
        error: "Could not create order"
      });
    }

    // 2. Request HitPay hosted checkout in PHP
    const paymentPayload = {
      amount: pricePHP.toFixed(2),
      currency: "PHP",
      email: order.customer_email,
      purpose: `WIZ GAMING ${game_name} - ${cash} Game Cash`,
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
      `${HITPAY_BASE_URL.replace(/\/+$/, "")}/v1/payment-requests`,
      {
        method: "POST",
        headers: {
          "X-BUSINESS-API-KEY":
            process.env.HITPAY_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(paymentPayload)
      }
    );

    const payment = await hitpayResponse
      .json()
      .catch(() => ({}));

    // Check whether HitPay created the checkout
    if (
      !hitpayResponse.ok ||
      !payment.id ||
      !payment.url
    ) {
      console.error("HitPay request failed:", {
        status: hitpayResponse.status,
        error:
          payment.message ||
          payment.error ||
          "Unknown HitPay error"
      });

      return res.status(502).json({
        error: "HitPay could not create checkout",
        order_number: orderNumber,
        hitpay_status: hitpayResponse.status
      });
    }

    // 3. Save HitPay checkout details in Supabase
    const { error: updateError } = await supabase
      .from("game_recharge_orders")
      .update({
        hitpay_payment_request_id: String(payment.id),
        hitpay_checkout_url: payment.url
      })
      .eq("order_number", orderNumber);

    if (updateError) {
      console.error(
        "Saving HitPay checkout failed:",
        updateError.message
      );

      return res.status(500).json({
        error: "Checkout created but could not be saved",
        order_number: orderNumber
      });
    }

    // 4. Return order details and checkout URL
    // Payment status stays pending until verified server-side.
    return res.status(201).json({
      order: {
        ...order,
        hitpay_payment_request_id: String(payment.id)
      },
      checkout_url: payment.url
    });

  } catch (error) {
    console.error(
      "Unexpected order error:",
      error.message
    );

    return res.status(500).json({
      error: "Server error"
    });
  }
}
```
