
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const GAMES = ["LEGEND AEGIS", "ASTRAL", "ROM"];
const METHODS = ["ewallet", "binance_usdt", "bank_transfer", "qr_ph"];

const HITPAY_BASE_URL =
  process.env.HITPAY_API_BASE_URL ||
  "https://api.sandbox.hit-pay.com";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.HITPAY_API_KEY
  ) {
    return res.status(500).json({
      error: "Server payment configuration is incomplete"
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

    if (
      !GAMES.includes(game_name) ||
      typeof game_username !== "string" ||
      game_username.trim().length < 1 ||
      game_username.trim().length > 100 ||
      typeof customer_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email.trim()) ||
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

    const price = Number((cash * 0.15).toFixed(2));

    const orderNumber =
      "WIZ-" +
      crypto.randomUUID()
        .replaceAll("-", "")
        .slice(0, 12)
        .toUpperCase();

    // 1. Create a pending order.
    const { data: order, error: insertError } = await supabase
      .from("game_recharge_orders")
      .insert({
        order_number: orderNumber,
        game_name,
        game_username: game_username.trim(),
        customer_email: customer_email.trim().toLowerCase(),
        game_cash: cash,
        price_usd: price,
        payment_method,
        payment_status: "pending"
      })
      .select(
        "order_number, game_name, game_cash, price_usd, payment_method, payment_status"
      )
      .single();

    if (insertError) {
      console.error("Order creation failed:", insertError.message);

      return res.status(500).json({
        error: "Could not create order"
      });
    }

    // 2. Create the HitPay hosted checkout request.
    // Leave payment_methods unspecified so HitPay can return
    // the methods enabled for this account and currency.
    const paymentPayload = {
      amount: price.toFixed(2),
      currency: "USD",
      email: order.customer_email,
      purpose: `WIZ GAMING ${game_name} - ${cash} Game Cash`,
      reference_number: orderNumber,
      redirect_url: "https://wizgaming.vercel.app/?payment=return"
    };

    const hitpayResponse = await fetch(
      `${HITPAY_BASE_URL.replace(/\/+$/, "")}/v1/payment-requests`,
      {
        method: "POST",
        headers: {
          "X-BUSINESS-API-KEY": process.env.HITPAY_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(paymentPayload)
      }
    );

    const payment = await hitpayResponse.json().catch(() => ({}));

    if (!hitpayResponse.ok || !payment.id || !payment.url) {
      console.error("HitPay request failed:", {
        status: hitpayResponse.status,
        error: payment.message || payment.error || "Unknown HitPay error"
      });

      return res.status(502).json({
        error: "HitPay could not create checkout",
        order_number: orderNumber,
        hitpay_status: hitpayResponse.status
      });
    }

    // 3. Save HitPay checkout details to the order.
    const { error: updateError } = await supabase
      .from("game_recharge_orders")
      .update({
        hitpay_payment_request_id: String(payment.id),
        hitpay_checkout_url: payment.url
      })
      .eq("order_number", orderNumber);

    if (updateError) {
      console.error("Saving checkout details failed:", updateError.message);

      return res.status(500).json({
        error: "Checkout created but could not be saved",
        order_number: orderNumber
      });
    }

    // 4. Return checkout URL. Order remains pending.
    return res.status(201).json({
      order: {
        ...order,
        hitpay_payment_request_id: String(payment.id)
      },
      checkout_url: payment.url
    });
  } catch (error) {
    console.error("Unexpected order error:", error.message);

    return res.status(500).json({
      error: "Server error"
    });
  }
}
