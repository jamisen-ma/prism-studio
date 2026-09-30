// Independent test oracle: cube-vertex decomposition and BigInt nine-row sum.
// It intentionally imports no production normalizer, weights or arithmetic.
export const RANGE_NAMES = ['reds','yellows','greens','cyans','blues','magentas','whites','neutrals','blacks'];
const hueByBits = { 1:0, 2:2, 4:4, 3:1, 6:3, 5:5 };

export function referenceMembership(rgb) {
  const order = [0,1,2].sort((a,b) => rgb[b]-rgb[a]);
  const [high,middle,low] = order.map(i => rgb[i]);
  const out = Array(9).fill(0);
  out[hueByBits[1<<order[0]]] = high-middle;
  out[hueByBits[(1<<order[0])|(1<<order[1])]] = middle-low;
  const paired = Math.min(low,255-high);
  out[6]=low-paired; out[7]=2*paired; out[8]=255-high-paired;
  return out;
}

export function selectiveColorReference(rgb, parameters = {}) {
  const weights = referenceMembership(rgb).map(BigInt);
  const rows = RANGE_NAMES.map(name => (parameters[name] || [0,0,0,0]).map(value => BigInt(Math.round(value*100))));
  const relative = (parameters.method || 'relative') === 'relative';
  const denominator = relative ? 2550000n : 10000n;
  return rgb.map((byte,channel) => {
    let correction = 0n;
    for(let row=0;row<9;row++) correction += weights[row]*(rows[row][channel]+rows[row][3]);
    const original=BigInt(byte), numerator=original*denominator-correction*(relative ? 255n-original : 1n);
    if(numerator<=0n)return 0;
    if(numerator>=255n*denominator)return 255;
    return Number((2n*numerator+denominator)/(2n*denominator));
  });
}
