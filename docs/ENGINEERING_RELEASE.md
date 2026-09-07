# Engineering release requirements

Recorded before the 2026-09-07 template cleanup. Candidate identities and results below describe that earlier snapshot; see [the current audit](MAINTAINABILITY.md) for the rebuilt local package. The full specification, earlier implementation notes and failed runs are retained in [history](history/ENGINEERING_RELEASE-2026-09-07.md).

The development candidate is `f6c45ac26e51ba0933dc4c1221edc70e45e5135a312e64b9b561d37ec3a749cd`. It is not the installed or public artifact. [Playback evidence](LOW_RATE_PLAYBACK.md) records their separate identities and report paths. [Release review](CODE_REVIEW.md) covers the wider rubric.

## 1. Clock drift and worklet timing

Requirements: measure real processor execution against the context's 128-frame budget; retain wall-time brackets around browser polling; distinguish source/context tracking from context/wall drift. Missing callback records or trace loss invalidate profiling. Prove at least ten minutes of real SoundCloud playback with continuous output evidence. Preserve failures and assertions, and do not infer a cause from a passing rerun or blame Natural rendering for a Preserve failure.

Evidence: the candidate passed twelve minutes of muted Preserve playback at 0.025×. All 36 clock checkpoints passed. Its 69,134,336 monitored frames contained no silent frames, nonfinite samples or frame-index gaps. Tracing from 540 seconds retained 405,101 full processor calls without trace loss. Individual calls peaked at 492 microseconds against a 1,333-microsecond budget.

Open: the earlier 65 ms wall-clock shortfall at 620 seconds has no established cause. Trace events lack processor identity and do not measure total graph work per quantum. Finite output does not establish artifact-free sound. Extreme-rate tone/chirp failures remain unresolved; the [library experiment](SIGNALSMITH_EXTREME_STRETCH.md) did not justify integrating a fork.

## 2. Standard build pipeline

Requirements: explicit module dependencies; esbuild IIFE output; generated userscript metadata; deterministic artifacts, tree-shaking and original-source maps. Bundle pinned WASM, decoder and worklet assets locally without marker replacement or AST comment stripping in production packaging. Preserve AudioWorklet execution: a Web Worker plugin is not an interchangeable loader.

Implemented: userscript and website audio entries build through esbuild. A worklet asset plugin compiles a separate module and source map. The decoder and original pinned WASM are bundled locally. Storage migration and dependency integrity have dedicated checks. Candidate builds are content-addressed and separate from public downloads.

Open: promote one accepted candidate consistently across installation, downloads, screenshots and the source archive. Public artifacts remain unchanged.

## 3. Explicit transport lifecycle

Requirements: add no new top-level state to `tempo-buffered.js` or `tempo-editor.js`. Model IDLE, BUFFERING, PLAYING, SEEKING and terminal DISPOSED explicitly. Retain play intent during seeks, cancel obsolete work and release resources without duplicating state or changing saved-data semantics.

Implemented: `transport-lifecycle.mjs` owns validated transitions. Existing transport and media-facade checks cover cancellation, pending resets and ownership. Current source passed 520 Node checks, type checking and 19 muted browser fixture suites.

Open: latest installed-build cold startup, persistence, queue/repeat, background and multi-tab acceptance. Fixtures do not replace those flows.

## 4. Graceful host degradation

Requirements: feature-probe private methods and descriptors; contain failures in owned hooks; restore native playback with a bounded diagnostic when integration becomes unsupported. Preserve native exceptions without retrying native operations. Do not modify another track or saved settings during recovery.

Evidence: injected host-method replacement recovered to progressing native 0.25× playback with finite nonzero output, speaker gain zero and one expected warning. This used predecessor `19c77afa`, not the current installed artifact. Current guards include ownership and play-intent checks.

Open: broader installed compatibility. One injected method replacement cannot establish compatibility with every future SoundCloud build or other audio extensions.

## 5. Public repository presentation

Requirements: lead the README with the actual architecture. Do not claim zero-copy lock-free buffers for a bounded copying cache, or a Bezier editor for cubic smoothstep. Include high-frame-rate live editor manipulation on SoundCloud. Retain Signalsmith MIT and Mediabunny MPL-2.0 attribution in `THIRD_PARTY_LICENSES.md`.

Implemented: architecture README and license index. Eleven current-candidate screenshots and a real live editor recording are staged locally.

Open: the recording is 25 fps, so the requested high-frame-rate presentation remains incomplete. Public media still identify the older artifact.

## Final acceptance

Installed sharing must cover native context-menu copying and separate-profile receipt, beyond the observed header Copy link and same-profile Apply once flow. Independent rubric review is required before awarding maximum scores. Physical touch, screen-reader output, Firefox and Linux remain unverified.

Publication, account changes and paid commitments remain out of scope. Host configuration, stable update URLs and PayPal require user-supplied deployment choices. Local tests are not hosted update verification.
