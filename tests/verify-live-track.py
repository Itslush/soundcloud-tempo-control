import json
import os
import hashlib
from datetime import datetime, timezone
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
TRACK = os.environ.get('TEST_TRACK_URL', 'https://soundcloud.com/nasa/sounds-of-the-sun')
DEFAULT = os.environ.get('TEST_DEFAULT_TRACK') == '1'
OUTPUT = ROOT / 'test-results' / ('ytdlp-live-preview-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script('''
        window.audioProbes = [];
        window.workletConnections = 0;
        const connect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(destination, ...args) {
            const result = connect.call(this, destination, ...args);
            if (this instanceof AudioWorkletNode) window.workletConnections++;
            if (destination instanceof AudioDestinationNode) {
                const analyser = this.context.createAnalyser();
                connect.call(this, analyser);
                window.audioProbes.push({analyser, data: new Float32Array(analyser.fftSize)});
            }
            return result;
        };
        window.audioPeak = () => Math.max(0, ...window.audioProbes.map(probe => {
            probe.analyser.getFloatTimeDomainData(probe.data);
            return Math.max(...probe.data.map(Math.abs));
        }));
    ''')
    errors = []
    failed_requests = []
    media_hosts = set()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('requestfailed', lambda request: failed_requests.append({
        'host': urlparse(request.url).hostname, 'error': request.failure,
    }))
    page.on('request', lambda request: media_hosts.add(urlparse(request.url).hostname)
            if '.sndcdn.com' in request.url or 'media-streaming.soundcloud.cloud' in request.url else None)
    page.goto(BASE, wait_until='networkidle')
    assert page.locator('audio').evaluate('(audio) => audio.paused && !audio.currentSrc && audio.volume === 0.15')
    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('0.75')
    page.locator('#demo-speed-number').press('Tab')
    if not DEFAULT:
        page.locator('#preview-loader summary').click()
        page.locator('#preview-url').fill(TRACK)
    with page.expect_response(lambda response: '/api/resolve?' in response.url, timeout=45000) as resolved:
        page.locator('#preview-play' if DEFAULT else '#preview-link-form button').click()
    response = resolved.value
    assert response.status == 200, response.text()
    track = response.json()
    expect(page.locator('#preview-title')).to_contain_text(track['title'], timeout=45000)
    expect(page.locator('#demo-copy')).to_be_enabled(timeout=45000)
    if DEFAULT:
        assert track['permalink'] == 'https://soundcloud.com/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'
    else:
        assert page.locator('audio').evaluate('(audio) => audio.paused && audio.volume === 0.15')
        page.locator('#preview-play').click()
    try:
        page.wait_for_function('document.querySelector("audio").currentTime > 1', timeout=30000)
    except Exception:
        print(json.dumps({'format': track['format'], 'media_hosts': sorted(media_hosts), 'failed_requests': failed_requests}), flush=True)
        print(json.dumps(page.locator('audio').evaluate('''audio => ({
            paused: audio.paused, readyState: audio.readyState,
            networkState: audio.networkState, duration: audio.duration,
            nativeHls: audio.canPlayType('application/vnd.apple.mpegurl'),
            error: audio.error?.message,
            status: document.querySelector('#demo-status').textContent,
            play: document.querySelector('#preview-play').textContent
        })''')), flush=True)
        raise
    page.wait_for_function('audioPeak() > 0.00001', timeout=15000)
    natural_peak = page.evaluate('audioPeak()')
    assert page.locator('audio').evaluate('(audio) => audio.playbackRate === 0.75 && !audio.preservesPitch')
    page.locator('.select-trigger').click()
    page.get_by_role('option', name='Preserve key', exact=True).click()
    page.wait_for_function('workletConnections > 0 && !document.querySelector("audio").preservesPitch', timeout=20000)
    page.wait_for_function('audioPeak() > 0.00001', timeout=15000)
    preserved_peak = page.evaluate('audioPeak()')
    assert 'browser key preservation' not in page.locator('#demo-status').inner_text()
    target = min(30, track['duration'] / 2)
    page.locator('#preview-seek').fill(str(target))
    page.wait_for_function('(target) => document.querySelector("audio").currentTime > target + 0.25', arg=target, timeout=20000)
    page.wait_for_function('audioPeak() > 0.00001', timeout=15000)
    page.locator('#preview-play').click()
    assert page.locator('audio').evaluate('(audio) => audio.paused')
    assert errors == [], errors
    page.locator('.timeline-demo').screenshot(path=str(OUTPUT.with_suffix('.png')))
    engine_response = page.request.get(BASE.rstrip('/') + '/audio/engine.js')
    assert engine_response.status == 200, engine_response.status
    report = {
        'status': 'PASS', 'site': BASE, 'defaultTrack': DEFAULT,
        'engineSha256': hashlib.sha256(engine_response.body()).hexdigest(),
        'screenshot': str(OUTPUT.with_suffix('.png')),
        'track': track['permalink'], 'format': track['format'],
        'duration': track['duration'], 'preview': track['preview'],
        'natural_peak': natural_peak, 'preserved_peak': preserved_peak,
        'wasm_connections': page.evaluate('workletConnections'),
        'seek': target, 'media_hosts': sorted(media_hosts), 'muted': True,
    }
    browser.close()
    report['browserClosed'] = True
    OUTPUT.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
