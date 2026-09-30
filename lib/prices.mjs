// Hand-maintained price table. USD per million tokens.
// SOURCE: https://platform.claude.com/docs/en/about-claude/pricing  (+ models/overview for ids)
// FETCHED: 2026-09-30.  Re-check against the docs whenever a new model ships.
//
// Keys are model-id prefixes (dash-separated, date stamp and [1m] suffix stripped).
// Lookup uses the LONGEST matching prefix on a '-' boundary, so
//   claude-opus-5-5  -> "claude-opus-5-5"   (not "claude-opus-5")
//   claude-opus-4-8-20260528 -> "claude-opus-4-8"
// Columns: in, out, cr (cache read), w5 (5m write), w1 (1h write).
// Cache read is NOT always 0.1x: Fable/Mythos 5.1 = 0.025x, Opus 5.5 = 0.05x.
//
// Ids marked (assumed) are not shown on the docs pages I fetched (the models overview
// lists only current ids); they follow the observed naming scheme. A wrong guess
// degrades to "unpriced", never to $0.

export const PRICES_FETCHED = '2026-09-30';
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

const row = (inp, out, cr, w5, w1) => ({ in: inp, out, cr, w5, w1 });

export const PRICES = {
  'claude-fable-5-1':  row(10, 50, 0.25, 12.5, 20),
  'claude-mythos-5-1': row(10, 50, 0.25, 12.5, 20),   // (assumed id) limited availability
  'claude-fable-5':    row(10, 50, 1, 12.5, 20),
  'claude-mythos-5':   row(10, 50, 1, 12.5, 20),      // (assumed id) limited availability
  'claude-opus-5-5':   row(4, 20, 0.2, 5, 8),
  'claude-opus-5':     row(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-8':   row(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-7':   row(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-6':   row(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-5':   row(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-1':   row(15, 75, 1.5, 18.75, 30),
  'claude-opus-4':     row(15, 75, 1.5, 18.75, 30),
  'claude-sonnet-5-5': row(2, 10, 0.2, 2.5, 4),
  'claude-sonnet-5':   row(2, 10, 0.2, 2.5, 4),       // $2/$10 is now standard (docs footnote 3)
  'claude-sonnet-4-6': row(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4-5': row(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4':   row(3, 15, 0.3, 3.75, 6),
  'claude-haiku-4-5':  row(1, 5, 0.1, 1.25, 2),
  'claude-3-5-haiku':  row(0.8, 4, 0.08, 1, 1.6),     // "Haiku 3.5" (assumed id)
};

/** Strip [1m]-style suffix and a trailing -YYYYMMDD stamp. */
export function normalizeModelId(id) {
  if (typeof id !== 'string') return '';
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
}

/** Longest-prefix match on a '-' boundary. Returns { key, price } or null. */
export function lookupPrice(modelId, table = PRICES) {
  const id = normalizeModelId(modelId);
  if (!id) return null;
  let best = null;
  for (const key of Object.keys(table)) {
    if (id === key || id.startsWith(key + '-')) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best ? { key: best, price: table[best] } : null;
}

/**
 * Cost in USD of a usage delta. `u` = {input, output, cacheRead, cacheWrite5m, cacheWrite1h}.
 * Returns { usd, priced }. Unknown model => { usd: 0, priced: false } (caller must surface it).
 */
export function costOf(modelId, u, table = PRICES) {
  const hit = lookupPrice(modelId, table);
  if (!hit) return { usd: 0, priced: false };
  const p = hit.price;
  const usd = (u.input * p.in + u.output * p.out + u.cacheRead * p.cr
    + u.cacheWrite5m * p.w5 + u.cacheWrite1h * p.w1) / 1e6;
  return { usd, priced: true };
}
