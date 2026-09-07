# Release code review

Updated 2026-09-07. Scope: userscript, audio, storage, editor, sharing, updates, website, resolver and build tooling.

## Verdict

Release acceptance is incomplete. The earlier independent assessment remains **35/40 usability + 19/20 technical = 54/60**. It predates the latest source changes and is not a current release certification.

The current development candidate is `f6c45ac26e51ba0933dc4c1221edc70e45e5135a312e64b9b561d37ec3a749cd` (906,050 bytes). It adds boundary-only history clearing and consistent manual-speed accessibility status. Its muted UX suite passes the step-button, slider Home and double-click reset sequence without stale status text. The preceding `e3269e7a` passed 520 Node checks but failed the real-WASM chirp check; the worklet is unchanged between those candidates. Neither candidate is accepted or installed. The installed candidate remains associated with `65f8eb16b7eaf9d52ed86757534260e843ba726631394546583e9f659df5f003` (905,923 bytes), with its installed hash unverified. The public download remains `789a8430f052ed86b1bc3c096a19f3cb5c98b653e8a3aae66fe42849d68355cb` (480,040 bytes).

The full preceding review is retained in [review history](history/CODE_REVIEW-2026-09-07.md). Its pending-run statements and candidate-specific judgments are historical. [Engineering requirements](ENGINEERING_RELEASE.md) and [playback evidence](LOW_RATE_PLAYBACK.md) retain the detailed reports and failures.

## Verified evidence

| Area | Evidence | Limit |
| --- | --- | --- |
| Build | Explicit ESM entry, pinned esbuild IIFE, generated metadata, local WASM/worklet/decoder assets and source maps. Candidate rebuilding reproduced its hash. | Public artifacts have not been promoted. |
| Source regressions | Current source passed 520 Node checks with no failures or skips in `regression-20260907-default-test-discovery.xml`. Candidate `f6c45ac2` also passed TypeScript checking and all 19 muted browser fixture suites. | These results do not clear extreme-rate pitch failures or installed-manager acceptance. |
| Sustained audio | Current candidate `f6c45ac2` passed 720 seconds of real Preserve playback at 0.025×, with 69,134,336 monitored frames, no silent or nonfinite frames, no frame gaps and all 36 clock checkpoints passing. | Does not explain the earlier 620-second clock failure or detect every audible artifact. |
| Native recovery | An injected host-method replacement recovered to native 0.25× with progressing, finite, nonzero output and one expected diagnostic. | Covers that fault, not every future SoundCloud change. |
| Profiling | Current candidate `f6c45ac2`, traced from 540 seconds through the end of its twelve-minute run: 405,101 full processor calls, p99 211 µs, maximum 492 µs, zero over the 1,333 µs quantum budget, no trace loss. | Calls have no processor identity. Individual calls do not measure total graph work per quantum. |
| Userscript UI | All 19 muted fixture suites passed on `65f8eb16`. Fresh boundary, embedded-track and duration reports use the corrected candidate provenance. Compact rows, slider geometry and forced colours passed. | Fixture coverage is not installed-manager acceptance. Older mislabeled reports remain excluded. |
| Website | The isolated Astro preview passed demo, presentation, recovery, interface, navigation and lifecycle checks. Ten actual cached Back/Forward returns passed. | Generated sample and fault fixtures do not establish every remote stream or browser. |
| Remote preview | The current website engine loaded the full 496.503-second default Drown track through yt-dlp. Muted 0.75× Natural and WASM playback produced sampled output; a 30-second seek and pause passed. | One real HLS stream, not a listening-quality or long-session result. |
| Transfer | Initial Brotli assets: 126,788 bytes; 254,412 including all preview crops. Conditional requests passed. | Deferred playback/audio are excluded. A deferred chunk still exceeds 500 kB. |
| Installed Edge | Header Copy link returned fresh canonical metadata at 1× and 1.025×, with Natural and Preserve key verified. Opening the preserve link selected the correct values; Apply once activated a session timeline. All 14 saved tracks remained after stopping it. | Same-profile recipient UI, paused and muted. Native menu selection, audible pitch and installed source hash are not established by this check. |

Reports for the latest scoped checks:

- Current twelve-minute playback and native trace: `test-results/playback-baseline-20260907T141125381323Z-49c1bcbd.json`. Candidate SHA-256 matches `f6c45ac2`; playback advanced 18.000967 source seconds. The isolated browser process tree averaged 38.714% of one core, or 1.210% across 32 logical processors. This is not per-library CPU or a controlled speedup comparison. Audio context and browser closed; speaker gain remained zero.

- Candidate `f6c45ac2`: all 19 muted browser fixture suites passed on 2026-09-07, including the stale-status regression. All 520 Node tests passed with no skips in `test-results/regression-20260907-f6c45ac2.xml`; `tsc --noEmit` passed. These results do not clear the separate extreme-rate chirp failure or replace installed-manager verification.
- Eleven real SoundCloud captures of `f6c45ac2` are staged in `test-results/showcase-20260907T140327841571Z/`, with exact artifact and image hashes in `capture.json`. The full editor and narrow saved-track crop were visually inspected. A second capture in `test-results/showcase-20260907T140601265780Z/` includes a real point drag and save during muted playback, progressing from 0.062061 to 2.484261 seconds. Its unedited video is 1440×1080, 25 fps and 39.2 seconds, verified with ffprobe. It is not the requested high-frame-rate finished presentation. Public media remain unchanged.
- Optional render-frame-indexed PCM capture now survives a failed Preserve diagnostic. `test-results/preserve-output-20260907T140911353174Z.json` retains the original failed 68.277 Hz/s chirp result. Its companion pitch analysis shows both zero-crossing and spectral variation in actual worklet output without analyser snapshot timing. This narrows the measurement question but does not establish a fix or clear acceptance.

- Continuous playback: `test-results/playback-baseline-20260907T121645089847Z-774c4cf1.json`.
- Native recovery: `test-results/playback-baseline-20260907T120343298430Z-a815ae7c.json`.
- Full processor trace: `test-results/playback-baseline-20260907T130809546625Z-a86b7179.json`.
- Node regressions: `test-results/regression-20260907-19c77afa.xml`.
- Corrected candidate fixtures: `wasm-boundaries-65f8eb16.json`, `embedded-track-65f8eb16.json`, `display-duration-65f8eb16.json` in `test-results/`.
- Installed observations: `test-results/installed-edge-20260907-track-identity.md`.
- Current remote preview: `test-results/ytdlp-live-preview-20260907T132003252446Z.json`, served engine SHA-256 `953232acca42905cc17101039ceaa3fabe7b0a052ec39c17dd25c170f3523c05`.

## Remaining local release gates

1. **Installed sharing and identity.** The latest user-confirmed reinstall passed header copying in both pitch modes and the same-profile recipient Apply once flow. Earlier malformed miniplayer identity and bare short-link failures remain unexplained. Verify native context-menu selection and separate-profile receipt on the accepted artifact; do not overwrite arbitrary copied fragments or claim the earlier cause was fixed.
2. **Extreme-rate audio.** Existing tone and chirp checks failed at 0.025×. Direct pinned-WASM experiments show variable output without browser scheduling, but do not establish the sole cause or clear those failures. Preserve the original thresholds and recordings.
3. **Clock and workload attribution.** The twelve-minute pass is sustained-output evidence, not a causal fix for the older shortfall. Distinguish device-clock behaviour, host scheduling, browser polling and DSP cost using measured data.
4. **Installed lifecycle and compatibility.** Complete latest-build startup, seek, queue, repeat, background and multi-tab flows, including interaction with other audio extensions. Physical touch, screen-reader output, Firefox and Linux remain unverified. Chromium keyboard, forced colours and 200%/400% browser zoom have separate evidence.
5. **Release presentation.** Refresh screenshots and capture the requested live editor video from the accepted candidate. The eleven public screenshots still belong to `789a8430`; do not relabel their hashes. Rebuild the source archive only after the accepted source and generated artifacts agree.
6. **Final independent review.** Reassess the complete accepted candidate against the original rubrics. Do not raise scores from fixture counts or add features solely to raise a score.

## Earlier independent rubric

| Usability heuristic | Score |
| --- | --- |
| System status | 4/4 |
| Familiar language | 4/4 |
| User control | 4/4 |
| Consistency | 4/4 |
| Error prevention | 3/4 |
| Recognition | 4/4 |
| Efficiency | 3/4 |
| Minimalism | 3/4 |
| Error recovery | 3/4 |
| Contextual help | 3/4 |

| Technical dimension | Score |
| --- | --- |
| Accessibility | 3/4 |
| Transfer performance | 4/4 |
| Responsive layout | 4/4 |
| Theming | 4/4 |
| Implementation integrity | 4/4 |

These are the retained review judgments, not a WCAG conformance assessment, a negligible-overhead claim or certification of low-rate sound quality.

## Deployment handoff

Publication remains outside the current local-work authorization. The host, HTTPS, proxy limits and stable update URLs must be configured before hosted install/update testing. Regional streaming behaviour and expired/preview URLs need verification from that host. PayPal remains unset until supplied. These deployment actions must not be silently performed to close the local checklist.
