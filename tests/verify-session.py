import io
import json
import math
import os
import struct
import time
import wave
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
SECONDS = 120
CYCLES = 12

PROBES = '''
(() => {
    const baseConnect = AudioNode.prototype.connect;
    const baseDisconnect = AudioNode.prototype.disconnect;
    const NativeWorklet = AudioWorkletNode;
    const worklets = new WeakMap();
    const records = [];
    const probes = [];
    const urls = new Map();
    const createUrl = URL.createObjectURL;
    const revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = function(blob) {
        const url = createUrl.call(this, blob);
        urls.set(url, blob.type);
        return url;
    };
    URL.revokeObjectURL = function(url) {
        urls.delete(url);
        return revokeUrl.call(this, url);
    };
    window.AudioWorkletNode = class extends NativeWorklet {
        constructor(...args) {
            super(...args);
            const record = {closed: false, connected: false, reference: new WeakRef(this)};
            records.push(record);
            worklets.set(this, record);
            const close = this.port.close.bind(this.port);
            this.port.close = () => { record.closed = true; return close(); };
        }
    };
    AudioNode.prototype.connect = function(destination, ...args) {
        const record = worklets.get(this);
        if (record) record.connected = true;
        if (!(destination instanceof AudioDestinationNode))
            return baseConnect.call(this, destination, ...args);
        const analyser = this.context.createAnalyser();
        const silence = this.context.createGain();
        silence.gain.value = 0;
        baseConnect.call(this, analyser, ...args);
        baseConnect.call(analyser, silence);
        baseConnect.call(silence, destination);
        probes.push({analyser, silence, data: new Float32Array(analyser.fftSize)});
        return destination;
    };
    AudioNode.prototype.disconnect = function(...args) {
        const record = worklets.get(this);
        if (record) record.connected = false;
        return baseDisconnect.apply(this, args);
    };
    window.sessionSnapshot = () => {
        let peak = 0;
        for (const probe of probes) {
            probe.analyser.getFloatTimeDomainData(probe.data);
            for (const sample of probe.data) peak = Math.max(peak, Math.abs(sample));
        }
        return {
            peak,
            createdWorklets: records.length,
            connectedWorklets: records.filter(record => record.connected).length,
            openWorkletPorts: records.filter(record => !record.closed).length,
            reachableWorklets: records.filter(record => record.reference.deref()).length,
            liveAudioBlobs: [...urls.values()].filter(type => type.startsWith('audio/')).length,
            liveAllBlobs: urls.size,
            destinationsMuted: probes.length > 0 && probes.every(probe => probe.silence.gain.value === 0),
            outputProbeCount: probes.length,
        };
    };
})();
'''


def sample():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        rate = 24000
        audio.setparams((1, 2, rate, rate * 24, 'NONE', 'not compressed'))
        samples = bytearray(rate * 24 * 2)
        for index in range(rate * 24):
            t = index / rate
            value = math.sin(2 * math.pi * 220 * t) * 0.4
            value += math.sin(2 * math.pi * 330 * t) * 0.15
            struct.pack_into('<h', samples, index * 2, round(value * 32767))
        audio.writeframes(samples)
    return output.getvalue()


def metric_values(session):
    return {item['name']: item['value'] for item in session.send('Performance.getMetrics')['metrics']}


def select_pitch(page, preserve):
    page.locator('.select-trigger').click()
    page.get_by_role('option', name='Preserve key' if preserve else 'Natural', exact=True).click()


def audible_before_mute(page, preserve):
    page.wait_for_function('sessionSnapshot().peak > 0.00001', timeout=15000)
    if preserve:
        page.wait_for_function('sessionSnapshot().connectedWorklets === 1 && !document.querySelector("audio").preservesPitch', timeout=15000)
    else:
        page.wait_for_function('sessionSnapshot().connectedWorklets === 0 && !document.querySelector("audio").preservesPitch')
    result = page.evaluate('sessionSnapshot()')
    assert result['destinationsMuted']
    assert result['liveAudioBlobs'] == 1, result
    assert result['connectedWorklets'] <= 1, result
    assert result['openWorkletPorts'] <= 1, result
    assert 'Using browser key preservation' not in page.locator('#demo-status').inner_text()
    return result


def load_local(page, content):
    page.locator('#preview-loader').evaluate('(element) => element.open = true')
    page.locator('#preview-file').set_input_files({'name': 'session-loop.wav', 'mimeType': 'audio/wav', 'buffer': content})
    expect(page.locator('#preview-play')).to_be_enabled()
    page.wait_for_function('document.querySelector("audio").duration === 24 && document.querySelector(".timeline-demo").dataset.playback === "paused"')
    page.locator('audio').evaluate('(audio) => audio.loop = true')
    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('0.75')
    page.locator('#demo-speed-number').press('Enter')


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script(PROBES)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until='networkidle')
    content = sample()
    load_local(page, content)
    select_pitch(page, True)
    page.locator('#preview-play').click()
    audible_before_mute(page, True)
    select_pitch(page, False)
    audible_before_mute(page, False)
    session = page.context.new_cdp_session(page)
    session.send('Performance.enable')
    session.send('HeapProfiler.collectGarbage')
    baseline = metric_values(session)
    started = time.monotonic()
    snapshots = []
    checks = 0
    next_progress = 20
    for cycle in range(CYCLES):
        preserve = cycle % 2 == 0
        select_pitch(page, preserve)
        audible_before_mute(page, preserve)
        page.locator('#preview-seek').fill(str((cycle * 3 + 2) % 20))
        page.wait_for_function('!document.querySelector("audio").seeking')
        audible_before_mute(page, preserve)
        page.locator('#preview-reset').click()
        assert page.locator('audio').evaluate('(audio) => audio.paused && audio.currentTime < 0.2')
        load_local(page, content)
        select_pitch(page, preserve)
        rate = [0.5, 0.75, 1.25, 0.9][cycle % 4]
        page.locator('#demo-speed-number').fill(str(rate))
        page.locator('#demo-speed-number').press('Enter')
        page.locator('#preview-play').click()
        audible_before_mute(page, preserve)
        target = started + SECONDS * (cycle + 1) / CYCLES
        while time.monotonic() < target:
            page.wait_for_timeout(min(1000, max(1, (target - time.monotonic()) * 1000)))
            assert page.locator('audio').evaluate('(audio) => !audio.paused && !audio.error')
            observation = page.evaluate('sessionSnapshot()')
            assert observation['destinationsMuted']
            assert observation['peak'] > 0.00001, observation
            assert observation['liveAudioBlobs'] == 1, observation
            assert observation['openWorkletPorts'] <= 1, observation
            checks += 1
        snapshots.append({'cycle': cycle + 1, 'elapsedSeconds': round(time.monotonic() - started, 3),
                          'preserveKey': preserve, 'rate': rate, **page.evaluate('sessionSnapshot()')})
        elapsed = time.monotonic() - started
        if elapsed >= next_progress:
            print(f'Session verification: {round(elapsed)}s, {cycle + 1}/{CYCLES} cycles, speaker output muted.', flush=True)
            next_progress += 20
    elapsed = time.monotonic() - started
    assert elapsed >= SECONDS
    page.locator('#preview-play').click()
    session.send('HeapProfiler.collectGarbage')
    final = metric_values(session)
    observed = page.evaluate('sessionSnapshot()')
    assert final['JSHeapUsedSize'] - baseline['JSHeapUsedSize'] < 16 * 1024 * 1024
    assert observed['createdWorklets'] == 1
    assert observed['openWorkletPorts'] == 1, observed
    assert observed['connectedWorklets'] == 0, observed
    page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}))")
    disposed = page.evaluate('sessionSnapshot()')
    assert disposed['liveAudioBlobs'] == 0, disposed
    assert disposed['openWorkletPorts'] == 0, disposed
    assert errors == [], errors
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'test': '120-second generated local-audio website session',
        'browser': browser.version,
        'scriptAssets': page.locator('script[src]').evaluate_all('(scripts) => scripts.map(script => script.src)'),
        'sourceSeconds': 24,
        'sourceBytes': len(content),
        'elapsedSeconds': round(elapsed, 3),
        'resetReloadSeekCycles': CYCLES,
        'periodicNonzeroSamples': checks,
        'speakerOutputMuted': True,
        'wholePageJsHeapAfterGcBefore': baseline['JSHeapUsedSize'],
        'wholePageJsHeapAfterGcAfter': final['JSHeapUsedSize'],
        'wholePageJsHeapDeltaBytes': final['JSHeapUsedSize'] - baseline['JSHeapUsedSize'],
        'wholePageJsHeapGrowthGuardBytes': 16 * 1024 * 1024,
        'mainThreadTaskDurationSeconds': round(final['TaskDuration'] - baseline['TaskDuration'], 4),
        'mainThreadTaskDurationIncludesTestActionsAndGc': True,
        'beforeDispose': observed,
        'afterDispose': disposed,
        'cycles': snapshots,
        'limits': [
            'Two minutes of generated local audio, not a one-hour streaming session.',
            'Headless Chromium website playback, not an installed userscript-manager test.',
            'Main-thread TaskDuration excludes audio-render-thread and WASM CPU.',
            'JS heap covers the whole page and test instrumentation, not library-only or total-process memory.',
            'Worklet counts observe main-thread connections and port closure, not processor-thread destruction.',
            'Periodic nonzero analyser samples do not prove glitch-free audio or perceptual quality.',
        ],
    }
    print(json.dumps({key: value for key, value in report.items() if key != 'cycles'}), flush=True)
    (ROOT / 'test-results' / 'session-report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    browser.close()
