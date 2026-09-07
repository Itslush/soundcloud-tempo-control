# Third-party licenses

The project's own code is licensed under [MIT](LICENSE). Dependencies retain their separate licenses.

## Signalsmith Stretch

- Author: Geraint Luff / Signalsmith Audio Ltd.
- License: MIT, not MPL 2.0.
- Pinned revision: `57b93f4e9206a089a45387eaa39bdc9f310d3308`.
- [Complete license](vendor/signalsmith/LICENSE.txt).
- [Pinned source](https://github.com/Signalsmith-Audio/signalsmith-stretch/tree/57b93f4e9206a089a45387eaa39bdc9f310d3308).
- [Artifact checksum and provenance](vendor/signalsmith/signalsmith.json).

The upstream JavaScript release includes its WASM payload. Our buffered AudioWorklet adapter uses that pinned engine; it does not transfer ownership of the upstream code or remove its notices.

## Mediabunny

- Author: Vanilagy.
- Version: 1.55.7.
- License: Mozilla Public License 2.0.
- [Complete license](vendor/mediabunny/LICENSE).
- [Versioned source package](https://registry.npmjs.org/mediabunny/-/mediabunny-1.55.7.tgz).
- [Package integrity and attribution](vendor/mediabunny/NOTICE.md).

The project bundles unchanged upstream module exports with esbuild. Its versioned source package includes the corresponding source files and notices. MPL-covered files retain their license when distributed alongside this project's MIT code.

## Website media and fonts

Mulish 5.3.0 is distributed through `@fontsource-variable/mulish` under the SIL Open Font License 1.1. Copyright belongs to the Mulish Project Authors. HLS.js 1.7.2 is Apache-2.0 licensed, with its upstream copyright notices. Their complete notices are included by the website build; `docs/ASSETS.md` records their use.

Screenshots, the selected SoundCloud track and its artwork are not relicensed under MIT. See [asset provenance](docs/ASSETS.md) for ownership and redistribution limits. Dependency versions are pinned in `package-lock.json`; distributed dependency notices must be retained when packaging the website or extension.
