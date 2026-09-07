import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['natural', 'preserve'], default='natural')
    options = parser.parse_args()
    spec = importlib.util.spec_from_file_location('transitions', ROOT / 'tests/verify-buffered-transitions.py')
    transitions = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transitions)
    player = transitions.player
    files = {
        'candidate': ROOT / 'src/audio/host-clock.mjs',
        'attachment': ROOT / 'tests/fixtures/host-clock-candidate.js',
        'inspection': ROOT / 'tests/fixtures/host-clock-probe.js',
        'baseProbe': ROOT / 'tests/fixtures/buffered-player-probe.js',
        'transitionProbe': ROOT / 'tests/fixtures/buffered-transitions-probe.js',
        'artifact': ROOT / 'dist/soundcloud-tempo-control.user.js',
        'hostCompatibility': ROOT / 'tests/fixtures/soundcloud-host-clock.json',
        'transitionHelper': ROOT / 'tests/verify-buffered-transitions.py',
        'playerHelper': ROOT / 'tests/verify-buffered-player.py',
        'verifier': ROOT / 'tests/verify-host-clock-candidate.py',
    }
    data = {key: path.read_bytes() for key, path in files.items()}
    compatibility = json.loads(data['hostCompatibility'])
    candidate = data['candidate'].decode()
    player.check(candidate.count('export function createHostClock(') == 1, 'Candidate module boundary changed')
    candidate = candidate.replace('export function createHostClock(', 'function createHostClock(', 1)
    attach = data['attachment'].decode().strip().removesuffix(';')
    inspect = data['inspection'].decode().strip().removesuffix(';')
    operation = 'expected => {\n' + candidate + '\nreturn (' + inspect + ')(runtime => (' + attach + ')(createHostClock, runtime, expected));\n}'
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Exact public artifact plus isolated host-clock candidate attached to one already-playing low-rate source. Real SoundCloud queue/seek controls and decoded-completion observer, fresh signed-out Chrome and permanent zero-gain/browser mute. Candidate is not part of the distribution or production ownership lifecycle. Tests one outgoing source, not automatic binding of the next source or installed-manager behavior.',
        'hashes': {key: hashlib.sha256(value).hexdigest() for key, value in data.items()},
        'candidateSource': data['candidate'].decode(),
        'mode': options.mode,
        'status': 'INCOMPLETE',
        'automaticEof': [],
        'pageErrors': [],
    }
    phase = 'navigate'
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(data['baseProbe'].decode() + '\n' + data['transitionProbe'].decode() + '\n' + userscript_source(files['artifact']) + '\nif(window.top===window && location.origin==="https://soundcloud.com") bufferedPlayerProbe.observeCommands();')
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)[:2000]))
        try:
            page.goto(player.TRACK, wait_until='domcontentloaded', timeout=35000)
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            player.dismiss_overlays(page)
            owner = page.locator('a[href="/nasa"]').filter(has_text='NASA').first
            owner.click()
            page.wait_for_url('https://soundcloud.com/nasa', timeout=15000)
            page.locator('.soundList__item').first.wait_for(state='attached', timeout=15000)
            tracks = page.locator('.trackItem__trackTitle').evaluate_all('links=>links.slice(0,3).map(link=>({path:new URL(link.href).pathname,title:link.textContent.trim()}))')
            player.check(len(tracks) == 3, 'Expected three visible public playlist tracks')
            report['tracks'] = tracks
            transitions.set_mode(page, options.mode)
            phase = 'prepare-next-track'
            transitions.play_row(page, tracks[2]['path'])
            transitions.wait_track(page, tracks[2]['path'])
            transitions.save_rate(page, tracks[2]['path'], 0.85)
            player.measure(page, 0.85, False, transitions.label(options.mode, False))
            phase = 'prepare-outgoing-track'
            transitions.play_row(page, tracks[1]['path'])
            transitions.wait_track(page, tracks[1]['path'])
            transitions.save_rate(page, tracks[1]['path'], 0.025)
            report['outgoing'] = player.measure(page, 0.025, True, transitions.label(options.mode, True))
            phase = 'attach-candidate'
            report['preflight'] = page.evaluate(inspect)
            recorded = report['preflight']['cachedModules']
            expected = []
            for item in compatibility['methods']:
                module, prototype, method = item['module'], item['prototype'], item['method']
                observed_module = recorded[module]
                player.check(observed_module['version'] == compatibility['version'] and observed_module['buildNumber'] == compatibility['buildNumber'], 'Host SDK version changed')
                source = observed_module['prototypes'][prototype][method]['source']
                player.check(hashlib.sha256(source.encode()).hexdigest() == item['sha256'], f'Host method changed: {prototype}.{method}')
                expected.append({'prototype': prototype, 'method': method, 'source': source})
            report['attachment'] = page.evaluate(operation, expected)
            cleanup = report['attachment']['cleanup']
            player.check(all(cleanup[key] for key in ['factoryRemoved', 'moduleRemoved', 'packetRemoved']), 'Diagnostic registration leaked')
            phase = 'automatic-eof'
            transitions.automatic_eof(page, report, options.mode, tracks[2]['path'], 0.85, 1)
            player.check(report['automaticEof'][0]['decodedCompletionObserved'], 'Host replaced the source before decoded completion')
            report['candidateAfter'] = page.evaluate('hostClockCandidateTest.snapshot()')
            player.check(not report['candidateAfter']['failures'], 'Host clock candidate reported a compatibility failure')
            player.check(not report['pageErrors'], 'Page errors occurred during the candidate test')
            report['status'] = 'PASSED'
        except Exception as error:
            report['error'] = {'phase': phase, 'message': str(error)[:4000]}
            try:
                report['failureSnapshot'] = transitions.snapshot(page)
                report['candidateAfter'] = page.evaluate('window.hostClockCandidateTest?.snapshot()')
            except Exception:
                pass
        finally:
            try:
                report['candidateCleanup'] = page.evaluate('window.hostClockCandidateTest?.stop()')
                if report['candidateCleanup']:
                    player.check(report['candidateCleanup']['methodsRestored'] and report['candidateCleanup']['durationRestoredToData'], 'Host clock cleanup was incomplete')
            except Exception as error:
                report['candidateCleanupError'] = str(error)[:2000]
                report['status'] = 'INCOMPLETE'
            try:
                page.evaluate('bufferedTransitionsProbe.stop()')
                report['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                player.check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in report['stopped']['contexts']), 'Audio contexts did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)[:2000]
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    output = ROOT / f'test-results/host-clock-candidate-{options.mode}-{stamp}.json'
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'file': str(output), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
