# v1.0.0 local release handoff

Prepared 2026-09-07. This records the packaged build before the source organization cleanup. Its hashes and playback results refer to that build, not subsequent rebuilds.

## Deliverables

- Installer: `dist/soundcloud-tempo-control.user.js`.
- Source archive: `soundcloud-tempo-control-v1.0.0-source.zip`.
- Website and backend source: `site/` and `server/`.
- Workspace: `soundcloud-tempo-control.code-workspace`.

Installer SHA-256: `f6c45ac26e51ba0933dc4c1221edc70e45e5135a312e64b9b561d37ec3a749cd` (906,050 bytes). The local website download contains the same bytes. Existing installed-manager identity remains unverified. Nothing was published.

## Essential verification

The final `npm test` passed all 520 Node tests, userscript syntax, dependency integrity, embedded WASM, saved-data migration and PCM cursor checks. Windows test discovery now enumerates filenames explicitly instead of depending on shell wildcard expansion.

Type checking and the production Astro build passed. The build retains a warning for a deferred chunk above 500 kB; that warning was not suppressed.

The same installer hash previously passed 19 muted browser fixture suites and a twelve-minute real SoundCloud Preserve run at 0.025×. All 36 clock checkpoints passed; 69,134,336 continuously monitored frames had no silent frames, nonfinite samples or frame-index gaps. These tests do not prove listening quality or every installed-manager flow.

## Known limits

- Preserve key can exhibit pitch instability at extreme slowdown. Existing tone/chirp failures were not waived or hidden.
- An earlier 65 ms clock shortfall at 620 seconds remains unexplained despite the later passing run.
- Browser control disconnected before final installed-build reload/persistence and native context-menu checks. Separate-profile sharing, other audio extensions and non-Chromium platforms remain unverified.
- Website screenshots show an earlier UI build; they are not proof of the final installer's behavior. The staged live recording is 25 fps, not the requested high-frame-rate presentation.
- Hosted updates require a public site URL. PayPal is unset. Hosting, publishing and payment configuration were not performed.

## Use and publish later

Install the userscript through your existing manager. Keep its existing entry when updating to retain its settings. The application preserves its existing storage keys and migration behavior.

For the website, follow the root README: install dependencies, run backend setup, build, then start the server. Configure public URLs and donation details before publishing. Do not advertise a perfect review score or guaranteed artifact-free 0.025× preservation.

Earlier review documents retain historical acceptance gates. This handoff supersedes their statements that the local download is still the older `789a8430` artifact; it does not retroactively mark those gates passed.
