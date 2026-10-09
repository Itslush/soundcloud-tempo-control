# Changelog

## 1.1.0

If you have a 5.x development build, install this version manually once and
disable the old copy. Your saved settings stay in place. Installed 1.0.0 copies
can update through the userscript manager.

### Playback and controls

- Adjust speed from 0.25× to 4×. The horizontal slider stops at 2×; the number field, dial and vertical slider reach 4×.
- Choose a control style on first install or in Appearance. Set the default tempo increment and show or hide semitone adjustment.
- Shift pitch by semitones, with your own range and increment. Preserve key separates pitch from speed when audio processing is available.
- Save speeds for individual tracks. The bookmark and artwork show which tracks have saved settings.
- Draw tempo and pitch changes on a timeline, with gradual fades or instant changes. Preview once or save for later.
- Share settings in a link. The preview lets you apply them once or save them without replacing anything automatically.
- Search saved tracks, undo removals and export a backup for another browser.
- Choose SoundCloud, Charcoal or OLED styling. Toggle star motion or change its speed.
- Set output gain in decibels. Optional crossfade preloads the next track when its stream is available; unsupported streams play normally.

### Website

- Preview a track with fixed speed or a timeline. Compare with the original, edit points and undo changes.
- The default demo is Drown (Sewerslvt Remix). It loads after you press Play.
- Setup, sharing and troubleshooting instructions are in the guide.
- Optional crypto donations list the address and network for each currency.

### Development details

- Audio processing uses bundled Signalsmith and Mediabunny libraries. Browser pitch correction remains available as a fallback.
- Audio processing handles pauses, seeks and track changes without recreating a worklet for every action.
- Copied-link settings and artwork indicators also work in supported embedded SoundCloud track views.
- The website's optional track resolver uses pinned yt-dlp with request caching, job limits and cancellation.
- Shared previews include track metadata. Stream requests can retry, and the server returns HTML error pages and compressed static files.
- Userscript updates show a dismissible notice when the installed version changes.

See docs/TESTING.md for coverage and remaining checks.
