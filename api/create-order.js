
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const GAMES = ["LEGEND AEGIS", "ASTRAL", "ROM"];
const METHODS = [
  "ewallet",
  "binance_usdt",
  "bank_transfer",
  "qr_ph"
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
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
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email) ||
      !Number.isInteger(cash) ||
      cash < 50 ||
      cash > 5000 ||
      cash % 50 !== 0 ||
      !METHODS.includes(payment_method)
    ) {
      return res.status(400).json({ error: "Invalid order details" });
    }

    const price = Number((cash * 0.15).toFixed(2));
    const orderNumber =
      "WIZ-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();

    const { data, error } = await supabase
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
      .select("order_number, game_name, game_cash, price_usd, payment_method, payment_status")
      .single();

    if (error) {
      console.error("Order creation failed:", error.message);
      return res.status(500).json({ error: "Could not create order" });
    }

    return res.status(201).json({ order: data });
  } catch (error) {
    console.error("Unexpected order error:", error.message);
    return res.status(500).json({ error: "Server error" });
  }
}
