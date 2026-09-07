# Releasing

Nothing is hosted or pushed by this repository's build commands.

## Configure once

Edit `release.config.json`:

- `siteUrl`: public HTTPS website root, including a repository subdirectory when needed, e.g. `https://your-domain.example/tempo/`. This is documentation only, not a configured destination.
- `paypalUrl`: your direct `https://paypal.me/...` or `https://www.paypal.com/...` link. Optional; when empty the support page says donations are not set up and has no payment button.
- `repositoryUrl`: optional public repository/help destination. No account or URL is inferred.

Keep the public download location stable. It is embedded in every installed userscript.

## Build a release

1. Update `package.json`'s version and `CHANGELOG.md`. Versions must increase after 1.0.0; use 1.0.1 for a patch. Run `npm install --package-lock-only --ignore-scripts` to synchronize the lockfile version.
2. Run `npm test`, `npm run typecheck`, `npm run test:server`, `npm run test:browser` and the website checks in TESTING.md. Build before website checks, then run `npm run test:transfer` against that output.
3. Run `npm run release`. Missing siteUrl causes a build error; no fake production update endpoints are emitted.
4. Preview and inspect `dist/site/`, including its download files. For SoundCloud link previews, deploy to a Node and Python host, run `npm run setup:backend`, then `npm start`. See BACKEND.md. A static host can serve `dist/site/` with only the synth and local-file preview. Publish the website and downloads together.
5. Verify the HTTPS install link and metadata endpoint with a real userscript manager. Install into a test profile, publish a higher test version, run the manager's update check, then reload SoundCloud and verify the notice once.

Serve `.user.js` and `.meta.js` as JavaScript/text, not HTML fallback pages. Avoid immutable caching on `/downloads/`; set a short TTL or revalidation on the host. `release.json` and `SHA256SUMS.txt` identify the exact generated artifact.

## Updates

The public build supplies `@downloadURL` and `@updateURL`. Violentmonkey uses its own automatic/manual checks; users can disable them in the manager. The script adds no network poll and cannot override a user's update preferences. On the next SoundCloud load after a changed installed version, it shows a dismissible notice with a release-notes link. First installs are quiet. Site storage can be cleared or blocked, which also resets or suppresses this acknowledgement.

Local builds omit public URLs. They are for preview and manual testing, not public update distribution. Once hosting is configured, reinstall the hosted copy once to acquire its stable update URL.

The old 5.x development number is higher than 1.0.0. Automatic updaters will not downgrade it. Manually replace the existing script once; do not run both. The name, namespace and settings keys stay the same.

Reference: [Violentmonkey metadata](https://violentmonkey.github.io/api/metadata-block/#downloadurl).
