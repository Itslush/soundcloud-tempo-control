# Development

These instructions are for contributors running the website and backend on their own machine. To use the app, visit [the website](https://itslush.github.io/soundcloud-tempo-control/).

## Run locally

Use Node 24, npm and Python 3.12 or newer. Open `soundcloud-tempo-control.code-workspace` in your editor, then:

```sh
npm ci --ignore-scripts
npm run setup:backend
npm run build
npm start
```

Open http://127.0.0.1:4322/. SoundCloud links load through yt-dlp without API credentials. Backend setup installs a pinned version in a local Python environment. The synth sample and local audio preview also work without that setup. See [backend setup](docs/BACKEND.md).

Press Play to load the default Drown (Sewerslvt Remix) demo. It does not fetch or play on page load. If loading fails, the demo offers a synth sample instead. Use the track disclosure to choose another SoundCloud link or local file.

`npm run dev` starts the Astro development site. `npm start` serves the built site and API together. Rebuild after changing source. No command publishes the project.
