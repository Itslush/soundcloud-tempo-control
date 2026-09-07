# Signalsmith dependency

`SignalsmithStretch.js` is the untouched upstream UMD release at the exact Git revision in `signalsmith.json`. Its MIT license is retained in `LICENSE.txt`. The lock records its source URL and SHA-256. The build and tests never replace this file with an unpinned download.

The source build imports this pinned file through esbuild. Both the userscript and website engine validate its checksum before building. New candidate metadata has no `@require`; the upstream WASM payload is bundled with the native-rate engine. Previously generated public downloads have not yet been replaced.

Bundling does not remove the engine's parsing, compilation, memory or processing costs. The library and its embedded WASM bytes remain pinned and unmodified.

`src/tempo-dependency.js` adapts the upstream factory to release internally created worklet blob URLs after loading. It restores the original `addModule` method immediately and never releases a caller-supplied module URL. Native-rate preservation uses live input. Buffered playback below 0.25× uses the separate transport and processor under `src/audio`.

The buffered processor is compiled separately by esbuild and loaded as a local blob asset. `wasm-factory.mjs` contains the unchanged first top-level factory declaration from the pinned upstream release, followed by a default export. `wasm-factory.json` records both checksums and the derivation. This vendored module boundary avoids extracting upstream source during production playback; it does not change the Emscripten factory or WASM binary. The MIT license applies to this excerpt as well.

Mediabunny is bundled from its pinned npm module exports and initialized lazily without a network loader. The runtime worklet-assembly compatibility path has been removed. Standalone renderer, transport and owner fixtures consume the same compiled worklet artifact; its content-addressed JavaScript and original-source map are emitted alongside playback candidates.

`tests/userscript_fixture.py` injects the vendor file only for historical artifacts containing `@require`. Bundled candidates execute without that fixture dependency injection. Isolated browser checks do not establish installation inside Violentmonkey.

A future Chrome Manifest V3 extension must package its executable JS/WASM within the extension. Do not carry the CDN-loading arrangement into that extension.

Sources: [upstream repository](https://github.com/Signalsmith-Audio/signalsmith-stretch), [Violentmonkey @require](https://violentmonkey.github.io/api/metadata-block/#require), [Chrome remote-hosted-code rules](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).
