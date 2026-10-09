# Tempo and pitch controls: local verification

Visual approval correction: the initial spacing and consistency PASS below was too broad. The fixtures passed but the review accepted cramped key controls, a text-like style picker and a star slider with no idle handle. Those findings and the scoped follow-up checks are recorded in [Control affordances](CONTROL-AFFORDANCES-QA.md). The original functional results do not establish visual polish.

2026-10-09. This covers the control, pitch automation, shared editor, share-page and star-setting changes. It is not a certification of the whole product or live SoundCloud playback. Existing unrelated work was preserved. The TCD backend was not changed.

## What changed

- Independent tempo and pitch points use one editor and one curve evaluator. Pitch points survive saved profiles, backups and shared codes.
- Fractional pitch entry, custom arrows, configurable bounds/steps and optional note names replace the player dropdown. Note names require the listener to supply the original key; no detection or major/minor conversion is claimed.
- The website uses the userscript editor, including points and fades. Its default tempo view is 0.75–1.5×.
- Shared links use the existing website's `/share/` route. The page validates the settings before creating SoundCloud links. No custom DNS was configured.
- Stars use a 15-second base divided by speed, with a 7.5-second default, on/off control and reduced-motion handling.

## Verification

- 557 unit tests passed. Added tests cover fractional settings, both automation lanes, imported-link validation, backups and fractional values reaching the existing audio processor without replacing its node.
- TypeScript and both builds passed. The static build still reports a chunk above 500 kB; this work does not claim to resolve that warning.
- All 22 muted browser suites passed against the shipped userscript, including controls, light/dark fixtures, custom fields, storage failures, links, automation, audio boundaries and crossfade fixtures. Both separate website suites also passed.
- `verify-pitch-automation.py` checks pitch point creation/dragging, interpolation at a synthetic seek, custom bounds and steps, manual override, removing automation, source-note selection, keyboard selection, saved curves, the website editor, stars and valid/invalid share pages.
- `verify-site.py` checks four content routes at five widths (320–1440 px), local links, images, the exact installer, preview controls, clipboard denial, hidden support content and no-JavaScript installation.
- `verify-site-presentation.py` checks header/anchor geometry, stars, reduced motion, forced colours and keyboard graph editing at four widths.
- Visual checks covered the userscript editor and website editor at 1100 and 390 px, plus the compact slider and dial. Screenshots are in `test-results/` and `.impeccable/review/`.
- `git diff --check` passed. The existing screenshot-evidence file has a line-ending warning, not a whitespace error.

Two independent contract reviews found and prompted fixes for pitch-coordinate naming, manual-override selection, share-state mismatches, preference refresh and crossfade schedule invalidation. The duplicate website editor/evaluator/history were removed. Validation and sharing were extracted into shared modules; no runtime dependency was added.

Anti Slop was applied during implementation, with Ponytail, the installed pstack skills and Thermo-Nuclear review. Impeccable was updated to 4.5.1 and used for the bounded visual review. Installing the pstack skill folders does not install Cursor's plugin hooks or external integrations.

## Anti Slop delivery gate

Scope: the changed controls, editor, share page, guide copy and star settings. Evidence above refers to isolated fixtures, not the user's installed browser session. Design decisions are recorded in `DESIGN.md`.

### Hard gate

- R-02 PASS: no em dashes in the changed listener-facing copy.
- R-03 PASS: overflow assertions passed for the editor at 390/1100 px and content routes at 320–1440 px.
- R-17 PASS: no usage counts, customer counts or unsupported statistics were added.
- R-18 PASS: no testimonials or invented people were added.
- R-23 PASS: existing product assets and the user-requested stars were retained; no new brand assets were invented.
- R-24 PASS: the website test checks local navigation targets and installation links.
- R-25 PASS: selected pitch-tab text has a measured contrast of at least 4.5:1; existing light/dark control and editor contrast checks pass. Active text uses the foreground token, with orange used for the outline.
- R-26 PASS: browser interactions exercise arrows, choices, bounds, point edits, save/apply, sharing, fixed/timeline modes and star controls. Duplicate inactive pitch controls are hidden in Timeline mode.
- R-27 PASS: malformed share data, unavailable previews, denied clipboard access and storage failures have visible feedback; browser tests exercise these states.
- R-28 PASS: no generic FAQ section was added.
- R-32 PASS: authored choices support arrows, Home/End, Enter and Escape; graph and numeric controls have keyboard paths and focus outlines. Browser tests exercise these paths.
- R-33 PASS: changes live in source modules and build normally; no generated-bundle patch is required.
- R-34 PASS: userscript theme/layout checks pass in light and dark fixtures. The website retains its established dark-only identity.
- R-35 PASS: builds, unit tests and recorded browser interactions were run against the local build, not just source inspection.
- R-36 PASS: no new security, compliance or performance claims were added.
- R-37 PASS: the existing design direction was retained; ENERGY 1 / RHYTHM 2 / MOTION 2 are recorded in `DESIGN.md`.
- R-38 PASS: generated WAVs and synthetic track data appear only in tests; product copy identifies manual key entry and audio-processing limits.

### Purpose gate

- R-01 PASS: no decorative gradients or glows were added; range gradients indicate the current value.
- R-04 PASS: stars are the requested background motif; arrows operate values or choices.
- R-06 PASS: existing Mulish and inherited player fonts remain; no display monospace or tracked uppercase headings were introduced.
- R-07 PASS: the grid represents time and pitch/speed; it is not background decoration.
- R-08 PASS: arrows have control functions, not decorative CTA placement.
- R-09 PASS: no promotional badges were added.
- R-10 PASS: new controls and menus use opaque surfaces, not glass effects.
- R-12 PASS: menu shadows indicate floating choices; controls do not receive large shadows.
- R-13 PASS: no glow effects were added.
- R-14 PASS: no feature-card grid was added.
- R-19 PASS: only the requested stars gained faster motion; hidden/off/reduced-motion states are tested.
- R-22 PASS: no stock illustrations were introduced.

### Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 2 / MOTION 2 are explicit in the design notes.
- Consistency PASS: quiet controls and a moving background preserve that direction.
- Focal point PASS: the automation graph occupies the central editing area in desktop/mobile captures.
- Whitespace PASS: transport, graph, point fields and sharing remain separate groups.
- Accent PASS: orange marks the curve and active control outlines; ordinary text uses readable foreground colours.
- Identity PASS: the existing charcoal, orange rails and sparse stars remain recognizable.
- Design read PASS: the existing product identity was selected before authoring these changes and recorded in the design notes.

### Craft and consistency

- C-1 PASS: control forms and spacing follow the existing player/editor rather than a new template.
- C-2 PASS: the changed controls have tested state changes; no placeholder action was added.
- C-3 PASS: the only new page handles shared track settings and installation.
- C-4 PASS: changed controls were exercised by keyboard, at narrow widths and in the existing theme fixtures; no-JavaScript installation remains available.
- C-5 PASS: no customer evidence or statistics were fabricated.
- R-05 PASS: the change reuses the product editor rather than adding a generic hero/cards layout.
- R-11 PASS: small rectangular controls are retained; round shapes represent dial/thumb/graph positions.
- R-15 PASS: actions name their result: Copy link, Save timeline, Remove pitch automation and Install Tempo Control.
- R-16 PASS: changed copy names behavior and limitations without promotional buzzwords.
- R-20 PASS: the time/pitch graph, semitone controls and orange SoundCloud-style rails remain product-specific.
- R-21 PASS: the website's existing dark identity and the plugin's selectable themes are preserved.
- R-29 PASS: existing neutral tokens and the orange accent are reused.
- R-30 PASS: no external product layout was copied.
- R-31 PASS: typography, spacing, graphs, controls and stars have explicit reasons in `DESIGN.md`.

## Limits and next decisions

This build has not been installed into the user's active SoundCloud browser, pushed to GitHub or deployed. The earlier live crossfade/Widevine crash is not declared fixed by these fixture results. Pitch remains within −12 to +12 semitones, and note names do not detect the source key.

History-based random tempo was not added silently. Options worth choosing between are: sample from distinct tempo bands instead of averaging, favour less-recently-used saved speeds, or mix mostly familiar settings with a small exploration range. Any implementation should keep history local and provide a reset. The site's fixed-speed control still uses its existing horizontal style; the shared timeline editor is now the same implementation, not a claim that every website control is identical to the plugin.
