import io
import json
import math
import os
import struct
import wave
from datetime import datetime, timezone

from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
PROBE = '''
window.navigationAudit = {id: crypto.randomUUID(), shown: [], hidden: []};
addEventListener('pageshow', event => navigationAudit.shown.push(event.persisted));
addEventListener('pagehide', event => navigationAudit.hidden.push(event.persisted));
(() => {
    const connect = AudioNode.prototype.connect;
    const probes = [];
    AudioNode.prototype.connect = function(destination, ...args) {
        if (!(destination instanceof AudioDestinationNode))
            return connect.call(this, destination, ...args);
        const analyser = this.context.createAnalyser();
        const silent = this.context.createGain();
        silent.gain.value = 0;
        connect.call(this, analyser, ...args);
        connect.call(analyser, silent);
        connect.call(silent, destination);
        probes.push({analyser, silent, data: new Float32Array(analyser.fftSize)});
        return destination;
    };
    window.navigationOutput = () => {
        let peak = 0;
        for (const {analyser, data} of probes) {
            analyser.getFloatTimeDomainData(data);
            for (const value of data) peak = Math.max(peak, Math.abs(value));
        }
        return {
            peak,
            muted: probes.length > 0 && probes.every(probe => probe.silent.gain.value === 0),
            contexts: probes.map(({analyser, data}) => ({
                time: analyser.context.currentTime,
                state: analyser.context.state,
                windowSeconds: data.length / analyser.context.sampleRate,
            })),
        };
    };
})();
'''


def sample():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        rate = 8000
        audio.setparams((1, 2, rate, rate * 24, 'NONE', 'not compressed'))
        data = bytearray(rate * 24 * 2)
        for index in range(rate * 24):
            struct.pack_into('<h', data, index * 2, round(8000 * math.sin(2 * math.pi * 220 * index / rate)))
        audio.writeframes(data)
    return output.getvalue()


def snapshot(page):
    return page.evaluate('''() => ({
        ...navigationAudit,
        output: navigationOutput(),
        audio: (() => {
            const audio = document.querySelector('audio');
            return audio && {
                paused: audio.paused, time: audio.currentTime,
                duration: Number.isFinite(audio.duration) ? audio.duration : null,
                source: audio.currentSrc, rate: audio.playbackRate
            };
        })(),
        point: document.querySelector('#demo-point-rate')?.value,
        pitch: document.querySelector('#demo-pitch')?.value,
        playLabel: document.querySelector('#preview-play')?.textContent.trim()
    })''')


def resumed(page, preserve):
    previous = page.evaluate('navigationOutput().contexts')
    assert previous, 'Missing output probe'
    page.wait_for_function('''previous => {
        const current = navigationOutput();
        return current.peak > 0.00001 && current.contexts.length === previous.length &&
            current.contexts.every((context, index) => context.state === 'running' &&
                context.time > previous[index].time + context.windowSeconds * 2);
    }''', arg=previous)
    assert page.evaluate('navigationOutput().muted')
    expect(page.locator('#demo-pitch')).to_have_value('preserve' if preserve else 'natural')
    expect(page.locator('audio')).to_have_js_property('playbackRate', 0.75)
    if preserve:
        page.wait_for_function('!document.querySelector("audio").preservesPitch')
        assert 'Using browser key preservation' not in page.locator('#demo-status').inner_text()


def assert_restored(before, after):
    assert before['id'] == after['id'], after
    assert after['shown'][-1] is True and after['hidden'][-1] is True, after
    assert after['point'] == before['point'], after
    assert after['pitch'] == before['pitch'], after
    assert after['audio']['paused'], after
    assert after['audio']['rate'] == before['audio']['rate'], after
    assert after['audio']['duration'] == before['audio']['duration'], after
    assert abs(after['audio']['time'] - before['audio']['time']) < 1, after


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(
        **browser_options(), headless=True, args=['--mute-audio'],
        ignore_default_args=['--disable-back-forward-cache'],
    )
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.set_default_timeout(10000)
    page.add_init_script(PROBE)
    errors = []
    misses = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    session = page.context.new_cdp_session(page)
    session.send('Page.enable')
    session.on('Page.backForwardCacheNotUsed', lambda event: misses.append(event))
    outcomes = []
    try:
        for mode in ['idle', 'paused', 'playing', 'preserve-paused', 'preserve-playing']:
            page.goto(BASE, wait_until='networkidle')
            if mode != 'idle':
                page.locator('#preview-loader summary').click()
                page.locator('#preview-file').set_input_files({
                    'name': 'navigation.wav', 'mimeType': 'audio/wav', 'buffer': sample(),
                })
                expect(page.locator('#preview-play')).to_be_enabled()
                page.wait_for_function('document.querySelector("audio").duration === 24')
                page.locator('#preview-fixed').click()
                page.locator('#demo-speed-number').fill('0.75')
                page.locator('#demo-speed-number').press('Enter')
                if mode.startswith('preserve'):
                    page.locator('.select-trigger').click()
                    page.get_by_role('option', name='Preserve key', exact=True).click()
                page.locator('#preview-play').click()
                page.wait_for_function('document.querySelector("audio").currentTime > 0.3')
                resumed(page, mode.startswith('preserve'))
                if mode.endswith('paused'):
                    page.locator('#preview-play').click()
            page.locator('#demo-point-rate').fill('0.85')
            page.locator('#demo-point-rate').press('Enter')
            before = snapshot(page)
            page.locator('.site-header').get_by_role('link', name='Help', exact=True).click()
            page.wait_for_url(BASE + 'guide/', wait_until='commit')
            page.go_back(wait_until='commit')
            expect(page.locator('#preview-play')).to_be_visible()
            after = snapshot(page)
            cached = before['id'] == after['id']
            if cached:
                assert_restored(before, after)
                if mode != 'idle':
                    page.locator('#preview-play').click()
                    page.wait_for_function('(start) => document.querySelector("audio").currentTime > start + 0.2', arg=after['audio']['time'])
                    resumed(page, mode.startswith('preserve'))
                    page.locator('#preview-play').click()
            else:
                assert after['shown'] == [False], after
                assert after['audio']['paused'] and not after['audio']['source'], after
            before_second = snapshot(page)
            page.go_forward(wait_until='commit')
            page.wait_for_url(BASE + 'guide/', wait_until='commit')
            page.go_back(wait_until='commit')
            expect(page.locator('#preview-play')).to_be_visible()
            final = snapshot(page)
            second_cached = before_second['id'] == final['id']
            if second_cached:
                assert_restored(before_second, final)
            else:
                assert final['shown'] == [False], final
                assert final['audio']['paused'] and not final['audio']['source'], final
            outcomes.append({'mode': mode, 'restoredFromCache': cached,
                             'secondReturnFromCache': second_cached,
                             'before': before, 'after': after,
                             'beforeSecondReturn': before_second, 'secondReturn': final})
            print(f'{mode}: actual Back/Forward passed; cached restoration={cached}', flush=True)
        assert not errors, errors
        cached_returns = sum(int(outcome['restoredFromCache']) + int(outcome['secondReturnFromCache']) for outcome in outcomes)
        coverage_complete = cached_returns == len(outcomes) * 2
        result = {
            'timestampUtc': datetime.now(timezone.utc).isoformat(),
            'browser': browser.version,
            'speakerOutputMuted': True,
            'actualHistoryNavigation': True,
            'syntheticPageTransitions': False,
            'cachedReturns': cached_returns,
            'totalReturns': len(outcomes) * 2,
            'status': 'PASS' if coverage_complete else 'INCOMPLETE: browser cache misses prevented full restoration coverage',
            'outcomes': outcomes,
            'cacheMissReasons': misses,
            'limitations': ['Generated local audio, not a remote HLS restoration test.',
                            'A cache miss reloads the page and does not preserve an unsaved demo draft.'],
        }
        (ROOT / 'test-results/navigation-report.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({key: result[key] for key in ['browser', 'status', 'cachedReturns', 'totalReturns']}, indent=2))
        if not coverage_complete:
            raise SystemExit(2)
    finally:
        browser.close()
