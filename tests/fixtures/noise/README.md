# Deterministic Add Noise fixtures

`final-map-goldens.json` freezes the independent reviewer’s final-map vectors from `test-results/noise-review/owner-comparison.json`. The oracle uses BigInt modular arithmetic, exact rational byte rounding and the independently interval-certified Gaussian table, not the production noise module. It covers Uniform/Gaussian, shared/separate RGB samples and uint32 seeds 0, 1 and 4294967295 on alpha 0/1/128/255 pixels. The refined counter multiplier is `0x9e3779b9`.

See [the native review](../../../docs/NOISE_FILTER_REVIEW.md) for table proof and statistical evidence. Photographic browser evidence reuses the unchanged [NASA astronaut fixture](../tonal-color/README.md).

## Certified Gaussian table

`gaussian-positive-q8192.bin` stores 2048 positive midpoint-normal quantiles as signed 16-bit little-endian integers, scaled by 8192. Their probabilities are `0.5 + (2*j+1)/8192`, for `j=0..2047`; exact antisymmetry supplies the negative half of the 4096-bin distribution. The 4096 bytes have SHA-256:

`317cfb8ef5c5cb825f7f0530359f16c72bb981d69be1c4e7e0119d728ba15ea3`

`table-report.json` records the independent interval certificate and distribution moments. The maintained [certifier](../../../scripts/certify-noise-table.py) uses Python's standard library only. `NormalDist` proposes each integer; an independently bounded Machin pi calculation and outward 80-digit Decimal normal-CDF intervals certify both half-integer rounding boundaries. Runtime does not invoke Python or regenerate quantiles.

From the repository root, verify all coefficients, the certificate, the pinned hash and the runtime base64 literal without writing:

```sh
python3 scripts/certify-noise-table.py --verify
```

Regenerate the same certified fixture, report and existing runtime literal with `python3 scripts/certify-noise-table.py --write`. This command still requires the pinned policy hash; changing the distribution requires an explicit policy decision, not silent regeneration. The runtime keeps one private, lazily initialized 4096-byte backing allocation and exposes no mutable table view.
