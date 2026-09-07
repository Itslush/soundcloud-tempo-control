# Source organization audit

2026-09-07. Local changes only; no GitHub repository or Oracle service was changed.

## Scope

Reviewed the repository layout, build and setup entry points, server boundaries, userscript entry/editor, website script organization and active release documentation. This was a maintainability pass, not a line-by-line correctness or security audit of every audio module.

## Changes

- Separated controls and editor markup from their event handlers.
- Moved their shadow-root styles into dedicated modules. Styles remain bundled locally, with no added requests or dependencies.
- Reduced the entry file from about 71 kB to 52 kB and the editor from 50 kB to 38 kB.
- Replaced the active score-heavy review with a short structural review. The full previous review remains in `docs/history/`.
- Clarified which release evidence belongs to the previous installer and which checks cover the rebuilt one.

Application source had no standalone comments to remove. Vendor notices, licenses, failed measurements and historical records were preserved. The generated single-file installer remains intentional; userscript managers consume that file, while development uses modules.

## Verification

- Compared both extracted template outputs with the previous packaged source map: exact matches, including styles.
- All 520 existing Node tests passed; none skipped.
- TypeScript and the production Astro build passed.
- Transfer budgets and conditional HTTP requests passed.
- Eighteen of nineteen muted browser suites passed. The audio-boundary suite failed; the other ten suites were run separately after the runner stopped at that failure.

Logs: `test-results/maintainability-checks.log`, `maintainability-build.log`, `maintainability-browser.log` and `maintainability-browser-remaining.log`.

Rebuilt installer SHA-256: `7fa3e1dfe9d4610f719fdf7825e4edae1ba6b5ff86eb8b2ef84415dc9f8667a2` (906,348 bytes). All three local installer/download copies match. The source archive is refreshed from the working files. The earlier twelve-minute live playback result belongs to `f6c45ac2`, not this rebuild.

## Remaining findings

The boundary verifier rejected the 48 kHz, 0.5× replacement capture because consecutive render timestamps were not consistently 128 frames apart. Its report is retained at `test-results/maintainability-wasm-boundaries.json`. This run does not establish whether the discontinuity came from capture, scheduling or playback. Audio behavior was not changed to make the test pass.

The entry still coordinates several SoundCloud hooks and the editor retains shared interaction state. A later refactor could separate those responsibilities, but should include lifecycle coverage rather than merely moving blocks behind callbacks. The deferred audio bundle remains above Astro's 500 kB warning threshold.

Extreme-rate pitch behavior, the historical clock shortfall and installed-manager verification remain open as described in [the playback report](LOW_RATE_PLAYBACK.md). No claim of human-only authorship is made by this cleanup.
