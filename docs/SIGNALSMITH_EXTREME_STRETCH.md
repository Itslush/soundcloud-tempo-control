# Extreme-stretch diagnostic

Status: unresolved. This is a reproducible investigation, not a claim that all low-rate failures share one cause.

## Reproduction

From the repository root:

```sh
node tests/inspect-wasm-resolution.mjs
python tests/verify-preserve-output.py --chirp-only --capture-pcm
python tests/analyze-pitch-windows.py test-results/<preserve-output-report>.json
```

The first command uses the pinned WASM directly, without a browser, transport, decoder, audio destination or wall-clock scheduling. The second uses the actual Preserve worklet and retains bounded output PCM even on failure. Python needs Playwright and NumPy for these diagnostics. Neither command updates public artifacts.

## Evidence

- `wasm-resolution-1788790263922.json`: four fresh tone/chirp pairs for each 120, 60, 30 and 15 ms block. Quarter-block intervals, 48 kHz, 0.025×. Respectively 6/8, 7/8, 6/8 and 4/8 satisfy the original diagnostic bounds. No configuration passes every case.
- `preserve-output-20260907T140911353174Z.json`: real worklet chirp slope 68.277 Hz/s, outside the unchanged 75–125 range. Output PCM and its absolute first render frame are retained.
- Its companion `-pitch-analysis.json` measures six overlapping PCM windows. Zero-crossing estimates and spectral peaks vary in the rendered samples themselves. Browser analyser snapshot timing cannot be the sole explanation for that variation.
- Earlier direct-WASM streaming-input and synthetic-prehistory controls also varied. Removing repeated seek calls or startup padding alone did not establish a reliable remedy.

Reports reside in `test-results/`. Their hashes and source provenance must accompany any shared reproduction; the results are observations, not statistical pass rates.

## Upstream mechanism

The pinned revision is `57b93f4e9206a089a45387eaa39bdc9f310d3308`. Its [seek implementation](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/57b93f4e9206a089a45387eaa39bdc9f310d3308/signalsmith-stretch.h#L129) derives a stretch factor from the playback-rate hint. At 0.025× with a 1440-frame interval, that factor is approximately 40.

The internal [clean-stretch threshold is 2](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/57b93f4e9206a089a45387eaa39bdc9f310d3308/signalsmith-stretch.h#L477). Above it, [spectral prediction uses randomized frequency offsets](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/57b93f4e9206a089a45387eaa39bdc9f310d3308/signalsmith-stretch.h#L595). Fresh instances are randomly seeded. This establishes an intentional source of output variation at the requested rate, not proof that disabling it would improve music or satisfy every acceptance test.

The adapter's history length and latency alignment match the documented seek contract. Changing the supplied rate hint to conceal the actual stretch, selecting a favorable random seed, or loosening the tests would not establish a fix.

## Next discriminating comparison

An API-level control is now available with `node tests/inspect-wasm-resolution.mjs --phase-hint-control`. It retains the actual 0.025× PCM positions but deliberately supplies a 0.5 seek hint. Upstream code maps that hint to a prediction factor of 2, avoiding randomization. This changes the factor as well as randomization, so it does not isolate the randomization branch alone and must not be silently integrated.

`test-results/wasm-resolution-1788791284755.json` records four fresh instances for each tone/chirp condition. The original hint produced four different hashes per signal. The control produced one hash per signal, a stationary-tone estimate of 960.000602 Hz, and a chirp slope of 107.544322 Hz/s. Both groups happened to satisfy all eight original diagnostic bounds in this run; previous failures remain relevant. The control demonstrates reproducibility under that intervention, not general musical quality or a production-ready remedy.

The native C++ comparison now exists in `tests/inspect-stretch-threshold.cpp`. It uses four explicit seeds, the same PCM schedule, the true 0.025× hint and identical compiler options for both variants. Source is isolated under ignored `test-results/signalsmith-threshold-source`, at the pinned revision, with Signalsmith Linear 0.3.1 (`5668673560146a9cfe38c25315071e3fd68c8317`). The diagnostic header changes only `maxCleanStretch{2}` to `{64}`. The production vendor is untouched.

Reports `stretch-threshold-original-20260907T143103556836Z.json` and `stretch-threshold-clean-20260907T143108409336Z.json` retain binary, header and probe hashes, source/dependency commits and the exact source diff. The original results vary by seed. The modified build produces the same measurements across all four seeds: stationary tone 959.986881 Hz and chirp slope 95.199386 Hz/s. Both groups satisfy all eight bounds in this native run; this is not proof that the original failure always occurs. It supports the randomization explanation for seed-dependent variation under the unchanged true hint.

The comparison was compiled with the existing Visual Studio toolchain, using `tests/build-stretch-threshold.cmd <VsDevCmd.bat> original` before the isolated header edit and the same command with `clean` afterward. `tests/run-stretch-threshold.py original` and `clean` write unique reports. This native build is not bit-equivalent to the bundled WASM, and the original upstream compilation toolchain version was not pinned in its build script. WASM and musical-content checks remain necessary before integration.

The upstream constant also sets the minimum prediction factor for accelerated playback. A production change must separately evaluate that effect at faster rates; the current 0.025× experiment does not cover it. A deterministic but inaccurate output is not an improvement.

This audio-quality investigation is separate from the earlier AudioContext/wall-clock divergence. The native callback trace and continuous live-output run address that timing question independently.

## WASM comparison setup and first matrix

Emscripten 3.1.64 is installed only under ignored `test-results/emsdk-diagnostic`, SDK repository revision `0b3bcbc3b005cbb811d48e497eabcc6846d43001`. Activation was not permanent or system-wide. `tests/build-stretch-wasm.py` compiled both variants with the same flags and ESM single-file output. The original header was restored in the isolated source checkout after compiling the modified version. Build manifests in `test-results/stretch-wasm-{original,clean}/build.json` record compiler version, arguments, source diff and hashes.

The modified factory SHA-256 is `0d18abb6aa20fe0049e0f75bf598abf53ddbe2b37586f24bce6377ef18d1d3f3`. Its diagnostic worklet is `9e79e29deecd95d4e9c438872f1a04d199334c915eaa7232a104941245ecb75e`. `test-results/preserve-output-20260907T143513938960Z.json` passed 14/15 real-worklet cases. The last 44.1-to-48 kHz, 0.025× chirp failed with slope 74.721919 Hz/s. The 48-to-96 kHz, 0.025× stationary tone passed narrowly at 967.786448 Hz. No threshold was loosened. At that latter sample-rate ratio the effective stretch is 80×, above the experimental threshold of 64, so that case still permits phase randomization.

The earlier `preserve-output-20260907T143428871557Z.json` is not this variant: an ESM-to-IIFE packaging warning prevented variant creation and the shell continued into the default worklet test. That report identifies the default worklet hash and remains excluded from the modified-library comparison. The diagnostic packager now retains ESM, which AudioWorklet supports, and the invocation stops on build failure.

No production library, metadata lock, download or installed userscript has been updated. The modified library is not accepted. Its direct-WASM configuration report is `wasm-resolution-1788791644549.json`; that narrow control does not replace the failing mixed-sample-rate browser case.

## Same-compiler upstream control

`preserve-output-20260907T143705567546Z.json` passed all 15 real-worklet cases with the unmodified header rebuilt using the same Emscripten 3.1.64 toolchain. Factory hash: `c14c5464daf5dd2e426560117cd2ae2fb2df3f5b49f1432d533f923f8bac4d1c`. Diagnostic worklet hash: `c93ec8b5f328c826b8c2c6aa92335223b96a309b936a7ac12afb8568e11c3ad0`. This is one passing run of a variable-output algorithm, not evidence that historical failures are fixed by recompilation.

Decision: do not integrate the threshold fork. Its deterministic native-tone result and 14/15 browser result do not demonstrate a reliable overall improvement over the matched upstream control. Preserve the original library and failed reports. The mixed-rate failure is associated with that condition; its cause has not been isolated sufficiently to justify replacing the sample-rate conversion path. No new resampler should be introduced on that assumption alone.
