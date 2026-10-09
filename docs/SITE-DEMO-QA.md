# Demo and screenshot checks

Scope: website controls, draft playback, star motion and screenshot presentation. No backend, crossfade or audio-processor code changed. No changelog entry was added.

## Evidence

- The audio regression initially failed when changing the timeline draft's semitone field. After the fix, `verify-site-polish.py` measured the expected frequencies for −3.5, −6, +3 and +3.5 semitones through the actual preview processor. It also checked a +2-semitone pitch point, seeking, original comparison and independent fixed/timeline values. The generated 440 Hz input and final zero-gain destination prevent audible playback.
- The same test checks visible slider tracks and thumbs, equal number-field dimensions at 320, 390 and 1440 px, numeric buttons, keyboard sliders and opening Advanced from a graph point. Desktop and mobile captures were inspected.
- `star-motion.test.cjs` passed 120,000 simulated frames using the shipped script. Displacement stays at 10 SVG pixels per second, corresponding to the fixed 1.5× setting. Direction changes remain continuous through random period changes and observed tile wraps. Hidden, offscreen, reduced-motion and forced-colour states stop scheduling frames; resuming does not jump.
- `verify-site.py`, `verify-site-presentation.py`, `verify-slider-ticks.py` and `verify-pitch-automation.py` passed. These cover links, exact downloads, donations, clipboard rejection, keyboard edits, sharing, mobile overflow, motion preferences and deferred track loading.
- `capture-showcase.py` refreshed all eleven images from the current built script on the real public SoundCloud track, in isolated muted Chrome. `screenshot-evidence.json` records the artifact and image hashes. `verify-captures.py` passed four fitted crop views at seven widths, zoom, Escape, focus return, loading failure/retry and no-JavaScript links.
- Production build, TypeScript, 561 Node tests and transfer budgets passed. The existing deferred audio-bundle size warning remains.
- Twenty-two of twenty-three plugin browser suites passed. The eleven suites after the boundary failure were run separately, including shared links, editor zoom/pan, output level and the generated-audio crossfade fixture.

## Limits

The full browser runner stopped at `verify-wasm-boundaries.py`: the 96 kHz, 0.5× source-replacement capture reported “Missing or duplicated render quantum.” The other captured boundary cases passed. This result does not distinguish a capture discontinuity from playback behavior. The processor was not changed or its test threshold relaxed. Similar capture failures are recorded in MAINTAINABILITY.md. This is not a clean whole-engine certification.

The website audio checks use generated local input. The SoundCloud screenshots use early script injection, not an installed userscript manager. Physical mobile devices, listening quality and the Oracle preview backend were not verified in this task. Existing CI had already failed before this change; local website checks do not imply all CI jobs passed.

## Maintainability and blast radius

The demo had been reading the applied profile while displaying an unsaved draft. `draftPlayback()` evaluates that draft using the existing tempo and pitch functions. A single demo apply path now handles foreground playback, hidden-tab updates and control changes. Fixed pitch no longer overwrites the timeline's pitch points. Stored profiles and shared-link formats are unchanged; sharing and saved-profile fixture tests passed.

The two fixed controls render from one data list and reuse NumberField and the website range styles. Removing the star component's global plugin range CSS fixes the missing tracks at their source. The old star settings, alternating animation, unused range decorations and full-screenshot focal-point code were removed. No dependency or framework was added. No file crossed 1,000 lines; the existing large editor gained only its bounded draft accessor and inline presentation handling.

## Anti Slop delivery gate

This gate covers the changed website UI, not the unresolved processor diagnostic. DESIGN.md retains ENERGY 1, RHYTHM 2 and MOTION 2, with charcoal, orange, Mulish and the user's stars.

- R-02 PASS: changed public labels contain no em dashes.
- R-03 PASS: overflow checks passed at 320 through 1440 px; crop viewer checks extend to 1920 px.
- R-17 PASS: no invented adoption or performance statistics.
- R-18 PASS: no testimonials added.
- R-23 PASS: existing branding retained; requested screenshots come from actual browser captures.
- R-24 PASS: route and no-JavaScript image-link checks passed.
- R-25 PASS: labels retain the tested foreground and muted colours on opaque charcoal; no new text colours.
- R-26 PASS: both sliders, number buttons, modes, Advanced, graph edits and viewer controls were exercised.
- R-27 PASS: existing resolver, clipboard and image-loading failures retain feedback and retry paths.
- R-28 PASS: no FAQ added.
- R-32 PASS: keyboard graph entry, disclosure activation, range keys, Escape and focus restoration passed.
- R-33 PASS: all production changes are in source; captures contain unedited browser pixels.
- R-34 PASS: forced-colour checks passed; no theme toggle added.
- R-35 PASS: built assets were run; changed controls and their failure paths were tested.
- R-36 PASS: no whole-engine, security or listening-quality guarantee.
- R-37 PASS: existing design direction retained and the requested motion/control decisions recorded.
- R-38 PASS: real track and actual saved settings used in captures; no fabricated library entries.
- R-01 PASS: slider gradients encode the value; no decorative gradient or glow added.
- R-04 PASS: stars are the requested background motif; the new chevron opens Advanced.
- R-06 PASS: existing Mulish typography retained.
- R-07 PASS: graph grids show values; no new decorative grid.
- R-08 PASS: arrows remain interaction indicators, not promotional decoration.
- R-09 PASS: no badges added.
- R-10 PASS: no glass effects added.
- R-12 PASS: no new shadows.
- R-13 PASS: no glow.
- R-14 PASS: paired controls repeat one data-entry layout; no feature-card grid added.
- R-19 PASS: continuous star drift is explicit user direction; reduced-motion and pause behavior passed.
- R-22 PASS: no stock or generated illustrations.
- Liveliness PASS: the timeline remains the focal point; matching rows separate tempo and pitch. Orange and stars retain the existing identity and stated design dials.
- C-1 PASS: control sizing, persistent thumbs and fitted crops address the reported problems.
- C-2 PASS: audio measurements confirm the controls change output, not only displayed values.
- C-3 PASS: no filler section added; detailed fields move into Advanced.
- C-4 PASS: tested narrow layouts, keyboard operation, motion preferences and image failure/retry.
- C-5 PASS: capture provenance and audio-test scope are explicit.
- R-05 PASS: existing music-tool composition retained.
- R-11 PASS: existing small-radius controls retained.
- R-15 PASS: functional labels such as Tempo, Key shift and Advanced replace no action with a generic CTA.
- R-16 PASS: no marketing superlatives introduced.
- R-20 PASS: the real editor and SoundCloud controls remain the content.
- R-21 PASS: dark styling follows the user's existing direction.
- R-29 PASS: existing palette retained.
- R-30 PASS: no borrowed SaaS layout.
- R-31 PASS: equal fields make the paired adjustments consistent; opaque panels preserve readability; cropped captures isolate the changed controls.
