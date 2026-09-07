# Code review

Updated 2026-09-07. This review covers source organization and the local build. It is not a new live-playback certification.

## Changes

The userscript entry and timeline editor previously mixed event handling with large HTML and CSS literals. Those literals now live in separate controls/editor template and style modules. The entry still owns host integration; the editor still owns its state and interactions. No storage keys, playback algorithms or dependencies changed.

The extracted templates were compared against the previous packaged source map before rebuilding. Both rendered strings matched exactly, including styles. Application source already had no standalone comments to trim. License notices and vendor files were left intact.

## Structure

- `src/tempo-inline-source.js`: startup, SoundCloud hooks and component wiring.
- `src/tempo-editor.js`: timeline editing and playback coordination.
- `src/tempo-{controls,editor}-template.js`: markup.
- `src/tempo-{controls,editor}-style.js`: shadow-root styles.
- `src/audio/`: decoding, scheduling, transport and host-clock integration.
- `server/`: request handling, resolution, yt-dlp and static delivery.
- `scripts/`: esbuild packaging and dependency setup.

The entry and editor remain relatively large. Further splits should follow state ownership, not a line-count target. Moving their shared mutable state behind a large callback interface would add indirection without improving this release.

## Verification

The cleanup passed all 520 existing Node tests, TypeScript checking and the production website build. Logs are in `test-results/maintainability-checks.log` and `test-results/maintainability-build.log`. Browser results and the current installer identity are recorded in [the cleanup audit](MAINTAINABILITY.md).

## Open issues

- Extreme slowdown can produce unstable pitch in Preserve key mode.
- The earlier 65 ms wall-clock shortfall remains unexplained.
- Installed-manager identity, native-menu copying and broader browser/extension compatibility need verification.
- Public screenshots show an older build.
- The deferred website audio chunk exceeds the build warning threshold.

The earlier twelve-minute run belongs to the pre-cleanup artifact. It is not evidence that the rebuilt installer has completed that run.

## Earlier evidence

[The pre-cleanup review](history/CODE_REVIEW-before-structure-cleanup-2026-09-07.md) retains candidate hashes, scores, report paths and detailed acceptance notes. [Playback evidence](LOW_RATE_PLAYBACK.md) retains failed runs and measurement limits. [The original handoff](RELEASE_HANDOFF.md) describes the package delivered before this cleanup.
