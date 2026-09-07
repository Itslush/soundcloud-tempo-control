# Testing

For raw muted editor video alongside staged screenshots, add `--record-video` to `tests/capture-showcase.py --stage-only`. The full workflow recording is evidence, not an edited promotional clip. Inspect its actual frame rate before describing it as high-frame-rate footage.

`tests/verify-preserve-output.py --chirp-only --capture-pcm` optionally retains up to three seconds of mono worklet output indexed by render frame, including on assertion failure. `tests/analyze-pitch-windows.py <report>` measures those saved samples independently of browser analyser reads. These diagnostic windows do not replace or relax the original acceptance thresholds.

Use Node 24 and Python 3.12 or newer. Tests resolve paths from the repository root. `CHROME_PATH` can point to an installed Chromium browser; otherwise install Playwright Chromium.

```sh
npm ci --ignore-scripts
npm run setup:backend
npm run setup:decoder-probe
npm test
npm run typecheck
npm run build
npm run test:transfer
python -m pip install -r tests/requirements.txt
python -m playwright install chromium
npm run test:browser
```

For website checks, start `npm start` in another terminal:

```sh
python tests/verify-demo.py
python tests/verify-site.py
python tests/verify-site-presentation.py
python tests/verify-number-fields.py
python tests/verify-slider-ticks.py
python tests/verify-slider-style.py
python tests/verify-compact-library.py
python tests/verify-appearance.py
python tests/verify-hero.py
python tests/verify-captures.py
python tests/verify-interface.py
python tests/verify-demo-recovery.py
python tests/verify-preview-lifecycle.py
python tests/verify-navigation.py
```

`SITE_URL` overrides the default http://127.0.0.1:4322/. Screenshots and test output go to ignored `test-results/`. Browser checks run muted.

`npm test` builds and verifies the userscript, then runs the complete Node suite through `npm run test:unit`. That command discovers every `tests/*.test.cjs` and `tests/*.test.mjs` suite, including transport, lifecycle, host recovery and server checks. CI prepares the decoder fixture first and runs the suite once. Use `npm run test:unit` alone when testing without rebuilding published userscript files; focused commands remain available for development.

`TEMPO_TEST_SITE_ROOT` overrides the static build directory used by `node tests/transfer-budget.mjs`, allowing transfer checks on an isolated website candidate without rebuilding `dist/site`.

`python tests/capture-showcase.py --stage-only --expected-artifact SHA256` captures the real SoundCloud UI without replacing website images. It honors the candidate artifact environment variables below and requires staging mode when they are set. Each run writes to a new timestamped directory under `test-results/`, including `capture.json`; failed and successful attempts do not overwrite one another. Review the images before promoting a release capture.

To run the userscript fixture suites against an unpublished build, set `TEMPO_TEST_ARTIFACT` to its project-relative path and `TEMPO_TEST_ARTIFACT_SHA256` to its exact SHA-256, then run `python tests/run.py`. A missing or mismatched checksum rejects injection. Explicit artifact paths in individual live verifiers retain precedence. Neither override replaces public downloads.

`verify-site-presentation.py` checks the sticky full-width header, navigation targets, anchor offsets and full-page decorative starfield at four widths across five routes. It also verifies removed hint elements remain absent, node and mode controls still work, forced-colour hiding and no automatic default-track request.

## Coverage

The buffered modules are included in the userscript. Their isolated diagnostics and full-script checks have different coverage:

```sh
npm run setup:decoder-probe
npm run test:audio-candidate
npm run test:host-clock
python tests/verify-natural-chunks.py
python tests/verify-natural-output.py
python tests/verify-natural-truncate.py
python tests/verify-buffered-transport.py --local-only
python tests/verify-stream-source.py --bounded
python tests/verify-buffered-transport.py
python tests/verify-playback-owner.py
python tests/verify-buffered-player.py
python tests/verify-buffered-player.py --saved-reload
python tests/verify-buffered-transitions.py
```

Decoder setup downloads a pinned fixture once. The unit, generated Natural and local transport checks run without network audio and are included in CI. Source, non-local transport and full-player diagnostics observe a public SoundCloud HLS stream in a muted, isolated browser. The source check compares independent AAC-LC seeks with earlier-start decoding. The owner check uses generated PCM with the actual graph integration. The full-player check injects the complete built script and observes the real source association; it does not replace an installed-manager test. Diagnostic assets remain in ignored `test-results/decoder-assets/`. See LOW_RATE_PLAYBACK.md for scope, resource contracts and remaining release gates.

The full-player verifier defaults to the unmodified build. `--saved-reload` adds UI-save/reload and separate preference-only fresh-context first-Play cases in both pitch modes. It records SoundCloud's own reload autoplay separately. The explicit first-Play cases cancel pending host autoplay through the visible UI while media remains cold, then require exactly one Play click. `--native-reload-control` reproduces the host's reload behavior at native 0.85×. The optional `--minimum-override` flag is for historical diagnostics only and cannot be combined with the saved-reload production check.

For development playback changes, `npm run build:playback-candidate` builds the same userscript into a checksum-named file in `test-results/` without replacing public download bytes. Pass its relative path through `--artifact` to either `verify-buffered-player.py` or `verify-buffered-transitions.py`. Both verifiers now retain uniquely named reports containing the exact tested hash. A candidate passing syntax or module tests is not live playback acceptance.

Both live verifiers separately count project warnings and uncaught page errors, and reject an otherwise successful playback result when either occurs. Project warnings have their own bounded history, so site diagnostics cannot fill the general console buffer and hide a later project error. `python tests/test-transition-completion.py` tests this acceptance rule as well as source-completion classification. It is included in CI after Python dependencies are installed.

`python tests/verify-buffered-repeat.py --artifact test-results/playback-SHA256.user.js` checks two actual Repeat-one cycles in each pitch mode. It records trusted native tail-seek clicks, requires decoded completion after establishing a nonempty tail, and checks restart output without another click. `python tests/test-repeat-completion.py` covers its completion classifier. `python tests/test-baseline-diagnostics.py` verifies that baseline acceptance includes warnings and errors during cleanup. Both deterministic commands are included in CI; the live repeat diagnostic is not.

`verify-playback-baseline.py` also accepts `--artifact` and `--seconds 40|120|360|720|1800|3600`. Durations above 120 seconds require explicitly selected buffered cases. Each 20-second sample is checkpointed and checked against wall time without relaxing the existing tolerance. Bounded context-state/output-timestamp history and CDP rendering metrics help distinguish interruptions; they are not continuous render-thread profiles. Checkpoint I/O occurs inside the wall interval, so these CPU observations are not directly comparable with the older matrix. `python tests/verify-audio-clock-control.py --seconds 720` separately runs a local oscillator through permanent zero gain without SoundCloud or project audio code.

`verify-buffered-transitions.py` uses observed public track rows and SoundCloud's Next-up controls. It validates the queue before switching, establishes a distinct outgoing position with the native seek control and checks the incoming source and playback clock in both pitch modes. `--automatic-eof --tail-seconds 1` separately checks four natural-end handoffs and retains an incomplete exit if outgoing decoded completion is unobserved. `--eof-native-control --tail-seconds 1` observes native 0.85× behavior with the same installed-by-injection script; it is not a plain-SoundCloud control. Tail observations continue through actual incoming playback, distinguish explicit source identity from a stale `currentSrc`, and reject evidence-history overflow. Identity around the completion snapshot is read before delegating Pause, not across the native call. Incoming queue success does not certify the outgoing tail. See LOW_RATE_PLAYBACK.md for the original failure, integrated fix and exact passing report hashes.

On Windows, `python tests/verify-buffered-session.py` measures 120 seconds of real public-track playback per pitch mode at 0.025×. `--expected-artifact SHA256` optionally requires an exact build. The test verifies its isolated Chrome process identity before reading process-tree CPU and private memory, and records page heap and task time separately. Keep other test browsers idle during this run. No forced garbage collection is performed. Endpoint memory samples and six signal windows per mode do not establish peak memory, continuous audio quality or hour-long reliability; 240 seconds at this rate consumes about six source seconds.

`python tests/verify-playback-baseline.py --expected-artifact SHA256` compares six fresh-browser conditions: plain and userscript Natural at 0.85×, browser Preserve at 0.85×, userscript WASM Preserve at 0.85×, and both buffered modes at 0.025×. Plain conditions omit the userscript and its dependency. Each case uses the same diagnostic observer and zero-gain sink, a ten-second warmup, a commanded 30-second source position and a 40-second measurement interval. Actual starting positions must remain within 0.5 seconds of the target. Native pitch settings and route ownership are checked explicitly. Run `--case plain-natural` for one condition. Keep all other test browsers idle; the report records endpoint process memory and CPU, page metrics and two signal windows without forced garbage collection. Differences are single-run observations within matching rate groups, not isolated library costs, statistical benchmarks or proof of negligible overhead.

Baseline reports are saved atomically before each condition, at every 20-second checkpoint and after browser cleanup. Checkpoint I/O falls inside the wall interval but outside the measured browser process tree, so CPU results are not directly comparable to older runs without it. Each run has a unique file, the active condition and completed count; the prior latest report is retained by content hash. A checkpoint marked `RUNNING` is not proof that a process survived an interruption. Source progression must agree with monotonic wall time and the audio-context clock at every checkpoint. Resume readiness may include stale analyser history and is not audible-start latency.

Use `--artifact PATH` to test an unpublished candidate with its required exact hash. `--seconds` accepts 40, 120, 360, 720, 1800 or 3600; intervals above 120 seconds require explicit buffered cases. `--trace-host-lifecycle` records bounded host error/kill calls and the media error label before host handling, then restores its observers. It is a diagnostic mode, not an uninstrumented benchmark. Rendering metrics and context-state events are sampled, not continuous proof against transient overload.

`--trace-audio-from 0` starts native Chromium author-script callback tracing at the beginning of measurement; a multiple of 20 selects a later checkpoint. The report includes duration percentiles, maximum, count above the measured context's 128-frame budget and trace-loss state. Selected raw callback events are saved as JSON Lines. Chromium's trace buffer is capped at 256 MiB; a full buffer, missing events or incomplete collection invalidates trace acceptance. This captures all worklet callbacks on the traced session, not processor names. Multiple worklets require further attribution. Wall-time brackets around each CDP observation remain available separately. A callback above its quantum budget is a profiling finding, not by itself proof of audible underrun. Tracing changes workload; do not present these runs as uninstrumented performance.

The preserved run `playback-baseline-20260906T183816459589Z-e50b25d1.json` used artifact `16441d20f57c7ebeb4b0f6bcf0d94cb85486604b3a7d5144b57abb7850a50ac5` and is `INCOMPLETE`. All four 0.85× conditions passed their 40-second intervals. Buffered Natural failed the independent wall-clock check: 40.017 wall seconds advanced the audio context by 35.649 seconds and the source by only 0.891233 seconds at 0.025×. Buffered Preserve was not run. Every attempted browser closed muted. The observation does not identify whether the lost context time originated in the userscript, browser or device; ordinary-speed CPU differences are single-run observations, not causal overhead measurements. LOW_RATE_PLAYBACK.md retains the report hash and details.

The newer `b01ec510` artifact adds B01 status-render notification filtering, while retaining each incoming playback-state snapshot. It does not change DSP, clock or EOF behavior. Its unit-suite result is separate from the measured `16441d20` matrix; neither a live performance improvement nor a resolution of that clock shortfall has been established.

The isolated host-clock candidate has separate commands: `node --test tests/host-clock.test.mjs`, `python tests/test-transition-completion.py`, `python tests/verify-host-clock.py`, and `python tests/verify-host-clock-candidate.py --mode natural` or `--mode preserve`. The first two are deterministic. Live runs validate fingerprints of already-executed host SDK methods and attach the candidate only to an already-playing source; they do not establish production discovery or lifecycle integration. LOW_RATE_PLAYBACK.md records exact candidate/report hashes and the two passing completion observations. The completion recorder distinguishes pre-host-Pause decoded state from actual ended-event delivery and retains independent source, rate, native-state, no-extra-click and evidence-capacity checks.

The 19 userscript suites exercise playback guards, saving, keyboard and slider controls, timeline interpolation, pitch selection, the real WASM engine, fallback, links, native copy, embedded track views, displayed-duration parsing, editor zoom/pan, output level, update notices and idle overhead. Library checks cover fixed speeds and timelines, disabled entries, editing, delete undo, backup preview/cancel/replace, malformed imports, stale previews, storage rollback and 1,000-entry pagination. The WASM tests measure synthetic-tone frequency and continuously captured seek/source boundaries through muted Web Audio graphs, not subjective music quality.

`verify-embedded-track.py` injects the userscript only into the top window, respecting its `@noframes` contract. Its 25 groups test same-origin track artwork, canonical and shortlink copy, opt-out, navigation, frame removal and cleanup. Avatar-based fallback covers include visible/hidden responsive variants and 11 negative examples. Foreign, sandboxed and unsupported embedded pages are excluded. Clipboard fixtures record writes locally; no shortlinks are resolved and no audio is started.

`verify-display-duration.py` reproduces SoundCloud's visible clock beside its hidden accessibility label without an active audio element. It checks sharing and editor initialization, plain and nested clock formats, malformed or absent clocks and positive finite-media preference. The initial baseline failed all three paused copy paths. A later zero-duration case also failed before the shared duration selector was corrected. The latest build passes all eight groups, including the zero-duration fallback.

`python tests/verify-native-rate-limits.py` is a separate capability diagnostic, not part of the production support suite. It tests native rates down to the requested 0.025× using generated PCM and muted output, with actual-rate and cleanup checks. Chromium 144 rejected 0.025× in both native pitch modes at 48/96 kHz. See LOW_RATE_PLAYBACK.md; production bounds must not be lowered on setter acceptance alone.

The Node run for the earlier `b01ec51097ceb81073cdf7bfeb317f849573d856c1d8166aa31a16518cab6bb0` artifact includes 30 release/library/timeline/worklet-lifecycle tests, 311 audio module/bridge/editor groups and 33 backend/process tests. The slider and appearance build adds 25 theme tests, bringing `npm test` to 55 passing tests; its audio and backend commands also pass again. Historical report counts are unchanged. Some commands share regression files; their counts are not additive. `npm test` also verifies a test-only buffered-copy candidate against an independent reference in 16,430 cases. It reproduces the original library exception without modifying the dependency or claiming playback quality. See LOW_RATE_PLAYBACK.md for audio integration diagnostics. API tests use deterministic extractor responses and child-process fixtures. They cover URL validation, single-flight extraction, cache expiry/eviction, cancellation, timeouts, bounded output, host restrictions, restricted-track rejection, request limits, HTML versus API error routing and subfolder deployment. Delivery checks cover real-path confinement, compression negotiation, conditional requests, bodyless HEAD responses and mutable/immutable caching.

The transfer check starts its own local server against the build. It enforces initial transfer limits of 192 KiB, 384 KiB including all preview crops, 48 KiB JavaScript, 16 KiB CSS and 112 KiB fonts. It conservatively includes every font subset. HLS, audio and full-resolution capture images are deferred and excluded from the initial budget. This is a transfer check, not a CPU or Lighthouse score.

For live link playback, run `npm run setup:backend`, start `npm start`, then run `python tests/verify-live-track.py`. This separate network test loads a public NASA track without credentials and checks real nonzero audio output, natural 0.75× playback, the WASM path, seeking and pause. It runs muted. `TEST_TRACK_URL` optionally selects another public test track. It is not part of offline CI.

Set `TEST_DEFAULT_TRACK=1` to exercise the default Drown demo through the main Play button instead of the optional link form.

Website checks cover routes, matching download bytes, graph controls, sample playback, keyboard menus, loading failures, image skeletons, responsive layouts and full-resolution capture viewing. `verify-navigation.py` enables browser Back/Forward caching and performs actual history navigation in idle, paused and playing states with both pitch modes. It checks retained edits, pitch/rate settings, paused return state, position and nonzero audio after resuming with an advancing audio-context clock. Its report distinguishes cached restoration from fresh reloads and records browser cache-miss reasons. Exit 2 indicates incomplete cached-restoration coverage, not a successful cache test. All ten returns across five local Chrome 144 cases restored from cache. It uses generated local audio, not remote HLS.

Recovery tests cover delayed and repeated metadata, stream re-resolution on retry, non-JSON upstream errors, preview-only sharing restrictions, Fixed/Timeline state, Original comparison position, drag undo, persistent playhead identity and short-file timing precision. Interface tests cover eight widths from 320 to 1920 px, reserved scrollbar space, long Unicode/RTL titles, 44 px graph hit regions, interrupted menu transitions, inert closed menus, reduced motion and forced colors. The 2× CSS-zoom check is not actual browser zoom or screen-reader testing.

Audio lifecycle checks verify one reused worklet across source, pause, seek and mode changes, with sampled source-silent output checks, late configuration/rate guards, paused-mode restoration and partial-connection recovery. `verify-wasm.py` samples the latest 128 frames every 10 ms. It rejects sampled output after source silence or 150 ms, but permits an initial nonzero source/output pair. That older check is not continuous PCM capture, and a zero-time observation may contain pre-seek analyser history. `verify-preview-lifecycle.py` defaults to 96 kHz; set `AUDIO_SAMPLE_RATE=48000` for 48 kHz. `verify-wasm.py` defaults to 48 kHz; set `TEST_CONTEXT_RATE=96000` for 96 kHz. Both rates were exercised locally. Those runners keep one rate each; the alternate rates can be run separately.

`verify-wasm-boundaries.py` separately captures every stereo frame from the raw source and routed userscript output in the same worklet callback. Eight generated-WAV cases cover seeks and source replacement at 0.5×/1.5× and 48/96 kHz, plus two deliberately contaminated controls that must be rejected. Captures are bounded to 2.25 seconds and checked for continuous timestamps, finite output, source silence, measured engine-latency deadlines and cleanup. Reports include the userscript hash and hashes of the captured PCM. Passes establish these synthetic boundaries only, not website-adapter coverage, every rate, live SoundCloud, listening quality or long-session memory behavior.

Number-field checks cover all four custom steppers, native-spinner suppression, typing, keyboard controls, empty-value recovery, bounds, disabled state, decimal precision, six screen widths and forced-colour focus. Hero checks cover stable positioning with expanded disclosures, a static decorative starfield, click-only default loading, Reset during loading and local files replacing pending requests.

Slider-ruler checks verify 80 userscript and 36 website tick centers, thumb-travel endpoints, the 1× position and unchanged 0.025× keyboard steps. They cover three widths per surface, four CSS scales and three device scales, with no audio loading. The userscript includes its 0.025× endpoint; the website preview still starts at 0.25×. These geometry checks are separate from the actual browser-zoom diagnostic.

`verify-compact-library.py` checks 30 synthetic tracks at four viewport sizes, independent list scrolling, stationary search, combined speed/timeline rows, editing and removal undo. Typical speed rows measure 43 px; the fixtures show 14 complete rows at 1440×1000 and six at 320×640. Pixel checks compare the outlined ring center against ten selected stops at three widths and three device scales, with a maximum observed error of 0.992 CSS px against the unchanged 1.1 px tolerance. Forced-colour emulation checks the visible rail and thumb. These are isolated Chromium fixtures, not confirmation of the updated installed script or screen-reader output.

`verify-slider-style.py` exercises all seven userscript and website sliders with mouse and touch emulation. It checks hidden idle handles, hover, keyboard focus, dragging outside the control, release, disabled states, forced colors, reduced motion and programmatic fills. Native input hit areas remain larger than the 12 px visible rings. Website unloaded seeking is temporarily enabled only to inspect its appearance; no track is loaded.

`verify-appearance.py` checks SoundCloud, Charcoal and OLED choices from both fixture host themes, at 1440 and 390 px. It covers keyboard selection, cross-tab storage, reload, forced colors, same-origin embedded-page attachment and cleanup, and restoration. Set `TEST_LIVE_APPEARANCE=1` for an additional public SoundCloud check using only the appearance module. The live check confirms the native header and inner player surface, footer button backgrounds and restoration. SoundCloud can autostart after its sign-in prompt closes; observed media remains muted and is stopped at teardown. This evidence covers the signed-out legacy route, not the user's installed profile or a live embedded track view.

## Before public distribution

The signed-in Edge installation was exercised through actual UI actions on 2026-09-06. Checks covered 0.025× range steps, 0.01× Shift-click steps, exact-value bounds, reset, evenly spaced tick geometry, native rail alignment, saved-rate reload, removal undo, keyboard point editing, malformed imports, discard and focus restoration. Temporary presets were removed and the original preferences restored. Follow-up checks confirmed the embedded adapter and a visible 0.85× artwork badge after rendering settled. The duration suite now covers SoundCloud's visible clock beside its accessibility text. After the user reported installing the update, the paused editor opened and copied a correct 394-second track with 0.85× and Natural pitch; 14 saved tracks remained. Native Copy link still produced canonical or short links without metadata after navigation and reload. A separate track using an avatar as its cover had no artwork badge. These failures remain distinct from the passing editor flow. Playback was left paused, with the existing rate and volume unchanged. These are not signed-in playback, screen-reader or installed-byte-hash verifications.

An isolated follow-up reproduced remembered-rate reload and SPA navigation successfully through the currently tested copy paths. It also established two unhandled alternatives: a target copy handler that stops propagation, and `Clipboard.write` with a `ClipboardItem`. Neither has yet been identified as the installed site's actual mechanism. The existing clipboard fixtures do not justify claiming those alternatives work.

`verify-live-copy.py` is a separate network diagnostic, not an offline regression suite. Its latest run was inconclusive: the signed-out canonical page used the older interface, while directly loading the newer embedded route produced disabled track controls. It did not click Play or use the user's profile. Inspection of the newer player's [public copy-action bundle](https://assets.web.soundcloud.cloud/_next/static/chunks/27rjcfdil6a93.js?dpl=9adc5e8353054435acb0c23ee3d66c43b63066ba) showed an awaited link-generation request followed by a dynamic `navigator.clipboard.writeText` call. That source evidence does not establish the exact script or runtime conditions in the installed session. No unsupported-copy-API workaround was added on speculation.

Two optional Windows-only diagnostics use official, pinned assets under ignored `test-results/manager-assets/`:

- `python tests/verify-violentmonkey.py` verifies the real manager installer, stored script bytes and persistence after restarting an isolated browser. Exit 2 means Chromium's separate userscript permission blocks injection. It never enables that permission or substitutes simulated GM APIs.
- `python tests/verify-browser-zoom.py` uses the isolated manager worker's tabs API to set actual 200% and 400% browser zoom. It verifies viewport and devicePixelRatio changes, keyboard and click controls, and horizontal overflow. No audio is loaded. This does not verify screen-reader output or physical touch.

Both require the official [Violentmonkey 2.48.0 MV3 archive](https://github.com/violentmonkey/violentmonkey/releases/download/v2.48.0/Violentmonkey-mv3-v2.48.0.zip), SHA256 `583ac595bb698a926eadb6064431fce1108dc2f2adb966ed984738824d2d5a54`, saved as `test-results/manager-assets/Violentmonkey-mv3-v2.48.0.zip` and extracted unchanged to `test-results/manager-assets/violentmonkey-2.48.0/`. They also require Chrome for Testing 148.0.7778.96, Playwright revision 1223, at `test-results/manager-assets/playwright-browsers/chromium-1223/chrome-win64/chrome.exe`. The harness verifies the extracted manager bytes against the archive before launch. It deliberately pins the userscript build hash; update that expected hash only after reviewing a changed build. These diagnostics are separate from CI and never use an existing browser profile.

`python tests/verify-session.py` runs a separate 120-second real-clock, muted playback stress test. It exercises repeated loads, seeks, pauses, resets and pitch-mode changes, records nonzero audio samples, and writes `test-results/session-report.json`. Chrome main-thread metrics and post-GC heap snapshots are diagnostic measurements. They do not include total DSP CPU, prove native worklet reclamation, or establish one-hour behavior. This longer test is not part of the normal offline runner.

- Test yt-dlp with full and preview HLS streams, expired URLs, short links and CORS from the deployment host. Review compatibility and the applicable platform terms before publishing the resolver.
- Install through Violentmonkey and test signed-in SoundCloud playback, queue changes, seeks and graph replacement.
- Listen to music in both pitch modes, including long mixes and background tabs. Measure sustained CPU and memory on representative machines.
- Check Firefox, Edge and Linux explicitly; local Chromium results do not establish those platforms.
- Test hosted update metadata with an actual version increment.

`python tests/capture-showcase.py --expected-artifact <sha256>` performs a separate live, muted SoundCloud capture of the explicitly selected Drown track. It requires network access and is not part of the offline suite. All eleven images are staged before publishing. The sender saves its speed and timeline through the UI; a fresh recipient opens the actual copied link and verifies its unsaved preview before saving. The report records source/artifact/image hashes and zero-gain media cleanup. Failed runs retain diagnostics under ignored `test-results/` without replacing public captures. `verify-captures.py` checks that provenance, exact image bytes, responsive variants and full-viewer interactions.
