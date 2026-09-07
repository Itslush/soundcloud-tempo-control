# SoundCloud preview backend

The Node server serves `dist/site/` and uses yt-dlp to resolve publicly playable SoundCloud tracks. No SoundCloud app registration, API credentials or Artist Pro subscription is needed for this loader. It is an unofficial integration, separate from the userscript.

## Setup

Use Node 24 and Python 3.12 or newer:

```sh
npm ci --ignore-scripts
npm run setup:backend
npm run build
npm start
```

The setup command creates a project-local `.venv/` and installs yt-dlp 2026.08.19 from its checksum-pinned PyPI wheel. It does not change global Python packages. Set `PYTHON` to a Python executable path before setup if Python is not on PATH. FFmpeg is not needed because the backend only resolves stream metadata.

Open http://127.0.0.1:4322/. Play loads the default Drown (Sewerslvt Remix) track. The track disclosure accepts another SoundCloud link or local file. No track is fetched on page load. Local files work without backend setup, and failed link loading offers an explicit synth fallback.

Copy `.env.example` to `.env` only if changing server settings. Set `PUBLIC_ORIGIN` to the public website origin, `HOST` to the listen address and `PORT` to the port. No credentials belong in this file now.

`release.config.json` controls the public site URL and optional subfolder. Static files and API routes share that prefix. Do not strip it again at a reverse proxy. Rebuild after changing release configuration.

## Requests

- `GET /api/status` reports whether the project-local extractor runtime is present.
- `GET /api/resolve?url=...` returns track metadata and a temporary stream URL.

Only HTTPS SoundCloud track URLs and `on.soundcloud.com` short links are accepted. Short-link redirects are checked before following them, with at most four requests. Profiles, playlists, private-link tokens and arbitrary upstream hosts are not accepted.

yt-dlp runs with a fixed argument list, without a shell, user configuration, plugins, browser cookies, persistent caches or geo-bypass. Only its SoundCloud track extractor is enabled. Output is reduced to the fields needed for playback, capped at 512 KiB; diagnostic output is capped at 16 KiB and not exposed to visitors.

Each extraction has a 30-second process timeout and the complete request has a 35-second deadline. Concurrent requests for the same link share one extraction. Disconnecting the last caller cancels that extraction. At most four distinct extraction jobs run at once. Track details are cached for 60 seconds with a 128-entry cap. No audio files are written.

Audio streams directly from SoundCloud's playback CDN to the browser. Returned URLs are restricted to HTTPS `*.sndcdn.com` and `playback.media-streaming.soundcloud.cloud`. HLS buffering is bounded independently of track length. Available preview excerpts are labelled as previews.

The HTTP surface permits eight concurrent resolver requests and 20 requests per minute per socket IP. It does not trust forwarded IP headers. Behind a proxy, visitors may share that quota; configure trusted proxy rate limiting before wider deployment. Limits and metadata are in memory per server process.

## Verification and deployment

Static delivery returns the built HTML error page for missing document paths and JSON for API errors. It checks resolved paths, including symlinks, before serving a file. `HEAD` responses have no body.

Compressible assets support Brotli and gzip with four concurrent compression jobs, 64 KiB stream chunks and an 8 MiB per-file limit. Compression streams without retaining an asset-content cache. Requests negotiate quality weights, exclusions and identity fallback; unsupported representations return 406. Saturated compression can use identity when allowed, otherwise 503.

Responses include representation-specific weak ETags, Last-Modified and Vary. Hashed assets are immutable; mutable files revalidate. Missing pages are not cached. `npm run test:transfer` measures actual compressed initial assets and image crops separately, with deferred audio and full-resolution viewers excluded from the initial budget.

`npm run test:server` runs offline resolver, process-lifecycle and HTTP tests. With the backend running, `python tests/verify-live-track.py` checks a public track in muted Chromium, including nonzero audio output, 0.75× speed, WASM key preservation and seeking. `TEST_TRACK_URL` optionally selects another public test track.

Use an HTTPS host capable of running Node and Python. A static-only host can serve the website but cannot run yt-dlp. Serve only `dist/site/`, never the repository or `.venv/`.

SoundCloud can change its web endpoints or restrict tracks. The pinned yt-dlp release needs periodic compatibility checks. Update the version and wheel SHA-256 in `server/requirements.txt`, rerun setup and repeat the live test before updating a deployment. Setup and startup do not silently upgrade yt-dlp.

Local playback was verified with NASA's public test track and the default Drown (Sewerslvt Remix) demo. Set `TEST_DEFAULT_TRACK=1` for the default-track check. This does not establish that every track, region or hosting provider will work. Deployment checks still include preview-only tracks, real short links, expired stream URLs, longer sessions and SoundCloud's applicable terms.

References: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [SoundCloud extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/soundcloud.py), [pinned PyPI release](https://pypi.org/project/yt-dlp/2026.8.19/). yt-dlp's PyPI wheel is licensed under the Unlicense; its license is included in the installed distribution.
