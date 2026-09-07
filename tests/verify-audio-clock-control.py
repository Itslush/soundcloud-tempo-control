import argparse
import hashlib
import json
import time
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, choices=[40, 60, 720], default=40)
    options = parser.parse_args()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'status': 'INCOMPLETE', 'requestedSeconds': options.seconds,
        'scope': 'Local oscillator through gain0 in fresh headless Chrome with browser mute. No SoundCloud, userscript, network audio, decoder or WASM. Ten-second warmup and twenty-second observation intervals match the baseline timing approximately; this is not a CPU comparison.',
        'verifierSha256': hashlib.sha256((ROOT / 'tests/verify-audio-clock-control.py').read_bytes()).hexdigest(),
        'samples': [], 'pageErrors': [],
    }
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = ROOT / f'test-results/audio-clock-control-{stamp}.json'
    def checkpoint():
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        temporary.replace(output)
    print(f'Clock control: {output}', flush=True)
    checkpoint()
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        context = browser.new_context()
        page = context.new_page()
        page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
        report['browser'] = browser.version
        try:
            page.set_content('<!doctype html><title>Muted audio clock control</title>')
            page.evaluate('''async () => {
              const context = new AudioContext(), gain = context.createGain(), source = context.createOscillator();
              gain.gain.value = 0;
              source.connect(gain).connect(context.destination);
              const events = [];
              const record = name => { if (events.length < 128) events.push({name, wall:performance.now(), audio:context.currentTime, state:context.state, visibility:document.visibilityState}); };
              context.addEventListener('statechange', () => record('statechange'));
              document.addEventListener('visibilitychange', () => record('visibilitychange'));
              window.clockControl = {
                snapshot: () => ({wall:performance.now(), audio:context.currentTime, state:context.state, sampleRate:context.sampleRate, sinkGain:gain.gain.value, visibility:document.visibilityState, outputTimestamp:context.getOutputTimestamp(), events:events.slice()}),
                stop: async () => { source.stop(); await context.close(); source.disconnect(); gain.disconnect(); return {state:context.state, sinkGain:gain.gain.value}; }
              };
              source.start();
              await context.resume();
            }''')
            page.wait_for_timeout(10000)
            for index in range(options.seconds // 20 + 1):
                if index:
                    page.wait_for_timeout(20000)
                before = time.monotonic()
                value = page.evaluate('clockControl.snapshot()')
                after = time.monotonic()
                report['samples'].append({'before': before, 'after': after, **value})
                if value['sinkGain'] != 0:
                    raise AssertionError('Control lost permanent mute')
                checkpoint()
                if index:
                    first = report['samples'][0]
                    delta = value['audio'] - first['audio']
                    within = before - first['after'] - 0.05 <= delta <= after - first['before'] + 0.05
                    print(f'Clock control: {index * 20}s / {options.seconds}s, audio +{delta:.6f}s, within 50ms: {within}', flush=True)
                    if not within:
                        report['stoppedEarlyOnClockDrift'] = True
                        break
            first, last = report['samples'][0], report['samples'][-1]
            delta = last['audio'] - first['audio']
            minimum = last['before'] - first['after']
            maximum = last['after'] - first['before']
            report['clock'] = {
                'audioSeconds': delta, 'wallMinimumSeconds': minimum, 'wallMaximumSeconds': maximum,
                'within50ms': minimum - 0.05 <= delta <= maximum + 0.05,
                'allObservedStatesRunning': all(item['state'] == 'running' for item in report['samples']),
            }
            if report['pageErrors']:
                raise AssertionError('Page errors occurred')
            report['status'] = 'OBSERVED'
        except Exception as error:
            report['error'] = str(error)
        finally:
            try:
                report['stopped'] = page.evaluate('clockControl.stop()')
                if report['stopped'] != {'state': 'closed', 'sinkGain': 0}:
                    raise AssertionError('Audio context did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    checkpoint()
    print(json.dumps({'status': report['status'], 'file': str(output), 'clock': report.get('clock'), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] == 'OBSERVED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
