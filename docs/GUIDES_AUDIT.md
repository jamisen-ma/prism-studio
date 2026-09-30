# Independent guide audit

Four tests in `tests/guides-audit.test.mjs` and the root-owned official MCP workflow pass. This is backend verification; ruler rendering and Move snapping have separate UI acceptance. No native correctness defect was found.

The guide-only fixture installs guards against rendering, source-image reads, alpha reads and asset writes during add/update/delete. These edits complete using metadata alone. Before/after reads compare exact composite PNG, isolated layer/source/raw-alpha previews, histogram, sampled colors, PNG/JPEG/WebP/TIFF exports, layered PSD bytes and generation snapshot/mask PNGs. They are identical. Layer graphs, active/saved selections and every existing asset byte remain unchanged. Revision/history advance normally and the old composite cache is invalidated after successful publication.

An independent coordinate fixture checks all nine canvas anchors with both positive and negative odd deltas. In particular, a center shrink of three pixels uses offset -2, while expansion by three uses +1. Crop drops only outside records, retaining inclusive edge guides. Asymmetric resize preserves separate guide IDs and order even when positions coincide. Undo and reopening retain the exact lists.

Invalid axes/coordinates, an attempted axis change, unknown command fields, stale revisions, missing IDs and a transaction containing an invalid guide leave the published document unchanged. An actual filesystem `ENOTDIR` failure during persistence also leaves guide identities, project bytes, history/revision and the previous warm cache exact. Six independently constructed canonical `.prism` manifests test malformed, duplicate, out-of-range and over-cap guide collections; they reject before image validation or asset/project publication.

Source review confirms crop/resize/canvas transformations use the old document dimensions and visit the guide list once. Other layer mutations and renderer paths do not consume the guide list. The bundle root allowlist and semantic validator include guides. Public command schemas reject unknown fields, require integer coordinates and rely on native validation for orientation-specific dimensions.

Root confirmed the canonical capability is `guideCoordinates:'document-pixels'`; inclusive integer boundary semantics are described in the command contract rather than a separate units field. The design originally used a different capability value, which was reported to its owner. Root also updated the PSD warning to state that guides and saved style presets are not embedded. Neither documentation adjustment changes image pixels.

See [guide design](GUIDES_DESIGN.md) for the approved 64-guide limit, editable metadata behavior and the separate browser snapping/ruler requirements. The audit used synthetic images and a stubbed segmentation result; it read no credentials and made no provider calls.
