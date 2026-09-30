# Independent Distort reference

`exact-reference.mjs` constructs integer homogeneous matrices from the exact
dyadic authored corners and computes inverse sampling with BigInt fractions.
It does not import production geometry or sampling helpers. The integer-copy
path is independently implemented and preserves all RGBA bytes.

This reference is a mathematical oracle for selected stable fixtures. The
runtime contract explicitly uses bounded binary64 projective arithmetic, so
arbitrary exact-real half ties need not match this reference. General
sampling is alpha weighted with transparent outside taps.

Originally developed during the independent design review in
`test-results/perspective-review/`; maintained here so regression tests do not
depend on ignored experimental artifacts.
