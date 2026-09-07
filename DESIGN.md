# Design

## Identity

Preserve the charcoal SoundCloud-style surface, orange cloud/waveform/slider logo, small corner radii and flat controls. The website uses locally hosted Mulish. The userscript inherits the player's font and foreground colour.

Use orange `#ff5500` for interaction accents, selected nodes and playback. On SoundCloud, read the progress bar's current accent so themes remain consistent. Tempo and playback rails use the same 2 px thickness and centerline. Ticks sit below the tempo rail without shifting it.

Tempo rulers use one SVG coordinate grid with evenly spaced tick centers spanning the thumb's center-to-center travel. Keep stroke widths constant as the control resizes. The userscript marks every 0.025× stop, with longer 0.05× and 0.25× marks. All range controls use a 2 px rail and a 12 px outlined circular thumb. The rail, fill and tick centers share the same 6 px inset. On a mouse, the thumb appears on hover, keyboard focus or dragging; it stays visible on touch-capable devices and in forced colours. Only opacity changes, never thumb size or travel. Programmatic value changes update the fill too. Graph nodes remain visible.

Timeline close zoom uses rounded bounds and a 0.1× grid; closer zoom uses 0.05×. Do not generate axis labels by evenly dividing arbitrary bounds. The website demo defaults to the explicitly selected Drown (Sewerslvt Remix). Do not add other personal listening references.

Website tokens live in `site/src/styles/site.css`. Controls use a distinguishable border rather than relying only on colour or hover. Focus remains visible in keyboard navigation and forced-colour modes.

## Website

The opening pairs a short introduction and installation action with an interactive timeline. Playback controls appear before the graph. Playback is explicitly started by the visitor at a low initial volume. The graph, time readout, seek control and tempo value reflect actual audio state.

Fixed speed and Timeline are explicit modes. Keep the current playback rate separate from the selected point's target. Original comparison is temporary and preserves both the listening position and edits. Editing offers undo, redo and reset without adding controls to the SoundCloud header.

Custom pitch menus visibly identify Pitch, expose the selected value, support keyboard navigation and close on Escape or outside interaction. Closed choices are inert. Point timing and track loading are secondary disclosures. The native select remains available without JavaScript.

Number fields share SVG minus/plus buttons with 44 px targets, tabular centered values, direct typing and keyboard stepping. Native number spinners are hidden. Point timing uses 0.1-second steps and speed uses 0.025× steps. Button limits follow the selected point.

The brand and navigation form a full-width sticky header with an opaque surface and a single bottom divider. Anchor destinations clear the header. The introduction stays top-aligned when the editor expands. Desktop copy remains sticky below the header; mobile copy returns to normal flow.

A sparse, static SVG starfield spans the entire page. Vary small rays, diamonds and paired stars, with subtle warm and cool tones. Do not use glow, haze or blur. Keep cards opaque and the orange accent unchanged. Stars are decorative, ignore pointer input and disappear in forced-colour mode.

The default track loads only after Play is pressed, at the existing low volume. Failed loading offers an explicit synth fallback. Do not silently substitute audio or fetch the default song on page load.

Real screenshots appear in four focused sections with full-resolution viewers. Use the explicitly selected Drown track for public examples, including its saved speed and timeline. Keep captures proportional. Reserve their space while loading, show a restrained skeleton, and provide a retry path if loading fails. Never redraw screenshots as if they were live product evidence.

Layouts stack on narrow screens. Long track titles truncate without covering transport controls. Website controls, graph hit regions and secondary navigation links have at least 44 px targets. Graph handles capture dragging while the rest of the graph permits vertical page scrolling. The compact SoundCloud footer retains the host client's density.

The userscript settings contain the saved-tempo library and backup controls. Use compact single-line rows with a track link, enabled checkbox, speed or Timeline control and removal button. Keep both settings together when a track has both. Preserve full accessible names and removal undo without repeating visible On/Off labels. The bounded list scrolls separately from search and the collapsed audio, shortcuts and backup sections. Import replacement is previewed and confirmed before changing storage.

Retain the same orange rather than introducing a second accent for text. Selected website modes use dark backgrounds. The footer speed value and × share the inherited foreground without a changed-value background. Right-align the number in its fixed slot with a 2 px gap before the unit. Native primary text controls retain `#242424`, with `#282828` on hover, including the light player theme.

SoundCloud appearance is optional: SoundCloud preserves the host theme, Charcoal uses the homepage's `#111` ground and `#202020` panels, and OLED uses `#000` and `#0b0b0b`. The custom themes share the existing orange, muted text and static starfield. Keep host layout, artwork, waveforms and interaction behavior intact. Apply scoped semantic colour tokens rather than global image filters or hashed component selectors. Validated same-origin track frames follow the preference; authentication and third-party frames do not. Returning to SoundCloud removes owned styles and restores owned attributes. The setting is local and synchronizes across tabs; a failed save reports that it applied only to the current tab.

## Copy and motion

Use short functional labels and neutral statements. Do not add routine selection hints, mode narration, screenshot captions or instructions that repeat visible controls. Preserve accessible names and nonvisual keyboard guidance. Show status text only when it communicates useful loading, success or error feedback. Avoid sales claims, em dashes and long hover descriptions. Error text explains the next useful action. Donations stay optional and do not gate functionality.

Shared motion tokens use 120 ms for quick feedback, 200 ms for entrances and 100 ms for exits. Menus, supported native disclosures and image viewers reverse cleanly during repeated interaction. Skeletons pulse gently. Reduced motion removes spatial movement and pulsing while retaining immediate state changes and focus visibility. Do not animate inactive playback or redraw the graph for every playhead update.
