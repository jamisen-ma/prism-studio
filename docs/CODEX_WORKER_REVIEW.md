# Independent local Codex worker review

Status: reviewed and cleared on 2026-09-19. The final focused independent run passed **16/16 in 1.156 seconds**: ten controller/manager audits, five runner audits, and one actual TypeScript UI helper audit. All test processes exited. These tests used injected generators, mock CLI receipts, and a real Node dummy child for termination checks; they did not invoke Codex, a model, or the image API. Root separately reported a successful live production-adapter workflow and the UI owner reported six automatic-worker browser workflows plus ten manual/API workflows passing.

The reviewed implementation keeps generation ownership separate from image installation. Newly submitted automatic jobs are durably `automation.queued` before the response. Manual handoff/completion refuses queued, generating, and returning jobs. Previously saved unmarked jobs remain manual and are never adopted. A generating attempt UUID is saved before the adapter runs. Restart turns an uncertain generating attempt into interrupted state rather than calling the model again. Returning state pins the exact generated PNG hash and can recover those same bytes without generation, even when the local runner is unavailable.

Findings corrected during review:

- Returning output is immutable. Re-recording the same bytes is idempotent; different bytes refuse. Completion checks the pinned returning hash, and recovery uses a bounded, no-follow, same-file-descriptor read with SHA verification.
- Saved input and protection-mask reads now use the same bounded, verified asset reader. Changed valid PNGs, symlinks, and oversized files stop before the adapter is called. Existing-asset deduplication verifies the stored file too.
- Worker shutdown aborts the separate native application controller. It also rechecks cancellation after the awaited returning-output read and before starting completion. Tests hold both boundaries and show no project installation after shutdown, with the accepted output retained.

The controller audits also cover simultaneous ticks, public/manual claim races, failed claim persistence before generation, uncertain restart, cancellation followed by late adapter output, invalid PNG/JPEG/truncation, sanitized adapter errors, and exact stale-result behavior. A stale selection edit retains the generated image for explicit revision-pinned application; the original captured hard mask and current protected region remain authoritative, and one Undo restores the prior pixels. Credential/API callbacks are asserted unused throughout.

The runner accepts only the fresh UUID-thread artifact directory under the configured Codex home, not paths printed by the model. Tests cover file and directory freshness, multiple PNGs, symlinks, malformed and truncated images, the 30 MiB file bound, dimension refusal, duplicate/failed/malformed execution receipts, and bounded output logs. ChatGPT login reported on stderr is recognized. The child environment drops the implemented credential suffixes, generation forces ChatGPT authentication, and commands use argument arrays with shell execution disabled. Cancellation and timeout terminate an actual injected Node child and wait for its exit.

The UI helper audit loads `client/generation.ts` through Vite. Every automatic state suppresses manual-copy handoff, including unavailable, interrupted, and failed states. Legacy unmarked jobs remain manual even when the worker is enabled. Source review confirms jobs and worker status refresh together and stopped attempts require explicit user action rather than silent retry.

Run the independent checks with:

```sh
node --test tests/codex-image-worker-audit.test.mjs tests/codex-image-runner-audit.test.mjs tests/codex-worker-client-audit.test.mjs
```

This evidence covers the declared local lifecycle and file boundaries. The model itself is still instructed to invoke image generation once; the controller enforces one adapter invocation per durably claimed attempt and no automatic re-generation after an uncertain attempt. No claim is made that an external model follows every instruction internally. Generated-image storage inside Codex remains separate from the companion's bounded durable job asset store.
