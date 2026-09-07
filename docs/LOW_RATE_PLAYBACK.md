# Low-rate playback

Updated 2026-09-07. Release acceptance remains incomplete.

## Current implementation

The userscript exposes 0.025–4×. Below 0.25×, supported AAC-LC streams use the buffered route rather than requesting an unsupported media-element speed. The website preview has a separate 0.25× floor.

Mediabunny demuxing and WebCodecs decoding feed a bounded PCM cache. Natural pitch schedules AudioBufferSourceNodes. Preserve key uses the pinned Signalsmith WASM through a project-owned AudioWorklet processor. The source build bundles the decoder and audio assets locally; playback does not fetch dependency code from a CDN.

Source/output mapping uses 128-frame windows and `rate × source sample rate / output sample rate`. Seeking cancels obsolete work, changes the playback generation and resets processor state. Graph ownership prevents simultaneous native and buffered playback. The SoundCloud host adapter checks private player methods and current media ownership; it cannot guarantee compatibility with future host changes.

The Preserve renderer limits owned PCM to 8 MiB. The Natural renderer limits owned AudioBuffers to 32 MiB and source/gain nodes to 16. These are component limits, not total browser-memory bounds. Decoder, cache and native allocations must be considered separately. Buffering does not retain the entire track.

## Artifact identity

| Artifact | SHA-256 | State |
| --- | --- | --- |
| Current development userscript | `f6c45ac26e51ba0933dc4c1221edc70e45e5135a312e64b9b561d37ec3a749cd` | Tested candidate, not accepted or installed |
| Associated installed candidate | `65f8eb16b7eaf9d52ed86757534260e843ba726631394546583e9f659df5f003` | User-confirmed reinstall; installed byte hash unverified |
| Public local download | `789a8430f052ed86b1bc3c096a19f3cb5c98b653e8a3aae66fe42849d68355cb` | Not replaced by the candidate |

The current candidate is 906,050 bytes. Its development changes include boundary-only history clearing and consistent manual-speed accessibility status. Experimental library forks are isolated under ignored `test-results/` and are not part of these artifacts.

## Current evidence

Reports below are local files under `test-results/`, not files included in the public repository.

| Check | Result | Scope |
| --- | --- | --- |
| Twelve-minute Preserve playback | `playback-baseline-20260907T141125381323Z-49c1bcbd.json`: current candidate passed 720 seconds at 0.025×. All 36 clock checkpoints passed. | Real SoundCloud stream in an isolated muted browser, not installed-manager acceptance or a listening assessment. |
| Continuous output | The same run monitored 69,134,336 frames at 96 kHz: no silent frames, nonfinite samples or frame-index gaps. | Does not detect every audible artifact. |
| Native callback timing | Traced from 540.025 seconds: 405,101 full processor calls, p99 211 µs, maximum 492 µs, no individual call above the 1,333 µs quantum budget, no trace loss. | Includes diagnostic processors; events lack processor identity and do not measure total graph work per quantum. |
| Host recovery | `playback-baseline-20260907T120343298430Z-a815ae7c.json`: injected host-method replacement recovered to progressing native playback with one expected warning. | Earlier `19c77afa` candidate and one injected fault. |
| Source regressions | `regression-20260907-default-test-discovery.xml`: 520 Node checks passed, no skips. Current candidate also passed all 19 muted browser fixture suites and type checking. | Unit and fixture results do not clear musical-quality or installed-browser gates. |
| Installed controls | `installed-edge-20260907-track-identity.md`: header sharing, same-profile receipt, seeks, mode switches and track changes worked through actual controls. All 14 saved tracks remained. | Installed hash and seamless audio quality remain unverified. |

The twelve-minute run ended with audio context and browser closed. Its isolated browser process tree averaged 38.714% of one CPU core, or 1.210% across 32 logical processors. This is not per-library CPU, a negligible-overhead claim or a controlled speedup comparison.

## Unresolved findings

1. An earlier run fell behind wall time by about 65 ms at 620 seconds. The current pass covers that interval but does not explain the old result. Source-position accuracy against AudioContext time is a different measurement.
2. Extreme-rate tone/chirp checks have intermittent failures. The pinned library intentionally randomizes phase prediction beyond its clean-stretch range. Direct WASM and native C++ controls demonstrate output variation independently of browser scheduling, but not the cause of every failure.
3. A diagnostic threshold fork removed seed-dependent native variation but passed only 14/15 browser cases. The matched upstream rebuild passed 15/15 in one run. That does not justify integrating the fork or declaring the original issue fixed. See the [controlled investigation](SIGNALSMITH_EXTREME_STRETCH.md).
4. Final installed-build lifecycle checks, separate-profile sharing, native context-menu copying and listening-quality review remain open. Do not relabel fixture results as those checks.

The original assertions and failed reports remain intact. No passing rerun replaces an earlier failure's explanation.

## Reproduction and history

[Testing](TESTING.md) covers candidate overrides, muted diagnostics and required fixtures. [Engineering requirements](ENGINEERING_RELEASE.md) defines the requested release gates. [Release review](CODE_REVIEW.md) tracks the wider project.

The [archived investigation](history/LOW_RATE_PLAYBACK-2026-09-07.md) retains earlier candidate-specific results, rejected approaches and failures. Its statements are historical, including earlier dependency-loading behavior.
