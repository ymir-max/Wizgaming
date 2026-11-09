// Shared live-rate helper (CNY/RMB -> PHP and USD).
// The underscore prefix keeps Vercel from exposing this file as a route.

// 1 platform coin (Game Cash) = 1 RMB (CNY)
export const RMB_PER_COIN = 1;

// Optional markup (%) to cover conversion fees / rate movement.
// Set in Vercel: RMB_MARKUP_PERCENT=3
const MARKUP_PERCENT = Number(process.env.RMB_MARKUP_PERCENT || 0);

// Fallback rates if every live source fails (update occasionally or set in Vercel).
const FALLBACK_PHP_PER_RMB = Number(process.env.FALLBACK_PHP_PER_RMB || 8.5);
const FALLBACK_USD_PER_RMB = Number(process.env.FALLBACK_USD_PER_RMB || 0.14);

const RATE_CACHE_MS = 10 * 60 * 1000; // 10 minutes
let rateCache = null;

const SOURCES = [
  {
    url: "https://api.frankfurter.app/latest?from=CNY&to=PHP,USD",
    parse: (d) => ({ php: d?.rates?.PHP, usd: d?.rates?.USD })
  },
  {
    url: "https://open.er-api.com/v6/latest/CNY",
    parse: (d) => ({ php: d?.rates?.PHP, usd: d?.rates?.USD })
  }
];

async function getRawRates() {
  if (rateCache && Date.now() - rateCache.fetchedAt < RATE_CACHE_MS) {
    return rateCache;
  }

  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) continue;

      const { php, usd } = source.parse(await response.json());

      if (Number.isFinite(php) && php > 0 && Number.isFinite(usd) && usd > 0) {
        rateCache = { php, usd, fetchedAt: Date.now(), live: true };
        return rateCache;
      }
    } catch (error) {
      console.error("Rate fetch error:", source.url, error?.message);
    }
  }

  // Prefer an older cached live rate over the hard-coded fallback.
  if (rateCache) return rateCache;

  console.warn("All rate sources failed; using fallback rate.");
  return {
    php: FALLBACK_PHP_PER_RMB,
    usd: FALLBACK_USD_PER_RMB,
    fetchedAt: Date.now(),
    live: false
  };
}

// Rates with markup applied, rounded to 4 decimals so the website
// and the server always compute exactly the same total.
export async function getPricingRates() {
  const raw = await getRawRates();
  const markup = 1 + MARKUP_PERCENT / 100;

  return {
    php_per_rmb: Number((raw.php * markup).toFixed(4)),
    usd_per_rmb: Number((raw.usd * markup).toFixed(4)),
    live: raw.live,
    updated_at: new Date(raw.fetchedAt).toISOString()
  };
}

export function calculatePrice(cash, rates) {
  const totalRMB = cash * RMB_PER_COIN;

  return {
    totalRMB,
    pricePHP: Number((totalRMB * rates.php_per_rmb).toFixed(2)),
    priceUSD: Number((totalRMB * rates.usd_per_rmb).toFixed(2))
  };
}
