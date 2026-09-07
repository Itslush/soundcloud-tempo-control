# Changelog

## 1.0.0

First release version. Replaces the earlier 5.x development numbering.

- Natural-pitch tempo control from 0.025–4×; slider capped at 2× with 0.025× steps. Speeds below 0.25× use buffered playback on supported streams.
- Thin sliders with outlined handles on hover, keyboard focus and touch. Tempo ticks mark every 0.025× stop, aligned with the rail and fill.
- Optional Charcoal and OLED SoundCloud themes under Appearance. SoundCloud's own theme remains the default.
- Per-track tempo memory, artwork indicators and optional 50/50 playback.
- Artwork and opted-in copied-link metadata in SoundCloud's same-origin embedded track view, with navigation cleanup.
- Cover indicators also recognize tracks that use their artist's avatar as artwork.
- Track duration is read correctly for sharing and editing before playback starts.
- A compact, independently scrolling saved-speed and timeline library, search, removal undo and validated backup import/export.
- Shareable tempo timelines with adjustable fades and per-timeline pitch mode.
- Optional Preserve key using the pinned Signalsmith library, with a WASM toggle and browser fallback.
- Reused worklets, guarded restart priming and stale-update protection across pauses, seeks and track changes.
- Global output-level setting shared by both pitch modes.
- Download website with live audio preview, custom menus and an optional SoundCloud resolver backend.
- Custom numeric steppers, stable expanded-editor layout and a subtle star background. Drown (Sewerslvt Remix) is the click-to-play demo.
- Explicit Fixed speed and Timeline modes, Original comparison, undo/redo, touch-friendly graph handles and smoother reduced-motion-aware feedback.
- SoundCloud link loading through checksum-pinned yt-dlp, without API credentials. Cached requests, bounded extraction jobs and cancellation.
- Metadata-aware sharing, stream retry, HTML error pages and bounded compressed static delivery.
- Optional support page and generated release metadata.
- A dismissible notice after an installed version changes.

Previous development builds require one manual replacement with this release. Settings keep their existing storage keys. See docs/TESTING.md for verified coverage and remaining checks.
