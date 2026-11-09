import { getPricingRates, RMB_PER_COIN } from "./_rates.js";

// Public endpoint: the website uses this to show the same live rate
// that create-order.js uses when charging.
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, error: "Method not allowed." });
  }

  try {
    const rates = await getPricingRates();

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");

    return res.status(200).json({
      success: true,
      rmb_per_coin: RMB_PER_COIN,
      ...rates
    });
  } catch (error) {
    console.error("Rate endpoint error:", error?.message);
    return res.status(500).json({ success: false, error: "Unable to get the current rate." });
  }
}
