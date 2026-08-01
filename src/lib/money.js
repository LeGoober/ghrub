/**
 * Money helpers. HARD RULE: money is stored as integer cents (ZAR × 100),
 * never as floats. These two functions are the only boundary between the
 * user-facing "Rands" inputs/outputs and the integer-cents storage.
 */

/** Parse a user-entered Rand string/number (e.g. "12.50", 12.5) into integer cents. */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Format integer cents as a Rand amount, e.g. 123456 -> "R1 234.56". */
export function formatCents(cents) {
  if (cents === null || cents === undefined) return '—';
  const rands = cents / 100;
  const [whole, frac] = rands.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `R${grouped}.${frac}`;
}
