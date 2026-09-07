import argparse
import hashlib
import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options
from worklet_fixture import build_worklet

FILES = {
    '/preserve-output.mjs': ROOT / 'src/audio/preserve-output.mjs',
    '/preserve-worklet.mjs': ROOT / 'src/audio/preserve-worklet.mjs',
    '/rate-clock.mjs': ROOT / 'src/audio/rate-clock.mjs',
    '/worklet.js': build_worklet(),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            data = b'<!doctype html><title>Muted Preserve-key diagnostic</title>'
            content_type = 'text/html'
        elif path in FILES:
            data = FILES[path].read_bytes()
            content_type = 'text/javascript'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--chirp-only', action='store_true')
    parser.add_argument('--capture-pcm', action='store_true')
    options = parser.parse_args()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Standalone generated-tone Preserve-key candidate, not musical quality or production integration',
        'muted': True,
        'capturePcm': options.capture_pcm,
        'selection': 'chirp-only' if options.chirp_only else 'full-matrix',
        'sourceSha256': {path: hashlib.sha256(file.read_bytes()).hexdigest() for path, file in FILES.items()},
        'fixtureSha256': hashlib.sha256((ROOT / 'tests/fixtures/preserve-output-probe.js').read_bytes()).hexdigest(),
        'cases': [],
        'status': 'INCOMPLETE',
    }
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
            try:
                report['browser'] = browser.version
                page = browser.new_page()
                page.goto(f'http://127.0.0.1:{server.server_port}/')
                page.add_script_tag(type='module', content="import {createPreserveOutput} from '/preserve-output.mjs'; import {createRateWindow} from '/rate-clock.mjs'; Object.assign(globalThis,{createPreserveOutput,createRateWindow});")
                page.wait_for_function('typeof createPreserveOutput === "function"')
                page.add_script_tag(path=str(ROOT / 'tests/fixtures/preserve-output-probe.js'))
                cases = [(source, output, rate, False) for source, output in [(48000, 48000), (44100, 48000), (48000, 96000)] for rate in [1, 0.025, 0.85, 4]]
                cases.extend([(48000, 48000, 0.025, True), (48000, 48000, 4, True), (44100, 48000, 0.025, True)])
                if options.chirp_only:
                    cases = [case for case in cases if case[3]]
                for source_rate, output_rate, rate, chirp in cases:
                    result = page.evaluate('runPreserveOutputProbe', {'sourceRate': source_rate, 'outputRate': output_rate, 'rate': rate, 'chirp': chirp, 'capturePcm': options.capture_pcm})
                    report['cases'].append(result)
                    print(json.dumps({key: result.get(key) for key in ['sourceRate', 'outputRate', 'rate', 'chirp', 'status', 'measurement', 'temporalSlope', 'error']}), flush=True)
                    if result['status'] != 'PASSED':
                        break
                if len(report['cases']) == len(cases) and all(case['status'] == 'PASSED' for case in report['cases']):
                    report['status'] = 'PASSED'
            finally:
                browser.close()
                report['browserClosed'] = True
    finally:
        server.shutdown()
        server.server_close()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = ROOT / f'test-results/preserve-output-{stamp}.json'
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'cases': len(report['cases']), 'file': str(output)}))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
