# Control affordances follow-up

## Current follow-up: increments, scales and semitone controls

2026-10-09, second pass requested by the user. This section supersedes the presentation and artifact hash in the historical pass below.

- Appearance now saves a default tempo increment (0.025× initially, 0.001× to 1× allowed). Player arrows and keyboard controls use it, as do timeline point controls. Direct typing still accepts finer values. Invalid settings restore the saved value with an error message.
- The dial has 17 marks on its existing logarithmic scale. Major marks represent 0.25×, 0.5×, 1×, 2× and 4×. The vertical slider has quarter-speed ticks, five value labels, the shared outlined thumb and Reset.
- The footer separates tempo from the Pitch group with a 16 px margin. Its order is label, value, unit, arrows. Compact layouts retain space for the host controls.
- Musical-key mode and its note-name conversion are removed. Semitone bounds and default increment each have an aligned labelled row. Existing saved pitch values, bounds, increments and automation points remain compatible.
- First-install setup offers Show semitone adjustment in player. Appearance retains the same option afterward. Hiding the footer control does not reset pitch or remove editor access.

### Verification

- 559 unit tests passed. Focused backup tests also reject zero, out-of-range and string tempo increments before writing; valid settings round-trip. Legacy note-mode preferences retain their semitone bounds and increment.
- The affordance browser test covers saved increments, player and dial keyboard stepping, reload, cross-tab updates, invalid-value rollback, scale marks, absence of musical-key controls and aligned settings in OLED, charcoal and light at 1440, 390 and 320 px.
- The control-style browser test covers first-install opt-out, reload and re-enabling semitone controls, all three styles at six widths and footer separation. The pitch automation test exercises the increment through the actual settings UI before opening the editor.
- Build, TypeScript, syntax and clean-build checks passed. Website route, layout, keyboard and presentation checks passed. The existing large-chunk build warning remains.
- All 23 muted browser suites passed against the final userscript, including timeline, sharing, backups and playback fixtures. This does not establish live audio quality or resolve the earlier Widevine report.
- Inspected rendered footer, dial, fader, narrow semitone settings, light Appearance and first-install captures. These are muted local fixtures, not live SoundCloud screenshots. New evidence lives in `test-results/affordance-dial-*.png`, `affordance-pitch-settings-*.png`, `affordance-fader-*.png`, `affordance-footer-*.png`, `affordance-settings-*.png` and `control-first-run-*.png`.
- The userscript and both website download copies are identical: SHA-256 `f994fd0bda1ec3db4a73a409fbd241c2623cfab7b5f92dd0737adf2d3ace4962`.

### Scoped review

Ponytail and the strict maintainability review: one small shared preference reader/validator serves the player, editor and backup boundary. Existing field components, style storage and first-install flow are reused. Removed note-name code rather than leaving a disabled parallel mode. No dependency, audio path or shared-link format changed. The already-large player/editor files were not otherwise refactored.

Anti Slop gate: authored controls keep semantic inputs, custom arrows, focus and keyboard interaction (R-26/R-32). Narrow layouts and existing theme contrast checks pass (R-03/R-25/R-34). Tick marks encode the actual scales; group spacing and stacked rows address the supplied screenshots (R-01/R-08/R-37). Copy names the controls directly and makes no new product claims (R-02/R-16/R-36). Persistence, validation errors and disabled controls are exercised (R-27). Changes were made in canonical source and rebuilt, with fixture evidence identified explicitly (R-33/R-35/R-38/C-4/C-5). Other unchanged delivery gates in the historical pass remain applicable; this is not an approval of unrelated screens.

Not installed or published. Live SoundCloud, Firefox and the earlier audio/Widevine issue were not tested by this UI task. TCD backend untouched.

## Historical first pass

2026-10-09. Scope: player key spacing, the settings choice button, idle settings/star slider handles, vertical fader presentation and saved slider fill. This replaces the earlier visual approval of those controls, not the earlier functional test results.

## Changes and reasons

- The style chooser has a visible border and an SVG chevron. It must look clickable before hover.
- Key now reads label, value, unit, arrows. The arrows match the tempo arrow width; fixed fractional values cannot move the adjacent actions.
- Settings and star sliders retain their handles at rest. Hiding them made these settings look like separators.
- Saved star speed and crossfade duration synchronize their fill through the existing range helper. No extra state or storage format was introduced.
- The vertical slider uses the shared outlined thumb. Endpoint and normal-speed labels sit outside its travel; Reset has a button boundary.
- The thumb outline mixes 15% foreground into the existing accent. On the light player background this changes the outline from 2.86:1 to 3.63:1 non-text contrast without changing the selected accent.

Design read: an existing compact SoundCloud music control, ENERGY 1 / RHYTHM 2 / MOTION 2. Preserve the host typography, flat panels and orange interaction accents. No change to star animation timing or audio behavior.

## Evidence

- `verify-control-affordances.py`: OLED, charcoal and native light at 1440, 390 and 320 px. Click/keyboard choice selection, Escape/focus return, visible idle star handle, calculated fill, reload persistence, disabled motion control, fractional key arrows, unit/arrow spacing, fader labels and Reset. No page errors.
- `verify-control-styles.py`: all three control styles at six widths, hide-key restoration, fader positioning, actual star movement and saved settings passed.
- `verify-pitch-automation.py`: shared fields still support fractional arrows, manual overrides, saved points, note-name keyboard selection and the website editor.
- Build, TypeScript and 557 unit tests passed. All 23 muted browser suites passed during the change. After the final thumb-outline-only adjustment, the dedicated affordance test and clean-build validation were repeated against the final download.
- Final userscript, website source download and built website download are byte-identical. SHA-256: `868d158d352a2f28dc5770f6bf3256a833581372cccd2e6d0b52828502b3603b`.
- Rendered captures: `test-results/affordance-settings-*.png`, `affordance-footer-*.png`, `affordance-fader-*.png` and `affordance-site-stars-*.png`. The captures use local player markup, not the live account.

## Anti Slop delivery gate

These results apply only to this change. They do not assert that every pre-existing screen is polished.

### Hard gates

- R-02 PASS: added labels contain no em dashes.
- R-03 PASS: settings and footer overflow checks passed at 320/390/1440 px; compact host controls retain the host density.
- R-17 PASS: no statistics or promotional numbers added.
- R-18 PASS: no testimonials added.
- R-23 PASS: no identity assets, imagery or navigation added; the chevron discloses the existing choice menu.
- R-24 PASS: no navigation destinations changed.
- R-25 PASS: chooser text is measured at >=4.5:1 in each theme; new thumb outline meets 3:1 in the light and dark reference palettes.
- R-26 PASS: chooser selection, star speed, disable/enable, key arrows and fader Reset exercised.
- R-27 PASS: no new data loading flow; disabled slider state verified.
- R-28 PASS: no FAQ content added.
- R-32 PASS: Enter/arrow selection, Escape, focus return and slider keyboard input verified.
- R-33 PASS: edits made directly in canonical source, then rebuilt through the existing builder.
- R-34 PASS: OLED, charcoal and light fixture captures and interactions verified.
- R-35 PASS: built and ran the affected controls; recorded interactions appear above.
- R-36 PASS: no security, performance or user claims added to the UI.
- R-37 PASS: existing DESIGN.md and the user's horizontal-slider reference guide the change.
- R-38 PASS: tests identify their player as a fixture; no fabricated product evidence.

### Purpose gates

- R-01 PASS: the range fill encodes the current value; no decorative gradient or glow added.
- R-04 PASS: the chevron identifies a menu, not a product feature.
- R-06 PASS: inherited host typography retained.
- R-07 PASS: no background pattern changed.
- R-08 PASS: arrows disclose options or change numeric values.
- R-09 PASS: no badges added.
- R-10 PASS: no blur added.
- R-12 PASS: existing menu elevation retained; no new shadow treatment.
- R-13 PASS: no glow added.
- R-14 PASS: no cards added.
- R-19 PASS: no new animation; existing interaction feedback retained.
- R-22 PASS: no illustrations added.

### Liveliness

- PASS: dials declared above and existing appearance retained.
- PASS: the tempo control remains the footer task; settings are secondary.
- PASS: key value/unit/arrows form one bounded group with separation from the tempo control.
- PASS: orange continues to indicate the slider value; no extra accent introduced.
- PASS: shared rails and outlined thumbs remain the music-control motif.
- PASS: direction was established before edits, using the user's supplied screenshots.

### Craft and consistency

- C-1 PASS: each changed presentation choice has a reason above.
- C-2 PASS: affected controls perform their named actions in the fixture.
- C-3 PASS: no sections added.
- C-4 PASS: scoped theme, width, persistence, disabled and keyboard checks passed; live browser remains unverified.
- C-5 PASS: fixture evidence is explicitly distinguished from live SoundCloud.
- R-05 PASS: existing layouts retained; no landing-page template added.
- R-11 PASS: existing small-radius control vocabulary retained.
- R-15 PASS: Reset remains a literal action; no new CTA.
- R-16 PASS: no marketing copy added.
- R-20 PASS: preserves the supplied SoundCloud control language.
- R-21 PASS: existing user theme choices retained.
- R-29 PASS: neutral host colors plus the existing orange accent.
- R-30 PASS: refinement of the explicitly requested host styling, not an unrequested product clone.
- R-31 PASS: layout, color, type and control purposes recorded above.

## Code review and limits

The change reuses the existing range synchronizer and field enhancement. The note-name caller now updates the caption rather than replacing the whole button and destroying its chevron. No dependency, storage schema, shared-link payload or audio route changed. No unrelated file decomposition was performed.

Not installed, published or tested against the user's live SoundCloud account. Chrome fixture screenshots do not establish Firefox rendering or resolve the earlier Widevine report. The existing large website-chunk warning remains. TCD backend untouched.
