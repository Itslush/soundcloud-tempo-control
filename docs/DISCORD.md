# Discord sharing

On a shared-track page, open **Share in Discord** and choose **Create public Discord link**. This publishes the settings contained in the incoming link, not unsaved edits in the player. Publication is explicit; opening or playing a shared page never starts a render.

The renderer downloads publicly playable audio, applies the canonical tempo and pitch timeline through the pinned Signalsmith WASM library, then combines AAC audio and a still cover into an H.264 MP4. The finished URL serves Open Graph video metadata. Opening it in a browser returns to the original shared-track page.

Discord decides whether to display a player. A valid MP4 and metadata response do not establish compatibility with every Discord client. User tests on 2026-10-10 displayed an embed but stayed at 0:00, including a second copy encoded at 30 fps with limited-range H.264. The server delivered the complete original file with HTTP 200 to requests identifying as Discordbot. This does not establish successful playback. The website controls include a notice about this failure; listeners can open the shared-track page to play in the browser. Do not describe Discord playback as fixed until a real client test succeeds.

## Limits and retention

- One render at a time, with a 15-minute deadline. A busy server asks the sender to retry; it does not build an unbounded queue.
- Six creation requests per IP per hour. IP counters remain in memory, capped at 2,048 addresses.
- Source duration up to 15 minutes; adjusted duration up to 30 minutes. The source must match the shared timeline's duration.
- Downloads up to 64 MiB of audio and 5 MiB of artwork. Only validated SoundCloud CDN HTTPS URLs are fetched; every redirect is checked. FFmpeg receives local files only.
- Progressive audio and unencrypted HLS with AAC/MP3 segments or one fragmented-MP4 initialization segment. Private, DRM, encrypted, live, preview-only and byte-range playlists are not rendered.
- Up to 64 completed jobs and 1 GiB of media, with a 48 MiB limit per MP4. The current render's temporary PCM files are additional disk use, bounded by duration.
- Links expire seven days after creation. Expired media is removed during startup, before the next render, or by the hourly idle cleanup. Direct media may remain reachable until that cleanup, and Discord may retain its own cached copy.
- Temporary files are deleted when a job finishes. Startup clears interrupted work; failed records are removed by the next cleanup so failures cannot fill the completed-job quota.

Only publish audio you have permission to share. The preview resolver still returns streams without storing audio; this separate opt-in service creates public copies.

## Oracle deployment

`deploy/tempo-shares.service` runs separately from the existing preview service, on loopback port 4324. It uses `/var/lib/tempo-shares` for state and `/opt/tempo-preview` for code. Jobs are private to the service account; completed media is readable by nginx. The unit caps memory at 220 MiB, swap at 64 MiB, CPU at 75% of one core, and tasks at 32. Worker cancellation kills the Linux process group, including extractor/FFmpeg descendants.

Required files in `/opt/tempo-preview`:

- `server/shares/`, `server/soundcloud.mjs`, `server/ytdlp.mjs`, `server/errors.mjs`
- `src/tempo-profile.js`, `src/tempo-share.js`, `vendor/signalsmith/wasm-factory.mjs`
- `scripts/config.cjs`, `release.config.json`, and the existing `.venv` extractor installation

Node 24 and FFmpeg with AAC and libx264 support are required. Set `SHARE_ORIGIN` to the public HTTPS backend origin, `SHARE_ROOT` to the state directory, and `FFMPEG_PATH` to its executable. The checked-in unit uses the existing Oracle paths. Build the website with `PUBLIC_API_BASE` pointing to the backend prefix.

Back up the existing nginx configuration before installing `deploy/tempo-https.conf`. Run `nginx -t` before reloading. Its share routes proxy to port 4324; media is served directly by nginx with range requests and a 1 MiB/s per-request limit. Keep the existing preview routes on port 4322. Enable `tempo-shares.service` after installing the unit and reloading systemd. On SELinux hosts, configure the media path as `httpd_sys_content_t` and verify an external range request; do not disable SELinux.

The deployed FFmpeg build is BtbN `ffmpeg-n9.0-latest-linux64-gpl-9.0`, reporting `n9.0.2-25-g67b60c310b-20261010`. Archive SHA-256:

```text
5866db4a35a48dd0285c7dd00e6f5024b18df65d367cc38a0b79ecb2ef4f8832
```

It was checked against the checksum from its GitHub release asset before extraction. The archive is retained on the server. Do not assume a future file under the moving `latest` release has this checksum. Binaries are installed under `/opt/tempo-ffmpeg`, not committed to this repository.

## Verification

`node --test tests/discord-render.test.mjs` covers real WASM output, stereo pitch, tempo-ramp duration, canonical validation, bounded downloads, redirected HLS, fragmented MP4 initialization, storage lifecycle, CORS and public responses. `python tests/verify-discord-share.py` checks the built website's publication, copying, polling, retry, expiry and unsafe-link rejection with intercepted API responses, plus six theme/viewport captures.

On 2026-10-10, Oracle rendered the 163.976-second public test track at 0.9× and -5 semitones. FFprobe reported a 182.199-second H.264/AAC MP4, 3,979,049 bytes. The service's recorded peak memory was 196,628,480 bytes. Public HTTPS range requests returned 206, and muted Chrome played it and sought beyond 171 seconds without a media error. This checks one live track, not every SoundCloud format or region, and not a Discord client.
