"""Maintained, dependency-free certification of the native noise quantile table.

NormalDist supplies only candidate integers. Directed Decimal intervals for the
normal CDF independently certify every nearest-integer decision. Pi is enclosed
using Machin's formula and alternating arctangent series, not a copied constant.
Runtime never invokes Python. Run --verify to certify and compare without
writing; --write regenerates the maintained fixture and runtime base64 literal.
"""
from decimal import Decimal as D, Context, ROUND_FLOOR, ROUND_CEILING
from statistics import NormalDist
from pathlib import Path
import hashlib
import json
import math
import struct
import argparse
import base64
import re

DOWN = Context(prec=80, rounding=ROUND_FLOOR)
UP = Context(prec=80, rounding=ROUND_CEILING)
ZERO, ONE, HALF = D(0), D(1), D('.5')
ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'tests' / 'fixtures' / 'noise'
RUNTIME = ROOT / 'server' / 'noise-table.mjs'
EXPECTED_SHA = '317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3'


def atan_inverse_bounds(q, terms=160):
    lo = hi = ZERO
    q = D(q)
    power_lo, power_hi = DOWN.divide(ONE, q), UP.divide(ONE, q)
    square = q*q
    for n in range(terms):
        a, b = DOWN.divide(power_lo, D(2*n+1)), UP.divide(power_hi, D(2*n+1))
        if n % 2:
            lo, hi = DOWN.subtract(lo, b), UP.subtract(hi, a)
        else:
            lo, hi = DOWN.add(lo, a), UP.add(hi, b)
        power_lo, power_hi = DOWN.divide(power_lo, square), UP.divide(power_hi, square)
    tail = UP.divide(power_hi, D(2*terms+1))
    return DOWN.subtract(lo, tail), UP.add(hi, tail)


a, b = atan_inverse_bounds(5)
c, d = atan_inverse_bounds(239)
PI_LO = DOWN.subtract(DOWN.multiply(D(16), a), UP.multiply(D(4), d))
PI_HI = UP.subtract(UP.multiply(D(16), b), DOWN.multiply(D(4), c))
# Decimal.sqrt is correctly rounded. One adjacent Decimal on each side safely
# encloses its result, even though sqrt itself does not use directed rounding.
ROOT_LO = DOWN.next_minus(DOWN.sqrt(DOWN.multiply(D(2), PI_LO)))
ROOT_HI = UP.next_plus(UP.sqrt(UP.multiply(D(2), PI_HI)))
NORM_LO, NORM_HI = DOWN.divide(ONE, ROOT_HI), UP.divide(ONE, ROOT_LO)


def cdf_bounds(x, terms=128):
    assert ZERO <= x < D(5)
    x2_lo, x2_hi = DOWN.multiply(x, x), UP.multiply(x, x)
    term_lo = term_hi = x
    lo = hi = ZERO
    # Integral exp(-t²/2): term_n=x^(2n+1)/(2^n*n!*(2n+1)).
    for n in range(terms):
        if n % 2:
            lo, hi = DOWN.subtract(lo, term_hi), UP.subtract(hi, term_lo)
        else:
            lo, hi = DOWN.add(lo, term_lo), UP.add(hi, term_hi)
        divisor = D(2*(n+1)*(2*n+3))
        term_lo = DOWN.divide(DOWN.multiply(DOWN.multiply(term_lo, x2_lo), D(2*n+1)), divisor)
        term_hi = UP.divide(UP.multiply(UP.multiply(term_hi, x2_hi), D(2*n+1)), divisor)
    # From this index onward the terms decrease for x<5. Alternating remainder
    # is bounded by the next absolute term; widened symmetrically for clarity.
    lo, hi = DOWN.subtract(lo, term_hi), UP.add(hi, term_hi)
    return DOWN.add(HALF, DOWN.multiply(lo, NORM_LO)), UP.add(HALF, UP.multiply(hi, NORM_HI))


def certify(bins=4096, scale=8192):
    entries, margins, widths = [], [], []
    for j in range(bins//2):
        p = HALF + D(2*j+1)/D(2*bins)  # exact dyadic probability
        q = math.floor(NormalDist().inv_cdf(float(p))*scale + .5)
        x_lo, x_hi = (D(q)-HALF)/D(scale), (D(q)+HALF)/D(scale)
        c_lo, c_hi = cdf_bounds(x_lo), cdf_bounds(x_hi)
        assert c_lo[1] < p < c_hi[0], (j, q, p, c_lo, c_hi)
        margin = min(DOWN.subtract(p, c_lo[1]), DOWN.subtract(c_hi[0], p))
        margins.append(margin)
        widths.extend([UP.subtract(*reversed(c_lo)), UP.subtract(*reversed(c_hi))])
        entries.append(q)
    assert entries == sorted(entries) and min(entries) > 0 and max(entries) <= 32767
    raw = struct.pack('<'+'h'*len(entries), *entries)
    margin = min(margins)
    # Normal density is everywhere <0.4, so a probability gap g implies a
    # quantile separation >g/0.4. Scale this to integer table units.
    min_scaled_distance = DOWN.divide(DOWN.multiply(margin, D(scale)), D('.4'))
    variance = sum(q*q for q in entries)/(len(entries)*scale*scale)
    fourth = sum(q**4 for q in entries)/(len(entries)*scale**4)
    comparison = []
    for size, qscale in [(4096,8192), (65536,4096)]:
        qs = [math.floor(NormalDist().inv_cdf(.5+(2*j+1)/(2*size))*qscale+.5) for j in range(size//2)]
        comparison.append({'bins':size,'scale':qscale,'positiveHalfBytes':len(qs)*2,'maxAbsolute':max(qs)/qscale,'variance':sum(q*q for q in qs)/(len(qs)*qscale*qscale),'note':'4096 table interval-certified; 65536 comparison uses float proposals only'})
    return raw, {'status':'All 2048 positive midpoint quantile integers certified by outward Decimal CDF intervals',
      'bins':bins,'scale':scale,'positiveHalfBytes':len(raw),'sha256LittleEndianInt16Positive':hashlib.sha256(raw).hexdigest(),
      'firstValues':entries[:8],'lastValues':entries[-8:],'minCdfBoundaryMarginLowerBound':str(margin),
      'minScaledQuantileHalfBoundaryDistanceLowerBound':str(min_scaled_distance),'maxCdfIntervalWidth':str(max(widths)),
      'piInterval':[str(PI_LO),str(PI_HI)],'normalizationInterval':[str(NORM_LO),str(NORM_HI)],
      'meanExact':0,'variance':variance,'fourthMoment':fourth,'excessKurtosis':fourth/variance**2-3,
      'maxAbsolute':max(entries)/scale,'sizeComparison':comparison}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--verify', action='store_true', help='Certify and verify all maintained bytes without writing (default).')
    mode.add_argument('--write', action='store_true', help='Regenerate the certified fixture and existing runtime base64 literal.')
    args = parser.parse_args()
    raw, report = certify()
    assert hashlib.sha256(raw).hexdigest() == EXPECTED_SHA, 'Certified bytes differ from the native policy hash'
    runtime = RUNTIME.read_text()
    matches = re.findall(r"^const encoded = '([A-Za-z0-9+/=]+)';$", runtime, re.MULTILINE)
    assert len(matches) == 1 and EXPECTED_SHA in runtime, 'Runtime table declaration/hash missing or ambiguous'
    if args.write:
        FIXTURE.mkdir(parents=True, exist_ok=True)
        (FIXTURE/'gaussian-positive-q8192.bin').write_bytes(raw)
        (FIXTURE/'table-report.json').write_text(json.dumps(report, indent=2)+'\n')
        RUNTIME.write_text(runtime.replace(matches[0], base64.b64encode(raw).decode('ascii')))
    else:
        assert (FIXTURE/'gaussian-positive-q8192.bin').read_bytes() == raw, 'Maintained fixture differs from certified bytes'
        assert json.loads((FIXTURE/'table-report.json').read_text()) == report, 'Maintained certificate differs'
        assert base64.b64decode(matches[0], validate=True) == raw, 'Runtime literal differs from certified bytes'
    print(f'Certified 2048 positive entries; fixture/runtime SHA-256 {EXPECTED_SHA}; {"written" if args.write else "verified without writes"}.')
