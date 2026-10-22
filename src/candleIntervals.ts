/**
 * Candle interval lengths in seconds.
 *
 * Single source of truth shared by `src/routes/candles.ts` (request
 * validation) and `src/middleware/cachePolicy.ts` (closed-window detection).
 * Kept in its own module so the cache policy can import it without dragging
 * in the route's DB dependencies.
 */
export const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}
