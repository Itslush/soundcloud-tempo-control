import hashlib
import importlib.util
import json
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options


def main():
    helper_path = ROOT / 'tests/verify-buffered-player.py'
    spec = importlib.util.spec_from_file_location('buffered_player', helper_path)
    player = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(player)
    probe_path = ROOT / 'tests/fixtures/host-clock-probe.js'
    base_path = ROOT / 'tests/fixtures/buffered-player-probe.js'
    probe = probe_path.read_bytes()
    base = base_path.read_bytes()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Fresh signed-out Chrome, no userscript, browser mute and final-edge analyser/gain zero. Reads already-executed host SDK exports through one temporary diagnostic-only Webpack module. No host module factory invocation, playback-clock patches, installed-profile access, or source replacement.',
        'status': 'INCOMPLETE',
        'probeSha256': hashlib.sha256(probe).hexdigest(),
        'baseProbeSha256': hashlib.sha256(base).hexdigest(),
        'verifierSha256': hashlib.sha256((ROOT / 'tests/verify-host-clock.py').read_bytes()).hexdigest(),
        'helperSha256': hashlib.sha256(helper_path.read_bytes()).hexdigest(),
        'pageErrors': [],
    }
    phase = 'navigate'
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(base.decode())
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)[:2000]))
        try:
            page.goto(player.TRACK, wait_until='domcontentloaded', timeout=35000)
            player.dismiss_overlays(page)
            phase = 'public-play'
            player.play_public_track(page)
            page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio => !audio.paused && audio.position > 0)', timeout=20000)
            report['before'] = player.snapshot(page)
            phase = 'cache-inspection'
            report['inspection'] = page.evaluate(probe.decode())
            cleanup = report['inspection']['cleanup']
            player.check(all(cleanup[key] for key in ['factoryRemoved', 'moduleRemoved', 'packetRemoved']), 'Diagnostic registration was not fully removed')
            player.check(cleanup['afterPackets'] == report['inspection']['beforePackets'], 'JSONP packet count changed during synchronous inspection')
            page.wait_for_timeout(500)
            report['after'] = player.snapshot(page)
            player.check(any(not audio['paused'] for audio in report['after']['media']), 'Playback was not active after read-only inspection')
            report['status'] = 'INSPECTED'
        except Exception as error:
            report['error'] = {'phase': phase, 'message': str(error)[:4000]}
        finally:
            try:
                report['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                player.check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in report['stopped']['contexts']), 'Audio contexts did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)[:2000]
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    output = ROOT / f'test-results/host-clock-inspection-{stamp}.json'
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'file': str(output), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] == 'INSPECTED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
