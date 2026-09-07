import argparse
import base64
import hashlib
import json
import os
import re
import struct
import zlib
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse

from playwright.sync_api import sync_playwright, expect, TimeoutError

from userscript_fixture import ROOT, userscript_bytes, userscript_source, browser_options

DESTINATION = ROOT / 'site/public/screenshots'
STAGING = ROOT / 'test-results' / ('showcase-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
TRACK = 'https://soundcloud.com/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'
TRACK_PATH = urlparse(TRACK).path
SPEED_KEY = 'soundcloud.tempo.track.' + quote(TRACK_PATH, safe='')
TIMELINE_KEY = 'soundcloud.tempo.timeline.' + quote(TRACK_PATH, safe='')
DENSITY = 3
NETWORK = []
WARNINGS = []
MUTE = '''(() => {
  if (window.top !== window || location.origin !== 'https://soundcloud.com') return;
  const native = Object.getOwnPropertyDescriptors(HTMLMediaElement.prototype);
  window.capturedMedia = new Set();
  window.capturePlayCalls = [];
  window.captureNativeState = media => Object.fromEntries(
    ['currentTime', 'duration', 'paused', 'ended', 'readyState', 'networkState', 'currentSrc', 'src', 'muted', 'volume', 'playbackRate'].map(name => {
      const value = native[name]?.get?.call(media);
      return [name, typeof value === 'number' && !Number.isFinite(value) ? String(value) : value];
    })
  );
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) {
    this.muted = true;
    this.volume = 0;
    capturedMedia.add(this);
    const call = capturePlayCalls.length < 32 ? {
      time: performance.now(), before: captureNativeState(this),
      activation: navigator.userActivation.isActive, stack: new Error().stack?.slice(0, 2000),
      result: 'pending'
    } : null;
    if (call) capturePlayCalls.push(call);
    const result = play.apply(this, args);
    if (call) Promise.resolve(result).then(
      () => { call.result = 'resolved'; call.after = captureNativeState(this); },
      error => { call.result = 'rejected'; call.error = String(error); call.after = captureNativeState(this); }
    );
    return result;
  };
  const create = AudioContext.prototype.createMediaElementSource;
  AudioContext.prototype.createMediaElementSource = function(media) {
    media.muted = true;
    media.volume = 0;
    capturedMedia.add(media);
    return create.call(this, media);
  };
})();'''


def observe_page(page, label):
    def network(kind, request, status=None, failure=None):
        url = urlparse(request.url)
        if not (url.hostname and (url.hostname.endswith('soundcloud.com') or url.hostname.endswith('sndcdn.com'))):
            return
        if len(NETWORK) < 400:
            NETWORK.append({'page': label, 'kind': kind, 'host': url.hostname, 'path': url.path, 'type': request.resource_type, 'status': status, 'failure': failure})
    page.on('request', lambda request: network('request', request))
    page.on('response', lambda response: network('response', response.request, response.status))
    page.on('requestfailed', lambda request: network('failed', request, failure=request.failure))
    page.on('console', lambda message: WARNINGS.append({'page': label, 'type': message.type, 'text': message.text[:1000]}) if message.type in ['error', 'warning'] and len(WARNINGS) < 64 else None)


def capture_failure(page, evidence, label):
    failure = {'page': label, 'url': urlparse(page.url)._replace(query='', fragment='').geturl(), 'network': NETWORK[:], 'warnings': WARNINGS[:]}
    evidence['failure'] = failure
    try:
        failure['media'] = page.evaluate('''() => ({
          captured: typeof capturedMedia === 'undefined' ? null : [...capturedMedia].map(media => ({
            native: captureNativeState(media), public: {
              time: media.currentTime, duration: String(media.duration), paused: media.paused,
              ended: media.ended, readyState: media.readyState, rate: media.playbackRate,
              error: media.error ? {code: media.error.code, message: media.error.message} : null
            }
          })),
          calls: typeof capturePlayCalls === 'undefined' ? null : capturePlayCalls,
          probe: typeof bufferedPlayerProbe === 'undefined' ? null : bufferedPlayerProbe.snapshot(),
          audioElements: [...document.querySelectorAll('audio')].map(media => ({src: media.src, currentSrc: media.currentSrc, paused: media.paused, readyState: media.readyState})),
          footer: document.querySelector('.playControls')?.outerHTML.slice(0, 16000),
          text: document.body.innerText.slice(0, 10000)
        })''')
        failure['frames'] = []
        for frame in page.frames:
            item = {'url': urlparse(frame.url)._replace(query='', fragment='').geturl()}
            if urlparse(frame.url).hostname == 'soundcloud.com':
                item['controls'] = frame.locator('button').evaluate_all('buttons=>buttons.map(button=>({text:button.textContent.trim().slice(0,80),aria:button.getAttribute("aria-label"),title:button.title,disabled:button.disabled})).slice(0,80)')
            failure['frames'].append(item)
        target = STAGING / f'{label}-failure.png'
        page.screenshot(path=str(target), animations='disabled')
        failure['screenshot'] = str(target)
    except Exception as error:
        failure['observationError'] = str(error)


def media_state(page):
    return page.evaluate('''() => [...capturedMedia].map(media => ({
      time: media.currentTime, readyState: media.readyState,
      duration: Number.isFinite(media.duration) ? media.duration : null,
      paused: media.paused, muted: media.muted, volume: media.volume
    }))''')


def audio_evidence(page):
    media = media_state(page)
    contexts = page.evaluate('bufferedPlayerProbe.snapshot().contexts')
    assert media and all(item['paused'] and item['muted'] and item['volume'] == 0 for item in media), media
    assert contexts and all(item['sinkGain'] == 0 for item in contexts), contexts
    return {'media': media, 'contexts': contexts}


def stored_timeline(page):
    return page.evaluate('key=>JSON.parse(localStorage.getItem(key))', TIMELINE_KEY)


def annotate_origin(path, url, state):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR'
    payload = b'Source\0\0\0\0\0' + f'Unedited browser capture: {url}\n{state}'.encode('utf-8')
    chunk = b'iTXt' + payload
    encoded = struct.pack('>I', len(payload)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)
    path.write_bytes(data[:33] + encoded + data[33:])


def record_image(page, name, evidence, selector=None, clip=None, state=''):
    page.mouse.move(3, 3)
    path = STAGING / name
    if selector:
        page.locator(selector).screenshot(path=str(path), animations='disabled')
    else:
        page.screenshot(path=str(path), clip=clip, animations='disabled')
    annotate_origin(path, page.url, state)
    width, height = struct.unpack('>II', path.read_bytes()[16:24])
    evidence['screenshots'].append({
        'file': name, 'width': width, 'height': height,
        'cssWidth': width / DENSITY, 'cssHeight': height / DENSITY,
        'url': page.url, 'state': state, 'clip': clip,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    })


def dismiss_prompts(page):
    reject = page.get_by_role('button', name=re.compile('^Reject all$', re.I))
    try:
        reject.first.wait_for(state='visible', timeout=4000)
        reject.first.click()
        page.locator('.onetrust-pc-dark-filter').wait_for(state='hidden', timeout=5000)
    except TimeoutError:
        pass
    for button in page.get_by_role('button', name='Close', exact=True).all():
        if 'editor-close' in (button.get_attribute('class') or ''):
            continue
        if button.is_visible():
            try:
                button.click(timeout=1000)
            except TimeoutError:
                pass


def load_track(page, url):
    page.goto(url, wait_until='domcontentloaded', timeout=45000)
    dismiss_prompts(page)
    page.wait_for_function('''path => {
      if (document.querySelector('.soundTitle__playButtonHero .playButton')) return true;
      return [...document.querySelectorAll('iframe')].some(frame => {
        if (frame.hasAttribute('sandbox')) return false;
        try {
          const url = new URL(frame.contentWindow.location.href);
          return url.origin === location.origin && url.pathname === '/n' + path &&
            frame.contentDocument.querySelector('section[aria-label="Track header"] button[aria-label="Play"],section[aria-label="Track header"] button[aria-label="Pause"]');
        } catch { return false; }
      });
    }''', arg=TRACK_PATH, timeout=25000)
    legacy = page.locator('.soundTitle__playButtonHero .playButton')
    if legacy.count() and legacy.first.is_visible():
        hero = legacy.first
        hero_attribute = 'title'
    else:
        frames = [frame for frame in page.frames if urlparse(frame.url).netloc == 'soundcloud.com' and urlparse(frame.url).path == '/n' + TRACK_PATH]
        assert len(frames) == 1, [frame.url for frame in page.frames]
        hero = frames[0].locator('section[aria-label="Track header"] button[aria-label="Play"],section[aria-label="Track header"] button[aria-label="Pause"]')
        hero_attribute = 'aria-label'
    action = hero.get_attribute(hero_attribute)
    initial_playback = page.evaluate('''() => [...capturedMedia].some(media =>
      !media.paused && media.currentTime > 0 && media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0
    )''')
    selection = {'heroBefore': action, 'playbackAlreadyObserved': initial_playback, 'cancelledPendingSelection': False}
    if action == 'Play':
        hero.click()
    elif action == 'Pause':
        if not initial_playback:
            hero.click()
            expect(hero).to_have_attribute(hero_attribute, 'Play')
            selection['cancelledPendingSelection'] = True
    else:
        raise AssertionError(f'Unrecognized actual track control: {action}')
    expect(page.locator('#rate-number')).to_be_visible(timeout=15000)
    page.locator('.playbackSoundBadge__titleLink').wait_for()
    expect(page.locator('.playbackSoundBadge__titleLink')).to_have_attribute('href', re.compile(re.escape(url.rsplit('/', 1)[-1])))
    footer = page.locator('.playControls__play')
    footer_action = footer.get_attribute('title')
    selection['footerBeforePlayback'] = footer_action
    if footer_action == 'Play current':
        footer.click()
    elif footer_action != 'Pause current':
        raise AssertionError(f'Unrecognized actual footer control: {footer_action}')
    page.wait_for_function('''() => [...capturedMedia].some(media =>
      !media.paused && media.currentTime > 0 && media.readyState >= 2 && Number.isFinite(media.duration) && media.duration > 0
    )''', timeout=25000)
    expect(footer).to_have_attribute('title', 'Pause current')
    footer.click()
    page.wait_for_function('() => capturedMedia.size > 0 && [...capturedMedia].every(media => media.paused)', timeout=5000)
    audio_evidence(page)
    return selection


def save_speed(page, value):
    page.locator('#rate-number').fill(str(value))
    page.locator('#rate-number').press('Enter')
    if page.locator('.memory').get_attribute('aria-pressed') != 'true':
        page.locator('.memory').click()
    expect(page.locator('.memory')).to_have_attribute('aria-pressed', 'true')
    saved = page.evaluate('key=>localStorage.getItem(key)', SPEED_KEY)
    assert saved == str(value) or json.loads(saved) == {'rate': value, 'enabled': True}, saved


def rectangle(box, dx=0, dy=0, width=None, height=None):
    return {
        'x': box['x'] + dx,
        'y': box['y'] + dy,
        'width': width if width is not None else box['width'],
        'height': height if height is not None else box['height'],
    }


def capture_recipient(browser, evidence, injection):
    receiver = browser.new_context(viewport={'width': 1440, 'height': 1080}, device_scale_factor=DENSITY)
    receiver.add_init_script(injection)
    incoming = receiver.new_page()
    observe_page(incoming, 'recipient')
    incoming.on('pageerror', lambda error: evidence['pageErrors'].append(str(error)))
    try:
        evidence['recipientSelection'] = load_track(incoming, TRACK)
        assert stored_timeline(incoming) is None
        incoming.goto(evidence['sharedLink'], wait_until='domcontentloaded', timeout=45000)
        expect(incoming.locator('.tempo-editor')).to_be_visible(timeout=15000)
        expect(incoming.locator('.editor-apply-once')).to_be_enabled()
        expect(incoming.locator('.editor-apply-once')).to_have_attribute('aria-pressed', 'false')
        expect(incoming.locator('.editor-save')).to_be_enabled()
        expect(incoming.locator('.editor-status')).to_have_text('')
        assert incoming.locator('.editor-track').evaluate('element=>element.href') == TRACK
        expect(incoming.locator('.editor-point-picker option')).to_have_count(3)
        assert stored_timeline(incoming) is None
        incoming.locator('.speed-range').select_option('fine')
        incoming.locator('.tempo-editor header strong').click()
        record_image(incoming, 'shared-preview.png', evidence, selector='.tempo-editor', state='Actual Drown music timeline link opened in a fresh receiving context after selecting and pausing its track; Apply once and Save timeline are available, neither used yet.')
        for width, name in [(1440, 'share-actions.png'), (390, 'share-actions-mobile.png')]:
            incoming.set_viewport_size({'width': width, 'height': 1080})
            incoming.wait_for_timeout(150)
            expect(incoming.locator('.editor-apply-once')).to_be_enabled()
            expect(incoming.locator('.editor-status')).to_have_text('')
            actions = incoming.locator('.editor-actions').first.bounding_box()
            record_image(incoming, name, evidence,
                         clip=rectangle(actions, 0, -5, actions['width'], actions['height'] + 10),
                         state='Real Drown recipient preview with enabled Apply once / Save timeline choices; the shared tempo has not been applied or saved.')
            assert stored_timeline(incoming) is None
        incoming.locator('.editor-save').click()
        expect(incoming.locator('.editor-status')).to_have_text('Timeline saved.')
        expect(incoming.locator('.editor-enabled')).to_be_checked()
        received = stored_timeline(incoming)
        assert received['enabled'] and received['data']['points'] == evidence['timeline']['data']['points'], received
        evidence['actions'].append('Selected and paused Drown in a fresh receiving context, opened the actual copied link, verified both recipient actions without saved recipient data, then saved through the UI.')
        evidence['recipientAudio'] = audio_evidence(incoming)
        stopped = incoming.evaluate('bufferedPlayerProbe.stop()')
        evidence['recipientClosedAudioContexts'] = stopped['contexts']
        assert all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in stopped['contexts'])
    except Exception:
        capture_failure(incoming, evidence, 'recipient')
        raise
    finally:
        receiver.close()
        evidence['recipientContextClosed'] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-artifact')
    parser.add_argument('--stage-only', action='store_true')
    parser.add_argument('--record-video', action='store_true')
    options = parser.parse_args()
    if os.environ.get('TEMPO_TEST_ARTIFACT') and not options.stage_only:
        parser.error('Candidate captures require --stage-only')
    DESTINATION.mkdir(parents=True, exist_ok=True)
    STAGING.mkdir(parents=True, exist_ok=True)
    artifact = userscript_bytes()
    artifact_hash = hashlib.sha256(artifact).hexdigest()
    if options.expected_artifact:
        assert artifact_hash == options.expected_artifact.lower(), artifact_hash
    script = userscript_source()
    assert script.count(artifact.decode('utf-8')) == 1
    probe = (ROOT / 'tests/fixtures/buffered-player-probe.js').read_bytes()
    injection = MUTE + '\n' + probe.decode('utf-8') + '\n' + script
    evidence = {
        'capturedAt': datetime.now(timezone.utc).isoformat(),
        'capture': 'Exact built userscript UI on a real public music track in isolated Chrome; early injection, not Violentmonkey. Captures are browser screenshots with source metadata added to PNG headers; screenshot pixels are unchanged. Narrow captures are resized desktop-browser windows, not physical mobile devices.',
        'track': TRACK,
        'artifactSha256': artifact_hash,
        'artifactBytes': len(artifact),
        'captureScriptSha256': hashlib.sha256((ROOT / 'tests/capture-showcase.py').read_bytes()).hexdigest(),
        'outputProbeSha256': hashlib.sha256(probe).hexdigest(),
        'muting': ['--mute-audio', 'native media muted with zero volume before play', 'permanent final destination gain zero'],
        'deviceScaleFactor': DENSITY, 'muted': True, 'screenshots': [], 'actions': [], 'pageErrors': [], 'status': 'INCOMPLETE',
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        evidence['browser'] = browser.version
        recording = {'record_video_dir': str(STAGING), 'record_video_size': {'width': 1440, 'height': 1080}} if options.record_video else {}
        context = browser.new_context(viewport={'width': 1440, 'height': 1080}, device_scale_factor=DENSITY, **recording)
        context.grant_permissions(['clipboard-read', 'clipboard-write'], origin='https://soundcloud.com')
        context.add_init_script(injection)
        page = context.new_page()
        observe_page(page, 'sender')
        page.on('pageerror', lambda error: evidence['pageErrors'].append(str(error)))
        try:
            evidence['selection'] = load_track(page, TRACK)
            evidence['observedTitle'] = page.locator('.playbackSoundBadge__titleLink').inner_text()
            save_speed(page, .9)
            evidence['actions'].append('Selected and paused the public Drown music track, then saved 0.90× through the actual tempo field and bookmark control.')
            page.locator('.playbackSoundBadge__titleLink').hover()
            record_image(page, 'soundcloud-player.png', evidence, state='Drown (Sewerslvt Remix) selected on its actual public SoundCloud page, playback paused, tempo 0.90× saved.')
            control = page.locator('#soundcloud-tempo-control .controls').bounding_box()
            record_image(page, 'player-controls.png', evidence,
                         clip=rectangle(control, -6, -5, control['width'] + 12, control['height'] + 10),
                         state='Genuine footer controls at 0.90× with remembered tempo.')
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            page.locator('#copy-tempo-links').check()
            page.locator('.open-editor').click()
            page.locator('.point-rate').fill('1')
            page.locator('.point-rate').press('Tab')
            graph = page.locator('.editor-graph')
            durations = [item['duration'] for item in media_state(page) if item['duration'] is not None]
            assert len(durations) == 1, durations
            duration = durations[0]
            assert 60 < duration < 3600, duration
            for x, time, rate, fade in [(235, round(duration / 3), .75, round(duration / 4)), (490, round(duration * .75), .9, round(duration / 3))]:
                graph.dblclick(position={'x': x, 'y': 110})
                for name, value in [('time', time), ('rate', rate), ('duration', fade)]:
                    page.locator('.point-' + name).fill(str(value))
                    page.locator('.point-' + name).press('Tab')
                page.locator('.point-curve').select_option('smooth')
            page.locator('.editor-save').click()
            expect(page.locator('.editor-status')).to_have_text('Timeline saved.')
            expect(page.locator('.editor-enabled')).to_be_checked()
            expect(page.locator('.playback-state')).to_have_text('Saved timeline · Natural')
            page.locator('.speed-range').select_option('fine')
            page.locator('.tempo-editor header strong').click()
            record_image(page, 'soundcloud-timeline.png', evidence, selector='.tempo-editor', state='Three-point natural-pitch timeline saved and enabled, smooth fades, selected 0.90× point.')
            record_image(page, 'timeline-curve.png', evidence, selector='.editor-graph', state='Complete saved 1× → 0.75× → 0.90× curve, close speed range.')
            page.set_viewport_size({'width': 390, 'height': 1080})
            page.wait_for_timeout(150)
            record_image(page, 'timeline-detail.png', evidence, selector='.editor-graph',
                         state='Same saved curve rendered by the real editor in a narrow desktop browser window.')
            page.set_viewport_size({'width': 1440, 'height': 1080})
            page.locator('.editor-link').click()
            link = page.evaluate('navigator.clipboard.readText()')
            assert link.startswith(TRACK + '#sct=SCT1.'), link
            payload = link.split('#sct=SCT1.', 1)[1]
            shared = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
            assert shared['track'] == TRACK_PATH and [point['r'] for point in shared['points']] == [1, .75, .9], shared
            evidence['sharedLink'] = link
            evidence['sharedPayload'] = shared
            evidence['timeline'] = stored_timeline(page)
            assert evidence['timeline']['enabled'] and evidence['timeline']['data']['points'] == shared['points']
            evidence['actions'].append('Saved and enabled a three-point timeline; copied its actual SCT1 link.')
            page.locator('.editor-close').click()
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            expect(page.locator('.saved-setting')).to_have_count(2)
            expect(page.locator('.saved-row input[type=number]')).to_have_value('0.9')
            expect(page.get_by_role('checkbox', name=f'Use saved speed for {TRACK_PATH}', exact=True)).to_be_checked()
            expect(page.get_by_role('checkbox', name=f'Use saved timeline for {TRACK_PATH}', exact=True)).to_be_checked()
            expect(page.get_by_role('button', name=f'Edit timeline for {TRACK_PATH}', exact=True)).to_be_visible()
            evidence['savedLibraryText'] = page.locator('.saved-list').inner_text()
            page.locator('#settings-title').click()
            record_image(page, 'soundcloud-settings.png', evidence, selector='.settings', state='One real music track, Drown, with its saved 0.90× speed and enabled three-point timeline; copied-link tempo sharing enabled.')
            memory = page.locator('.saved-list').bounding_box()
            record_image(page, 'saved-tracks.png', evidence,
                         clip=rectangle(memory, -6, -6, memory['width'] + 12, memory['height'] + 12),
                         state='One genuine Drown saved-library row containing both 0.90× speed and Timeline controls, created entirely through the UI.')
            page.set_viewport_size({'width': 390, 'height': 1080})
            page.wait_for_timeout(150)
            record_image(page, 'saved-tracks-mobile.png', evidence, selector='.saved-list',
                         state='The same genuine Drown speed-and-timeline row in a 390-pixel-wide desktop-browser viewport.')
            evidence['audio'] = audio_evidence(page)
            capture_recipient(browser, evidence, injection)
            if options.record_video:
                page.set_viewport_size({'width': 1440, 'height': 1080})
                page.locator('.open-editor').click()
                page.locator('.playControls__play').click()
                page.wait_for_function('() => [...capturedMedia].some(media => !media.paused)', timeout=10000)
                before = media_state(page)
                point = page.locator('.editor-graph circle').nth(2).bounding_box()
                x, y = point['x'] + point['width'] / 2, point['y'] + point['height'] / 2
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x - 70, y - 30, steps=60)
                page.mouse.up()
                page.locator('.editor-save').click()
                expect(page.locator('.editor-status')).to_have_text('Timeline saved.')
                page.wait_for_timeout(1500)
                after = media_state(page)
                assert any(end['time'] > start['time'] for start, end in zip(before, after))
                page.locator('.playControls__play').click()
                page.wait_for_function('() => [...capturedMedia].every(media => media.paused)', timeout=5000)
                evidence['videoInteraction'] = {'before': before, 'after': after, 'action': 'Dragged and saved an actual timeline point during muted playback'}
            evidence['trackPlaybackObserved'] = any(item['time'] > 0 and item['readyState'] >= 2 for item in evidence['audio']['media'])
            assert evidence['trackPlaybackObserved']
            assert len(evidence['screenshots']) == 11
            assert all(item['url'].startswith(TRACK) and '/nasa/' not in item['url'] for item in evidence['screenshots'])
            stopped = page.evaluate('bufferedPlayerProbe.stop()')
            evidence['closedAudioContexts'] = stopped['contexts']
            assert all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in stopped['contexts'])
            assert hashlib.sha256(userscript_bytes()).hexdigest() == artifact_hash, 'Artifact changed during capture'
            evidence['status'] = 'CAPTURED'
        except Exception as error:
            evidence['error'] = str(error)
            if 'failure' not in evidence:
                capture_failure(page, evidence, 'sender')
            raise
        finally:
            context.close()
            evidence['contextClosed'] = True
            browser.close()
            evidence['browserClosed'] = True
            if options.record_video:
                video = Path(page.video.path())
                evidence['video'] = {'file': str(video), 'sha256': hashlib.sha256(video.read_bytes()).hexdigest(), 'scope': 'Unedited full workflow recording; frame rate not asserted'}
            (STAGING / 'capture.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    if options.stage_only:
        print(json.dumps({'status': evidence['status'], 'directory': str(STAGING), 'published': False}))
        return
    for item in evidence['screenshots']:
        captured = STAGING / item['file']
        assert hashlib.sha256(captured.read_bytes()).hexdigest() == item['sha256']
        captured.replace(DESTINATION / item['file'])
    (ROOT / 'docs/screenshot-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
