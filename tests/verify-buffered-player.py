import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source

TRACK = 'https://soundcloud.com/nasa/sounds-of-the-sun'


def check(value, message):
    if not value:
        raise AssertionError(message)


def assess_diagnostics(report):
    warnings = report.get('projectWarnings', [
        message for message in report.get('consoleWarnings', [])
        if message.startswith('[SoundCloud Tempo]')
    ])
    warning_count = report.get('projectWarningCount', len(warnings))
    page_error_count = report.get('pageErrorCount', len(report.get('pageErrors', [])))
    report['runtimeDiagnostics'] = {
        'status': 'PASSED' if not warning_count and not page_error_count else 'INCOMPLETE',
        'projectWarnings': warnings,
        'projectWarningCount': warning_count,
        'pageErrorCount': page_error_count,
    }
    if warning_count or page_error_count:
        report['status'] = 'INCOMPLETE'
        report.setdefault('error', {
            'phase': 'runtime-diagnostics',
            'message': f'{warning_count} project warning(s), {page_error_count} uncaught page error(s).',
        })


def public_url(url):
    parsed = urlsplit(url)
    return f'{parsed.scheme}://{parsed.netloc}{parsed.path}'


def snapshot(page):
    return page.evaluate('bufferedPlayerProbe.snapshot()')


def dismiss_overlays(page, consent_wait=8000, auth_wait=6):
    reject = page.get_by_role('button', name=re.compile('^Reject all$', re.I)).first
    try:
        reject.wait_for(state='visible', timeout=consent_wait)
    except Exception:
        check(not page.locator('.onetrust-pc-dark-filter:visible').count(), 'Consent overlay blocks public playback')
    if reject.count() and reject.is_visible():
        reject.click(timeout=3000)
    page.locator('.onetrust-pc-dark-filter').wait_for(state='hidden', timeout=10000)
    deadline = time.monotonic() + auth_wait
    while time.monotonic() < deadline:
        modal = page.locator('.auth-modal:visible')
        if modal.count():
            modal.get_by_role('button', name='Close', exact=True).click(timeout=3000)
            modal.wait_for(state='hidden', timeout=3000)
            break
        page.wait_for_timeout(200)


def play_public_track(page):
    button = page.locator('.soundTitle__playButtonHero .playButton').first
    button.wait_for(state='visible', timeout=15000)
    title = button.get_attribute('title')
    if title == 'Play':
        button.click(timeout=5000)
    elif title != 'Pause':
        raise AssertionError(f'Unrecognized public player action: {title}')


def select_tempo(page, value):
    number = page.locator('#rate-number')
    number.fill(str(value))
    number.press('Enter')
    check(abs(float(number.input_value()) - value) < 0.0000001, 'Tempo input did not retain the requested speed')


def saved_settings(page):
    return page.evaluate('''() => ({
        tempo: localStorage.getItem('soundcloud.tempo.track.' + encodeURIComponent('/nasa/sounds-of-the-sun')),
        preserve: localStorage.getItem('soundcloud.tempo.preserveKey'),
        wasm: localStorage.getItem('soundcloud.tempo.useWasm'),
        rateInput: document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('#rate-number')?.value,
        pitchChecked: document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('#preserve-key')?.checked,
        settingsVisible: document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('.settings-button')?.getAttribute('aria-expanded') === 'true',
    })''')


def pause_public_track(page):
    button = page.locator('.soundTitle__playButtonHero .playButton').first
    button.wait_for(state='visible', timeout=15000)
    title = button.get_attribute('title')
    if title == 'Pause':
        button.click(timeout=5000)
    elif title != 'Play':
        raise AssertionError(f'Unrecognized public pause action: {title}')
    page.wait_for_function('bufferedPlayerProbe.snapshot().media.every(audio=>audio.paused && audio.nativePaused)', timeout=10000)


def saved_reloads(page, report):
    report['savedReloads'] = []
    select_tempo(page, 0.025)
    memory = page.locator('.memory')
    check(memory.get_attribute('aria-pressed') == 'false', 'Fresh test profile unexpectedly contains a saved tempo')
    memory.click()
    page.wait_for_function('localStorage.getItem("soundcloud.tempo.track." + encodeURIComponent("/nasa/sounds-of-the-sun")) === "0.025"')
    for mode in ['natural', 'preserve']:
        result = {'mode': mode, 'status': 'INCOMPLETE', 'phase': 'save-settings'}
        report['savedReloads'].append(result)
        if page.locator('.settings-button').get_attribute('aria-expanded') != 'true':
            page.locator('.settings-button').click()
        if not page.locator('.advanced-audio').evaluate('element=>element.open'):
            page.locator('.advanced-audio summary').click()
        page.locator('#preserve-key').set_checked(mode == 'preserve')
        page.locator('#use-wasm').check()
        result['saved'] = saved_settings(page)
        check(result['saved']['tempo'] == '0.025', 'UI did not persist the exact saved low rate')
        check((result['saved']['preserve'] == 'true') == (mode == 'preserve'), 'UI did not persist the requested pitch mode')
        pause_public_track(page)
        result['immediatePause'] = snapshot(page)
        page.wait_for_timeout(1000)
        result['beforeReload'] = snapshot(page)
        check(all(audio['paused'] for audio in result['beforeReload']['media']), 'Paused playback restarted before reload')
        check(result['beforeReload']['heroAction'] == 'Play', 'Host UI did not retain its paused action before reload')
        result['phase'] = 'reload'
        page.reload(wait_until='domcontentloaded', timeout=35000)
        page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
        dismiss_overlays(page, consent_wait=1500, auth_wait=2)
        result['afterReload'] = snapshot(page)
        result['restored'] = saved_settings(page)
        check(result['afterReload']['documentId'] != result['beforeReload']['documentId'], 'Reload did not create a fresh document')
        check(result['afterReload']['panelCount'] == 1, 'Reload created duplicate controllers')
        check(result['restored']['tempo'] == '0.025', 'Reload lost the exact saved tempo')
        check((result['restored']['preserve'] == 'true') == (mode == 'preserve'), 'Reload did not restore the saved pitch preference')
        result['pausedReload'] = all(audio['paused'] for audio in result['afterReload']['media'])
        result['startupCause'] = 'host-requested-resume'
        check(not result['afterReload']['clickEvents'], 'Host-resume reload unexpectedly received a click')
        check(any(event['name'] == 'play' and 'a-v2.sndcdn.com/assets/' in event['stack'] for event in result['afterReload']['commandEvents']), 'Reload has no observed SoundCloud Play request')
        result['phase'] = 'host-requested-play'
        page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio=>!audio.paused && audio.playbackRate===0.025)', timeout=30000)
        observed = snapshot(page)
        active = [audio for audio in observed['media'] if not audio['paused'] and not audio['ended']]
        check(len(active) == 1, 'Saved-rate startup media selection is ambiguous')
        result['selected'] = page.evaluate('id=>bufferedPlayerProbe.select(id)', active[0]['id'])
        check(abs(float(page.locator('#rate-number').input_value()) - 0.025) < 0.0000001, 'Host Play did not restore the saved low rate')
        check(abs(result['selected']['selected']['nativePosition']) < 0.000001, 'Reload required native clock warmup before buffered playback')
        result['phase'] = 'measure'
        label = 'Buffered playback · Preserve key.' if mode == 'preserve' else 'Buffered playback · Natural pitch.'
        result['playback'] = measure(page, 0.025, True, label)
        events = result['playback']['points'][-1]['snapshot']['rateEvents']
        check(any(event['id'] == active[0]['id'] and abs(event['playbackRate'] - 0.025) < 0.000001 and abs(event['defaultPlaybackRate'] - 0.025) < 0.000001 for event in events), 'Saved-rate startup did not publish its low rate to the media listener')
        page.locator('.settings-button').click()
        result['visibleSettings'] = saved_settings(page)
        check(result['visibleSettings']['settingsVisible'] and result['visibleSettings']['pitchChecked'] == (mode == 'preserve'), 'Reload settings did not show the restored pitch preference when opened')
        result['status'] = 'PASSED'
        result['phase'] = 'complete'


def saved_startups(browser, initialization, report):
    report['savedStartups'] = []
    for saved in report['savedReloads']:
        result = {
            'mode': saved['mode'],
            'scope': 'Fresh isolated context receives only exact userscript preferences copied from this run\'s UI-saved snapshot. No host storage, cookies, auth or session data are copied. This storage fixture is separate from actual UI-save/reload coverage.',
            'status': 'INCOMPLETE',
            'phase': 'prepare',
        }
        report['savedStartups'].append(result)
        preferences = {
            'soundcloud.tempo.track.%2Fnasa%2Fsounds-of-the-sun': saved['saved']['tempo'],
            'soundcloud.tempo.preserveKey': saved['saved']['preserve'],
            'soundcloud.tempo.useWasm': saved['saved']['wasm'],
        }
        result['copiedPreferences'] = {key: value for key, value in preferences.items() if value is not None}
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        observe_page(page, report)
        seed = 'if (window.top === window && location.origin === "https://soundcloud.com") { for (const [key,value] of Object.entries(' + json.dumps(result['copiedPreferences']) + ')) localStorage.setItem(key,value); }\n'
        context.add_init_script(seed + initialization)
        try:
            result['phase'] = 'navigate'
            page.goto(TRACK, wait_until='domcontentloaded', timeout=35000)
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            dismiss_overlays(page)
            result['initialReady'] = snapshot(page)
            initial = result['initialReady']
            if initial['heroAction'] == 'Pause' and all(audio['paused'] and audio['nativePaused'] for audio in initial['media']) and not any(event['name'] == 'play' for event in initial['commandEvents']):
                check(all(audio['position'] == 0 and audio['nativePosition'] == 0 and audio['peak'] == 0 for audio in initial['media']), 'Pending autoplay was not cold before cancellation')
                result['pendingAutoplayCancelledViaUi'] = True
                pause_public_track(page)
                page.wait_for_function('bufferedPlayerProbe.snapshot().heroAction === "Play"', timeout=10000)
                page.wait_for_timeout(1000)
            elif initial['heroAction'] != 'Play':
                try:
                    page.wait_for_function('bufferedPlayerProbe.snapshot().heroAction === "Play" || bufferedPlayerProbe.snapshot().commandEvents.some(event=>event.name === "play")', timeout=10000)
                except Exception:
                    result['readinessTimeout'] = True
            result['beforePlay'] = snapshot(page)
            result['restored'] = saved_settings(page)
            check(result['beforePlay']['panelCount'] == 1, 'Fresh saved startup created duplicate controllers')
            check(all(audio['paused'] and audio['nativePaused'] for audio in result['beforePlay']['media']), 'Fresh saved startup played before explicit Play')
            check(not any(event['name'] == 'play' for event in result['beforePlay']['commandEvents']), 'Fresh saved startup received Play before explicit action')
            check(all(audio['position'] == 0 and audio['nativePosition'] == 0 and audio['peak'] == 0 for audio in result['beforePlay']['media']), 'Fresh saved startup was not silent at source position zero before explicit Play')
            check(result['beforePlay']['heroAction'] == 'Play', 'Fresh saved startup does not offer initial Play')
            check(result['restored']['tempo'] == '0.025' and (result['restored']['preserve'] == 'true') == (saved['mode'] == 'preserve'), 'Fresh saved startup did not load exact copied preferences')
            result['phase'] = 'first-explicit-play'
            click_count = len(result['beforePlay']['clickEvents'])
            play_public_track(page)
            page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio=>!audio.paused && audio.playbackRate===0.025)', timeout=30000)
            observed = snapshot(page)
            active = [audio for audio in observed['media'] if not audio['paused'] and not audio['ended']]
            check(len(active) == 1, 'Fresh saved startup media selection is ambiguous')
            result['selected'] = page.evaluate('id=>bufferedPlayerProbe.select(id)', active[0]['id'])
            clicks = observed['clickEvents'][click_count:]
            check(len(clicks) == 1 and clicks[0]['isTrusted'], 'Fresh saved startup did not use exactly one trusted Play click')
            check(any(event['name'] == 'play' and event['time'] >= clicks[0]['time'] and 'a-v2.sndcdn.com/assets/' in event['stack'] for event in observed['commandEvents']), 'Fresh saved startup has no host Play request after the click')
            check(abs(result['selected']['selected']['nativePosition']) < 0.000001, 'Fresh saved startup required native clock warmup')
            result['phase'] = 'measure'
            label = 'Buffered playback · Preserve key.' if saved['mode'] == 'preserve' else 'Buffered playback · Natural pitch.'
            result['playback'] = measure(page, 0.025, True, label)
            events = result['playback']['points'][-1]['snapshot']['rateEvents']
            check(any(event['id'] == active[0]['id'] and abs(event['playbackRate'] - 0.025) < 0.000001 and abs(event['defaultPlaybackRate'] - 0.025) < 0.000001 for event in events), 'Fresh saved startup did not publish the low rate')
            page.locator('.settings-button').click()
            result['visibleSettings'] = saved_settings(page)
            check(result['visibleSettings']['settingsVisible'] and result['visibleSettings']['pitchChecked'] == (saved['mode'] == 'preserve'), 'Fresh startup settings did not show the restored pitch preference when opened')
            result['status'] = 'PASSED'
            result['phase'] = 'complete'
        except Exception as error:
            result['error'] = str(error)[:4000]
            result['failureSnapshot'] = snapshot(page)
            raise
        finally:
            try:
                result['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in result['stopped']['contexts']), 'Fresh startup contexts did not close muted')
            finally:
                context.close()
                result['contextClosed'] = True


def observe_page(page, report):
    def relevant(url):
        return any(value in url for value in ['.m3u8', '.m4s', 'media-streaming.soundcloud.cloud', 'mediabunny', 'SignalsmithStretch'])
    def record(bucket, value):
        if len(report[bucket]) < 120:
            report[bucket].append(value)
    def page_error(error):
        report['pageErrorCount'] = report.get('pageErrorCount', 0) + 1
        record('pageErrors', str(error)[:2000])
    def console_message(message):
        if message.type not in ['warning', 'error']:
            return
        text = message.text[:2000]
        record('consoleWarnings', text)
        if text.startswith('[SoundCloud Tempo]'):
            report['projectWarningCount'] = report.get('projectWarningCount', 0) + 1
            warnings = report.setdefault('projectWarnings', [])
            if len(warnings) < 32:
                warnings.append(text)
    page.on('pageerror', page_error)
    page.on('console', console_message)
    page.on('request', lambda request: record('requests', {'url': public_url(request.url), 'method': request.method, 'type': request.resource_type}) if relevant(request.url) else None)
    page.on('response', lambda response: record('responses', {'url': public_url(response.url), 'status': response.status}) if relevant(response.url) else None)
    page.on('requestfailed', lambda request: record('requestFailures', {'url': public_url(request.url), 'failure': request.failure}) if relevant(request.url) else None)


def native_reload_control(page, report):
    result = {'status': 'INCOMPLETE'}
    report['nativeReloadControl'] = result
    select_tempo(page, 0.85)
    result['playback'] = measure(page, 0.85, False, 'Natural pitch follows speed.')
    memory = page.locator('.memory')
    check(memory.get_attribute('aria-pressed') == 'false', 'Native control profile unexpectedly contains a saved tempo')
    memory.click()
    page.wait_for_function('localStorage.getItem("soundcloud.tempo.track." + encodeURIComponent("/nasa/sounds-of-the-sun")) === "0.85"')
    pause_public_track(page)
    page.wait_for_timeout(1000)
    result['beforeReload'] = snapshot(page)
    check(all(audio['paused'] for audio in result['beforeReload']['media']), 'Native control restarted before reload')
    check(result['beforeReload']['heroAction'] == 'Play', 'Native control host UI did not retain paused action')
    page.reload(wait_until='domcontentloaded', timeout=35000)
    page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
    dismiss_overlays(page, consent_wait=1500, auth_wait=2)
    result['afterReload'] = snapshot(page)
    check(result['afterReload']['documentId'] != result['beforeReload']['documentId'], 'Native control reload did not create a fresh document')
    result['autoResumed'] = any(not audio['paused'] for audio in result['afterReload']['media'])
    result['hostPlayObserved'] = any(event['name'] == 'play' and 'a-v2.sndcdn.com/assets/' in event['stack'] for event in result['afterReload']['commandEvents'])
    check(not result['afterReload']['clickEvents'], 'Native control reload unexpectedly received a click')
    if result['autoResumed']:
        check(result['hostPlayObserved'], 'Native control resumed without observed host Play')
        check(all(not audio['nativePaused'] and abs(audio['playbackRate'] - 0.85) < 0.000001 for audio in result['afterReload']['media'] if not audio['paused']), 'Native control did not use native .85 playback')
    result['status'] = 'OBSERVED'


def measure(page, rate, buffered, expected_label):
    page.wait_for_function('''({buffered, expectedLabel}) => {
        const value=bufferedPlayerProbe.snapshot();
        const audio=value.selected;
        return value.label===expectedLabel && audio && !audio.paused && audio.contextState==='running' && audio.sinkGain===0 && audio.finite && audio.peak>1e-7 &&
          (buffered ? audio.nativePaused && /Buffered playback/.test(value.label) : !audio.nativePaused && !/Buffered|Preparing|Buffering/.test(value.label || ''));
    }''', arg={'buffered': buffered, 'expectedLabel': expected_label}, timeout=45000)
    page.wait_for_timeout(500)
    first = snapshot(page)
    points = []
    for _ in range(5):
        page.wait_for_timeout(100)
        current = snapshot(page)
        check(current['label'] == expected_label, f'Unexpected playback mode: {current["label"]}')
        before = first['selected']
        after = current['selected']
        check(abs(after['playbackRate'] - rate) < 0.000001, f'Public playbackRate did not equal {rate}')
        check(abs(after['defaultPlaybackRate'] - rate) < 0.000001, f'Public defaultPlaybackRate did not equal {rate}')
        check(not after['paused'] and after['finite'] and after['peak'] > 1e-7, 'Playback stopped or produced no finite signal')
        check(after['sinkGain'] == 0, 'Diagnostic destination was not permanently muted')
        progress = after['position'] - before['position']
        minimum = rate * (after['before'] - before['after'])
        maximum = rate * (after['after'] - before['before'])
        tolerance = 0.00005 if buffered else 0.035
        check(minimum - tolerance <= progress <= maximum + tolerance, f'Playback clock mismatch: {progress} not in {minimum}..{maximum} at {rate}')
        if buffered:
            check(after['nativePaused'], 'Buffered playback left native media playing')
            check(abs(after['nativePosition'] - before['nativePosition']) < 0.000001, 'Parked native clock advanced')
        else:
            check(not after['nativePaused'], 'Native handback did not resume')
            check(abs(after['playbackRate'] - rate) < 0.000001, 'Native playback rate was not restored')
        points.append({'snapshot': current, 'progress': progress, 'expectedMinimum': minimum, 'expectedMaximum': maximum})
    return {'rate': rate, 'buffered': buffered, 'expectedLabel': expected_label, 'first': first, 'points': points}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--startup-only', action='store_true')
    parser.add_argument('--no-minimum-override', action='store_true')
    parser.add_argument('--minimum-override', action='store_true')
    parser.add_argument('--saved-reload', action='store_true')
    parser.add_argument('--native-reload-control', action='store_true')
    parser.add_argument('--artifact', default='dist/soundcloud-tempo-control.user.js')
    options = parser.parse_args()
    check(not (options.minimum_override and options.no_minimum_override), 'Conflicting minimum override flags')
    check(not options.native_reload_control or (not options.minimum_override and not options.saved_reload and not options.startup_only), 'Native reload control requires an unmodified standalone full run')
    check(not options.saved_reload or (not options.minimum_override and not options.startup_only), 'Saved reload verification requires an unmodified full run')
    artifact_path = ROOT / options.artifact
    artifact = artifact_path.read_bytes()
    original = artifact.decode('utf-8')
    if options.saved_reload:
        check(original.count('const MIN = 0.025;') == 1, 'Saved reload verification requires the actual 0.025 minimum in the artifact')
    injection = userscript_source(artifact_path)
    check(injection.count(original) == 1, 'Artifact changed while reading the pinned dependency and script')
    modified = original
    override = None
    if options.minimum_override:
        source = 'const MIN = 0.25;'
        target = 'const MIN = 0.025;'
        check(original.count(source) == 1, 'Expected exactly one reviewed minimum-rate override point')
        modified = original.replace(source, target, 1)
        injection = injection.replace(original, modified, 1)
        override = {'from': source, 'to': target, 'count': 1, 'inMemoryOnly': True}
    fixture = (ROOT / 'tests/fixtures/buffered-player-probe.js').read_bytes()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'track': TRACK,
        'scope': 'Full built userscript with pinned @require bytes; any explicit legacy in-memory MIN override is recorded and saved-reload checks require no override. Public signed-out NASA track in an isolated browser. Native media/clock/call observation and final destination analyser plus permanent gain0 are diagnostic instrumentation; no source URLs or internal factories are injected. Save/reload settings are written through the userscript UI; separately labelled fresh-start fixtures copy only those exact application keys into empty contexts. Not an installed-manager or personal-profile test.',
        'eventObservation': 'A normal non-capture ratechange listener on the actual media element records host-visible dispatch without intercepting or generating events.',
        'artifactSha256': hashlib.sha256(artifact).hexdigest(),
        'artifactBytes': len(artifact),
        'minimumOverride': override,
        'savedReloadRequested': options.saved_reload,
        'modifiedArtifactSha256': hashlib.sha256(modified.encode()).hexdigest(),
        'injectedSourceSha256': hashlib.sha256(injection.encode()).hexdigest(),
        'probeSha256': hashlib.sha256(fixture).hexdigest(),
        'verifierSha256': hashlib.sha256((ROOT / 'tests/verify-buffered-player.py').read_bytes()).hexdigest(),
        'status': 'INCOMPLETE',
        'requests': [], 'responses': [], 'requestFailures': [], 'pageErrors': [], 'consoleWarnings': [],
    }
    phase = 'startup'
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        observe_page(page, report)
        initialization = fixture.decode() + '\nif (window.top === window && location.origin === "https://soundcloud.com") {\n' + injection + '\nbufferedPlayerProbe.observeCommands();\n}'
        context.add_init_script(initialization)
        try:
            response = page.goto(TRACK, wait_until='domcontentloaded', timeout=35000)
            report['navigation'] = {'url': public_url(page.url), 'status': response.status if response else None}
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            check(page.locator('#soundcloud-tempo-control').count() == 1, 'Userscript created duplicate controllers')
            report['startup'] = snapshot(page)
            if options.startup_only:
                report['status'] = 'STARTUP_PASSED'
            else:
                phase = 'public-native-play'
                dismiss_overlays(page)
                play_public_track(page)
                page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio=>!audio.paused && audio.position>2)', timeout=30000)
                observed = snapshot(page)
                active = [audio for audio in observed['media'] if not audio['paused'] and not audio['ended'] and audio['position'] > 0]
                check(len(active) == 1, 'Public native player selection is ambiguous')
                report['nativeBaseline'] = page.evaluate('id=>bufferedPlayerProbe.select(id)', active[0]['id'])
                check(report['nativeBaseline']['selected']['sinkGain'] == 0, 'Native graph was not routed through the diagnostic mute')
                page.locator('.settings-button').click()
                page.locator('.advanced-audio summary').click()
                page.locator('#preserve-key').uncheck()
                page.locator('#use-wasm').check()
                if options.native_reload_control:
                    phase = 'native-reload-control'
                    native_reload_control(page, report)
                    report['status'] = 'NATIVE_CONTROL_OBSERVED'
                else:
                    phase = 'natural-0025'
                    select_tempo(page, 0.025)
                    report['natural'] = measure(page, 0.025, True, 'Buffered playback · Natural pitch.')
                    natural_events = report['natural']['points'][-1]['snapshot']['rateEvents']
                    check(any(event['id'] == active[0]['id'] and abs(event['playbackRate'] - 0.025) < 0.000001 and abs(event['defaultPlaybackRate'] - 0.025) < 0.000001 for event in natural_events), 'The buffered ratechange event did not reach the media host listener')
                    phase = 'preserve-0025'
                    page.locator('#preserve-key').check()
                    report['preserve'] = measure(page, 0.025, True, 'Buffered playback · Preserve key.')
                    phase = 'muted'
                    was_muted = report['preserve']['points'][-1]['snapshot']['selected']['muted']
                    page.evaluate('bufferedPlayerProbe.mute(true)')
                    page.wait_for_timeout(600)
                    report['muted'] = snapshot(page)
                    check(report['muted']['selected']['peak'] < 0.000001, 'Muted buffered output was not silent after settling')
                    page.evaluate('value=>bufferedPlayerProbe.mute(value)', was_muted)
                    phase = 'native-return-085'
                    report['beforeNativeReturn'] = snapshot(page)
                    page.locator('#preserve-key').uncheck()
                    select_tempo(page, 0.85)
                    report['nativeReturn'] = measure(page, 0.85, False, 'Natural pitch follows speed.')
                    return_events = report['nativeReturn']['points'][-1]['snapshot']['rateEvents']
                    check(any(event['id'] == active[0]['id'] and abs(event['playbackRate'] - 0.85) < 0.000001 and abs(event['defaultPlaybackRate'] - 0.85) < 0.000001 for event in return_events), 'The native handback ratechange event did not reach the media host listener')
                    before_return = report['beforeNativeReturn']['selected']
                    after_return = report['nativeReturn']['first']['selected']
                    return_progress = after_return['position'] - before_return['position']
                    check(-0.00005 <= return_progress <= 0.85 * (after_return['after'] - before_return['before']) + 0.035, 'Native handback lost the buffered source position')
                    if options.saved_reload:
                        phase = 'saved-low-rate-reload'
                        saved_reloads(page, report)
                        pause_public_track(page)
                        phase = 'fresh-saved-low-rate-startup'
                        saved_startups(browser, initialization, report)
                    report['status'] = 'PASSED'
        except Exception as error:
            report['error'] = {'phase': phase, 'name': type(error).__name__, 'message': str(error)[:4000]}
            try:
                report['failureSnapshot'] = snapshot(page)
                report['page'] = {'title': page.title(), 'url': public_url(page.url), 'bodyExcerpt': page.locator('body').inner_text(timeout=2000)[:4000]}
            except Exception as capture:
                report['captureError'] = str(capture)[:1000]
        finally:
            try:
                report['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in report['stopped']['contexts']), 'Diagnostic audio contexts did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)[:2000]
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    assess_diagnostics(report)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    kind = 'native-control' if options.native_reload_control else 'playback'
    output = ROOT / f'test-results/buffered-player-{kind}-{stamp}.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'artifactSha256': report['artifactSha256'], 'file': str(output), 'error': report.get('error'), 'pageErrors': report['pageErrors'], 'failureSnapshot': report.get('failureSnapshot')}, indent=2))
    return 0 if report['status'] in ['PASSED', 'STARTUP_PASSED', 'NATIVE_CONTROL_OBSERVED'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
