# Website copy and donations QA

Scope: local website copy, README, changelog and the new donation disclosure. Existing userscript and backend work is outside this review. This is not a live-release or live-audio certification.

## Result

Build and TypeScript checks passed. `verify-site.py`, `verify-site-presentation.py` and `verify-pitch-automation.py` passed against the built local assets. The build still reports its existing large-chunk warning.

The userscript SHA-256 remains `f994fd0bda1ec3db4a73a409fbd241c2623cfab7b5f92dd0737adf2d3ace4962`. No userscript behavior changed in this task.

## Evidence

- `verify-site.py` checked four content routes at 320, 360, 390, 768 and 1440 px. Local links resolve and screenshot assets decode.
- All five donation addresses and networks matched independent test literals copied from the user's request. Keyboard activation copied the exact address, including letter case.
- Copy buttons have at least 44 px targets, visible keyboard outlines and text contrast of at least 4.5:1. Address, network and result text passed the same contrast check.
- Clipboard rejection shows manual-copy instructions and leaves the button usable. A retry succeeds. A pending copy disables the button and reports its state.
- With JavaScript disabled, all five addresses remain visible and copy buttons stay hidden. The install link still downloads the exact local userscript artifact.
- `verify-site-presentation.py` checked sticky navigation, anchors, motion preferences, forced colours, demo controls and deferred audio loading at four widths on five routes.
- `verify-pitch-automation.py` checked the shared-link page, including its updated invalid-link message, and the existing pitch/editor fixture behavior.
- Inspected donation screenshots at 320, 390 and 1440 px. Full addresses wrap without horizontal overflow. Captures are in `test-results/donations-{width}.png`.
- `/support/` still returns 404. No PayPal link was added.

## Anti Slop delivery gate

This gate covers the changed copy and donation component. Existing site direction remains ENERGY 1, RHYTHM 2, MOTION 2, with charcoal surfaces, orange controls, Mulish and the requested stars.

- R-02 PASS: changed public copy contains no em dashes.
- R-03 PASS: built pages and expanded donation rows have no horizontal overflow at the five tested widths.
- R-17 PASS: no usage, performance or adoption statistics added.
- R-18 PASS: no testimonials added.
- R-23 PASS: existing branding and navigation retained; the donation disclosure implements the user's request without new illustrative assets.
- R-24 PASS: local website links resolve in the route checks.
- R-25 PASS: donation text and button labels meet 4.5:1 contrast in the rendered component.
- R-26 PASS: the disclosure opens by keyboard and all five buttons copy their displayed address.
- R-27 PASS: pending, copied and denied clipboard states tested; no-JavaScript visitors can select addresses manually.
- R-28 PASS: no generic FAQ introduced.
- R-32 PASS: keyboard focus, Enter activation and visible outlines tested for the new controls.
- R-33 PASS: component markup, styles and behavior are authored in source; no external runtime styling patch.
- R-34 PASS: no new theme toggle; existing site forced-colour checks pass.
- R-35 PASS: production build completed and every new interactive control was exercised.
- R-36 PASS: no security, compliance or audio-quality guarantee added.
- R-37 PASS: the existing DESIGN.md supplies direction; the donation treatment and direct tone are recorded there.
- R-38 PASS: addresses come from the user, and the network labels follow their Etherscan clarification. No invented author story or wallet verification claim.
- R-01 PASS: no gradient or glow added.
- R-04 PASS: only a functional disclosure chevron added; the existing stars remain the user's motif.
- R-06 PASS: site typography retained; monospace is limited to addresses for character inspection.
- R-07 PASS: no decorative background pattern added.
- R-08 PASS: the chevron indicates disclosure state rather than decorating a call to action.
- R-09 PASS: no badges added.
- R-10 PASS: no glass effects added.
- R-12 PASS: no shadows added.
- R-13 PASS: no glowing decoration added.
- R-14 PASS: address rows use one repeated data layout, not feature cards.
- R-19 PASS: existing motion retained; donations add no attention-seeking animation.
- R-22 PASS: no generic illustrations added.
- Liveliness PASS: the existing editor remains the focal point; donations are secondary and collapsed. Orange, stars and the compact music-tool layout retain the established identity. Row spacing separates currency, network, address and action.
- C-1 PASS: existing buttons and colours are reused; the layout makes the requested addresses readable.
- C-2 PASS: keyboard, success, pending and failure behavior verified for the donation controls.
- C-3 PASS: the only new section is the requested donation list.
- C-4 PASS: mobile wrapping, keyboard operation and no-JavaScript use tested.
- C-5 PASS: no fabricated claims or anecdotal evidence added.
- R-05 PASS: no marketing-template sections introduced.
- R-11 PASS: existing small-radius buttons retained.
- R-15 PASS: new actions use Donate and Copy address; README installation heading is explicit.
- R-16 PASS: changed copy has no promotional superlatives or marketing claims.
- R-20 PASS: the existing timeline preview and SoundCloud examples retain the site's product-specific composition.
- R-21 PASS: charcoal styling follows the established user direction.
- R-29 PASS: no new colour palette added.
- R-30 PASS: existing site layout retained, with no borrowed SaaS layout.
- R-31 PASS: opaque rows preserve readability over stars, narrow layouts wrap addresses, and a collapsed section keeps installation primary.

## Maintainability review

The component owns its five addresses, rendering and clipboard feedback. The shared layout includes it once. No payment SDK, configuration layer, backend route or dependency was added. The clipboard copies rendered text rather than a second address attribute, avoiding disagreement between what visitors see and copy. No file crossed 1,000 lines as a result of this task.

## Not checked

No transfer was sent and wallet ownership or on-chain status was not verified. Ethereum labels use the user's Etherscan link, not an inferred network from the address format. No live SoundCloud audio test, GitHub push, deployment or TCD backend change was performed.

## Release follow-up: 1.1.0

The user subsequently requested publication. The release version was raised to 1.1.0 so installed 1.0.0 copies can detect an update. Release artifact SHA-256: `873c589eaa5684b146ba2550344ebc285cc8a816d0638773b70c461cd34d8600`.

Before pushing, 559 unit tests, 23 muted browser suites, 34 server tests, TypeScript, the release build, transfer budgets and both website suites passed. The token/private-key pattern scan found no matches in the pending project content. This is a limited pattern check, not a security audit.

Two unresolved checks remain. The existing Oracle preview endpoint timed out during a 15-second HTTPS status request. The separate screenshot-provenance check fails with `Expected one standalone audio bundle`, because its parser expects the older bundle layout. Neither check was weakened or marked passing. The backend was not changed.
