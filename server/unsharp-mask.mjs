export const UNSHARP_MASK_POLICY = 'rgb-residual-threshold-v1';
export const UNSHARP_ROUNDING_GUARD = 64 * Number.EPSILON * 1530;
const FIELDS = new Set(['amount', 'sigma', 'threshold']);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); };
const amountValue = amount => {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 500 || Math.round(amount * 100) / 100 !== amount)
    fail('Unsharp Mask amount must be between 0 and 500 percent in increments of 0.01 percent.');
  return amount;
};

/** Source-only complete parameters. Global adjustment normalization remains
 * independent; every setting is validated even on a computational identity. */
export function normalizeUnsharpParameters(parameters) {
  if (parameters === undefined) parameters = {};
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) || !Object.keys(parameters).every(key => FIELDS.has(key)))
    fail('Unsharp Mask parameters accept only amount, sigma and threshold.');
  const amount = amountValue(parameters.amount === undefined ? 100 : parameters.amount);
  const sigma = parameters.sigma === undefined ? 1 : parameters.sigma;
  const threshold = parameters.threshold === undefined ? 0 : parameters.threshold;
  if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma < 0 || sigma > 50) fail('Unsharp Mask Gaussian sigma must be between 0 and 50 source pixels.');
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) fail('Unsharp Mask threshold must be an integer between 0 and 255.');
  return { amount, sigma, threshold };
}

export function compileUnsharpAmount(amount) {
  const units = Math.round(amountValue(amount) * 100);
  let divisor = units, remainder = 10000;
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  const p = units / divisor, q = 10000 / divisor;
  return { units, p, q, exact: q <= 16 && p + q <= 32, factor: units / 10000 };
}

/** N,D and C*D are exact Gaussian integers, D<=255*65536^2. Threshold is
 * strict against the unrounded per-channel residual. Scalar temporaries only.
 * See UNSHARP_MASK_DESIGN.md for the integer and IEEE rounding bounds. */
export function unsharpChannelByte(current, numerator, denominator, amount, threshold) {
  const residual = current * denominator - numerator;
  if (Math.abs(residual) <= threshold * denominator) return current;
  if (amount.exact) {
    const divisor = amount.q * denominator, value = current * divisor + amount.p * residual;
    // q<=16,p+q<=32 keep every signed product/sum exact below2^53.
    // After clamp, division is >2 rounding errors from a floor boundary.
    return value <= 0 ? 0 : value >= 255 * divisor ? 255 : Math.floor((2 * value + divisor) / (2 * divisor));
  }
  const estimate = current + amount.factor * (residual / denominator);
  if (estimate <= 0) return 0;
  if (estimate >= 255) return 255;
  const lower = Math.floor(estimate);
  // The residual-first estimate has absolute error<4.2e-13. This guard is
  // >50 times that bound and only requests exact recomputation, never bias.
  if (Math.abs(estimate - lower - 0.5) > UNSHARP_ROUNDING_GUARD) return Math.round(estimate);
  const divisor = 10000n * BigInt(denominator);
  const value = BigInt(current) * divisor + BigInt(amount.units) * BigInt(residual);
  return value <= 0n ? 0 : value >= 255n * divisor ? 255 : Number((2n * value + divisor) / (2n * divisor));
}
