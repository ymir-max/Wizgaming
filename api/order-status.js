import { createClient } from "@supabase/supabase-js";

// Public, read-only status check used by the "payment return" popup.
// Returns ONLY the payment status. No personal data is ever returned.
// Order numbers contain a random part, so they cannot be guessed.
const ORDER_NUMBER_PATTERN = /^WIZ-\d{10,16}-[A-F0-9]{8}$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  const order = String(req.query?.order ?? "").trim();

  if (!ORDER_NUMBER_PATTERN.test(order)) {
    return res.status(400).json({ success: false, error: "Invalid order number." });
  }

  try {
    const url = process.env.SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SECRET_KEY?.trim();

    if (!url || !key) {
      throw new Error("Missing Supabase environment variables.");
    }

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data, error } = await supabase
      .from("game_recharge_orders")
      .select("payment_status")
      .eq("order_number", order)
      .maybeSingle();

    if (error) {
      console.error("Order status lookup failed:", { code: error.code, message: error.message });
      return res.status(500).json({ success: false, error: "Unable to check order." });
    }

    if (!data) {
      return res.status(404).json({ success: false, status: "not_found" });
    }

    return res.status(200).json({ success: true, status: data.payment_status });
  } catch (error) {
    console.error("Order status error:", { message: error?.message });
    return res.status(500).json({ success: false, error: "Unable to check order." });
  }
}
