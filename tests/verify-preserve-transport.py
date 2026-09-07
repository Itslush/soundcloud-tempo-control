import argparse
import hashlib
import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options
from worklet_fixture import build_worklet

MODULES = ['preserve-output', 'preserve-worklet', 'pcm-window', 'rate-clock', 'natural-output', 'buffered-transport', 'transport-lifecycle']
FILES = {f'/{name}.mjs': ROOT / f'src/audio/{name}.mjs' for name in MODULES}
FILES['/worklet.js'] = build_worklet()
FILES['/probe.js'] = ROOT / 'tests/fixtures/buffered-transport-probe.js'
FILES['/frame-capture-worklet.js'] = ROOT / 'tests/fixtures/frame-capture-worklet.js'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            data = b'<!doctype html><title>Muted Preserve-key transport test</title>'
            content_type = 'text/html'
        elif self.path in FILES:
            data = FILES[self.path].read_bytes()
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
    parser.add_argument('--transport', default='src/audio/buffered-transport.mjs')
    options = parser.parse_args()
    transport_path = (ROOT / options.transport).resolve()
    if not transport_path.is_relative_to(ROOT.resolve()) or not transport_path.is_file():
        raise ValueError('Transport must be an existing module within the project')
    FILES['/buffered-transport.mjs'] = transport_path
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Generated PCM through bounded cache, transport and real pinned Preserve-key processor. Not musical quality, continuous boundary capture, live streams or installed SoundCloud integration.',
        'audio': 'Isolated muted Chromium and zero-gain destination',
        'transportPath': str(transport_path),
        'sourceSha256': {path: hashlib.sha256(file.read_bytes()).hexdigest() for path, file in FILES.items()},
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
                page.add_script_tag(type='module', content="""
                    import {createPreserveOutput} from '/preserve-output.mjs';
                    import {createPcmWindow} from '/pcm-window.mjs';
                    import {createNaturalOutput} from '/natural-output.mjs';
                    import {createBufferedTransport} from '/buffered-transport.mjs';
                    Object.assign(globalThis, {createPreserveOutput, createPcmWindow, createNaturalOutput, createBufferedTransport});
                """)
                page.wait_for_function('typeof createPreserveOutput === "function"')
                page.add_script_tag(url='/probe.js')
                for source, output in [(48000, 48000), (44100, 48000), (48000, 96000)]:
                    result = page.evaluate('bufferedTransportProbe', {'live': False, 'preserve': True, 'sourceSampleRate': source, 'outputSampleRate': output})
                    report['cases'].append(result)
                    print(json.dumps({'source': source, 'output': output, 'status': result['status'], 'error': result.get('error')}), flush=True)
                    if result['status'] != 'PASSED':
                        break
                if len(report['cases']) == 3 and all(case['status'] == 'PASSED' for case in report['cases']):
                    report['status'] = 'PASSED'
            finally:
                browser.close()
                report['browserClosed'] = True
    except Exception as error:
        report['error'] = {'name': type(error).__name__, 'message': str(error)[:2000]}
    finally:
        server.shutdown()
        server.server_close()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = ROOT / f'test-results/preserve-transport-{stamp}.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'cases': len(report['cases']), 'file': str(output), 'error': report.get('error')}))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
