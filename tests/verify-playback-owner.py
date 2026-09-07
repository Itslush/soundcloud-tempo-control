import hashlib
import json
import argparse
import os
import subprocess
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options
from worklet_fixture import build_worklet

MODULES = ['playback-owner', 'buffered-transport', 'transport-lifecycle', 'media-facade', 'playback-gate', 'pcm-window', 'natural-output', 'rate-clock', 'preserve-output', 'preserve-worklet']
FILES = {f'/{name}.mjs': ROOT / f'src/audio/{name}.mjs' for name in MODULES}
FILES.update({
    '/worklet.js': build_worklet(),
    '/capture.mjs': ROOT / 'tests/fixtures/test-capture.mjs',
    '/probe.js': ROOT / 'tests/fixtures/playback-owner-probe.js',
})
LEGACY = [ROOT / f'src/{name}.js' for name in ['tempo-dependency', 'tempo-output', 'tempo-wasm']]


def legacy_source():
    compiled = subprocess.run(
        [os.environ.get('NODE', 'node'), '-e', "process.stdout.write(require('./tests/module-fixture.cjs')(['tempo-dependency.js', 'tempo-output.js', 'tempo-wasm.js']))"],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=30,
    ).stdout
    start = '''globalThis.installOwnerGraphFixture = (audioModules) => {
        const references = new Set();
        const ui = null;
        const useWasm = false;
        const bufferedAudio = null;
        let updates = 0;
        function preservesKey() { return false; }
        function updateAll() { updates++; }
        function discover(audio) { references.add(new WeakRef(audio)); outputLevel.attach(audio); }
        function apply(audio) { wasmAudio.sync(audio, false, audio.playbackRate); }
    '''
    end = '''
        const outputLevel = createOutputLevel({references, readUI: () => ui});
        const wasmAudio = createWasmAudio({audioModules, outputLevel, createStretchNode, preservesKey,
            readUseWasm: () => useWasm, references, updateAll, apply, discover, onGraphReady() {}});
        return { outputLevel, wasmAudio, hostState: () => ({ updates, references: references.size }) };
    };'''
    return (compiled + '\n' + start + end).encode()


def main():
    cases = [('natural', 48000, 48000), ('preserve', 48000, 48000), ('natural', 44100, 96000), ('preserve', 44100, 96000)]
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['-'.join(map(str, case)) for case in cases])
    options = parser.parse_args()
    if options.case:
        cases = [case for case in cases if '-'.join(map(str, case)) == options.case]
    sources = {file: file.read_bytes() for file in [*FILES.values(), *LEGACY, ROOT / 'tests/verify-playback-owner.py']}
    assets = {url: sources[file] for url, file in FILES.items()}
    assets['/legacy.js'] = legacy_source()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Generated stereo PCM and native WAV media through the real playback owner, facade, PCM window, Natural/Preserve renderers, and unmodified tempo-output/tempo-wasm graph seam. Host callbacks and source association are fixture adapters. No production bridge, live SoundCloud, decoded network source, continuous PCM isolation, or musical-quality claim.',
        'audio': 'Isolated muted Chromium with a permanent zero-gain destination',
        'sourceSha256': {file.relative_to(ROOT).as_posix(): hashlib.sha256(data).hexdigest() for file, data in sources.items()},
        'servedSha256': {url: hashlib.sha256(data).hexdigest() for url, data in assets.items()},
        'cases': [],
        'requestedCases': cases,
        'status': 'INCOMPLETE',
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            data = b'<!doctype html><title>Muted playback owner integration</title>' if self.path == '/' else assets.get(self.path)
            if data is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/html' if self.path == '/' else 'text/javascript')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
            report['browser'] = browser.version
            try:
                for mode, source_rate, output_rate in cases:
                    page = browser.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    try:
                        page.goto(f'http://127.0.0.1:{server.server_port}/')
                        page.add_script_tag(url='/legacy.js')
                        page.add_script_tag(type='module', content='''
                            import {createPlaybackOwner} from '/playback-owner.mjs';
                            import {createPlaybackGate} from '/playback-gate.mjs';
                            import {createPcmWindow} from '/pcm-window.mjs';
                            import {createNaturalOutput} from '/natural-output.mjs';
                            import {createPreserveOutput} from '/preserve-output.mjs';
                            import {encodeWave} from '/capture.mjs';
                            Object.assign(globalThis, {createPlaybackOwner, createPlaybackGate, createPcmWindow, createNaturalOutput, createPreserveOutput, encodeWave});
                        ''')
                        page.wait_for_function('typeof createPlaybackOwner === "function"')
                        page.add_script_tag(url='/probe.js')
                        result = page.evaluate('playbackOwnerProbe', {'mode': mode, 'sourceRate': source_rate, 'outputRate': output_rate})
                        result['pageErrors'] = errors
                        if errors:
                            result['status'] = 'INCOMPLETE'
                        report['cases'].append(result)
                        print(json.dumps({'mode': mode, 'sourceRate': source_rate, 'outputRate': output_rate, 'status': result['status'], 'error': result.get('error'), 'pageErrors': errors}), flush=True)
                        if result['status'] != 'PASSED':
                            break
                    finally:
                        page.close()
                if len(report['cases']) == len(cases) and all(case['status'] == 'PASSED' for case in report['cases']):
                    report['status'] = 'PASSED'
            finally:
                browser.close()
                report['browserClosed'] = True
    except Exception as error:
        report['error'] = {'name': type(error).__name__, 'message': str(error)[:3000]}
    finally:
        server.shutdown()
        server.server_close()
    output = ROOT / 'test-results/playback-owner.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'cases': len(report['cases']), 'file': str(output), 'error': report.get('error')}))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
