import argparse
import hashlib
import importlib.util
import json
import math
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source


spec = importlib.util.spec_from_file_location('transitions', ROOT / 'tests/verify-buffered-transitions.py')
transitions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transitions)
player = transitions.player
snapshot = transitions.snapshot


def repeat_state(page):
    return page.locator('.repeatControl').evaluate('element=>({title:element.title,className:element.className,html:element.outerHTML})')


def set_repeat(page, enabled):
    states = []
    for _ in range(4):
        state = repeat_state(page)
        states.append(state)
        classes = state['className'].split()
        player.check(state['title'] == 'Repeat', 'Unrecognized native repeat control')
        one, all_tracks = 'm-one' in classes, 'm-all' in classes
        player.check(not (one and all_tracks), 'Ambiguous native repeat state')
        if (one if enabled else not one and not all_tracks):
            return states
        page.locator('.repeatControl').click()
    raise AssertionError('Native repeat control did not reach the requested mode')


def completed_dispatch(dispatches, media_id, source, rate, since=0):
    if not isinstance(source, str) or not source:
        return None
    for event in dispatches:
        value = event.get('before') or {}
        if not (
            event.get('id') == media_id
            and event.get('name') in ['timeupdate', 'ended']
            and value.get('source', {}).get('src') == source
            and value.get('ended') is True
            and value.get('paused') is True
            and value.get('nativePaused') is True
            and value.get('nativeEnded') is False
            and value.get('playbackRate') == rate
        ):
            continue
        position, duration = value.get('position'), value.get('duration')
        time = value.get('time')
        if not all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item) for item in [position, duration, time]):
            continue
        if time >= since and duration > 0 and abs(position - duration) < 0.00005:
            return event
    return None


def repeat_once(page, report, mode, cycle, tail_seconds):
    rate = 0.025
    before = snapshot(page)
    active = before['selected']
    result = {'mode': mode, 'cycle': cycle, 'status': 'INCOMPLETE', 'before': before}
    report['repeats'].append(result)
    player.check(active and not active['paused'] and active['nativePaused'], 'Repeat requires active buffered playback')
    player.check(active['duration'] and active['duration'] > 12, 'Track is too short for a distinct repeat observation')
    player.check(active['playbackRate'] == rate and active['defaultPlaybackRate'] == rate, 'Repeat source has the wrong rate')
    result['repeatState'] = repeat_state(page)
    player.check('m-one' in result['repeatState']['className'].split(), 'Repeat-one is not enabled')
    source = transitions.source_identity(before['sources'][active['id']])
    player.check(bool(source), 'Repeat source identity is unavailable')
    progress = page.locator('.playbackTimeline__progressBackground')
    box = progress.bounding_box()
    player.check(box and box['width'] > 80, 'Native seek control is not measurable')
    pixels = max(0.75, box['width'] * tail_seconds / active['duration'])
    point = {'x': box['x'] + box['width'] - pixels, 'y': box['y'] + box['height'] / 2}
    player.check(page.evaluate('point=>Boolean(document.elementFromPoint(point.x,point.y)?.closest(".playbackTimeline"))', point), 'Native tail seek is obstructed')
    result['seekGeometry'] = {'box': box, 'point': point, 'tailPixels': pixels}
    result['observation'] = page.evaluate('bufferedTransitionsProbe.beginTail()')
    page.mouse.click(point['x'], point['y'])
    page.wait_for_function('''({id,duration})=>{
      const value=bufferedTransitionsProbe.snapshot(), audio=value.media[id];
      return audio && !audio.paused && !value.sources[id].seeking && audio.position>duration-5;
    }''', arg={'id': active['id'], 'duration': active['duration']}, timeout=15000)
    result['afterSeek'] = snapshot(page)
    result['tailEstablishedTime'] = page.evaluate('performance.now()')
    selected = result['afterSeek']['selected']
    remaining = selected['duration'] - selected['position']
    player.check(result['afterSeek']['loadedTrack'] == before['loadedTrack'] and 0 < remaining <= 4, 'Seek did not leave a bounded nonempty tail on the same track')
    result['remainingSourceSeconds'] = remaining
    result['timeoutMs'] = min(180000, math.ceil((remaining / rate + 25) * 1000))
    click_count = len(result['afterSeek']['clickEvents'])
    player.check(click_count == len(before['clickEvents']) + 1, 'Tail seek was not recorded as exactly one click')
    last_click = result['afterSeek']['clickEvents'][-1]
    player.check(last_click['isTrusted'] and last_click['time'] >= result['observation']['time'], 'Tail seek click lacks trusted current evidence')
    player.check(transitions.source_identity(result['afterSeek']['sources'][selected['id']]) == source, 'Tail seek changed source identity')
    page.wait_for_function('''track=>{
      const value=bufferedTransitionsProbe.snapshot();
      return value.loadedTrack===track && value.media.some(audio=>!audio.paused && !audio.ended && audio.position<2);
    }''', arg=before['loadedTrack'], timeout=result['timeoutMs'])
    result['restarted'] = transitions.wait_track(page, before['loadedTrack'])
    result['playback'] = player.measure(page, rate, True, transitions.label(mode, True))
    result['after'] = snapshot(page)
    after = result['after']
    player.check(after['documentId'] == before['documentId'] and after['panelCount'] == 1, 'Repeat changed document/controller ownership')
    player.check(after['loadedTrack'] == before['loadedTrack'] and after['selected']['position'] < 2, 'Repeat did not restart the selected track')
    player.check(len(after['clickEvents']) == click_count and click_count < 128, 'Repeat used an extra click or saturated click history')
    player.check(len(after['commandEvents']) < 128, 'Repeat command history reached capacity')
    observation = after['tailObservation']
    player.check(observation['errors'] == 0 and all(value == 0 for value in observation['dropped'].values()), 'Repeat observation failed or exceeded capacity')
    commands = [event for event in after['commandEvents'] if event['time'] >= result['tailEstablishedTime']]
    pause = transitions.completed_host_pause(commands, active['commandId'], source, rate)
    dispatch = completed_dispatch(observation['dispatches'], active['id'], source, rate, result['tailEstablishedTime'])
    ended = [event for event in after['mediaEvents'] if event['sequence'] > result['observation']['sequence'] and event['id'] == active['id'] and event['name'] == 'ended' and transitions.source_identity(event['source']) == source]
    result['completionEvidence'] = {'hostPause': pause, 'dispatch': dispatch, 'ended': ended}
    result['endedEventDelivery'] = 'OBSERVED' if ended else 'UNOBSERVED'
    player.check(pause is not None or dispatch is not None, 'Repeat restarted before observed decoded completion')
    player.check(len(ended) <= 1, 'Repeat delivered duplicate ended events')
    player.check('m-one' in repeat_state(page)['className'].split(), 'Repeat-one changed during playback')
    page.evaluate('bufferedTransitionsProbe.endTail()')
    result['status'] = 'PASSED'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', default='dist/soundcloud-tempo-control.user.js')
    parser.add_argument('--mode', choices=['natural', 'preserve', 'both'], default='both')
    parser.add_argument('--cycles', type=int, choices=[1, 2, 3], default=2)
    parser.add_argument('--tail-seconds', type=float, default=0.5)
    options = parser.parse_args()
    player.check(math.isfinite(options.tail_seconds) and 0 < options.tail_seconds <= 2, 'Tail must be between zero and two source seconds')
    artifact = ROOT / options.artifact
    original = artifact.read_bytes()
    injection = userscript_source(artifact)
    player.check(injection.count(original.decode()) == 1, 'Injected artifact differs')
    inputs = ['tests/fixtures/buffered-player-probe.js', 'tests/fixtures/buffered-transitions-probe.js', 'tests/verify-buffered-transitions.py', 'tests/verify-buffered-player.py', 'tests/userscript_fixture.py', 'tests/verify-buffered-repeat.py']
    sources = {name: (ROOT / name).read_bytes() for name in inputs}
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(), 'status': 'INCOMPLETE',
        'scope': 'Exact userscript in fresh signed-out Chrome with permanent zero-gain destination and browser mute. Actual Repeat-one and native tail seeks; no simulated completion or host-state injection. Sampled restart output is not continuous-tail or installed-manager acceptance.',
        'artifactSha256': hashlib.sha256(original).hexdigest(), 'artifactBytes': len(original),
        'injectedSourceSha256': hashlib.sha256(injection.encode()).hexdigest(),
        'inputHashes': {name: hashlib.sha256(value).hexdigest() for name, value in sources.items()},
        'mode': options.mode, 'cyclesPerMode': options.cycles, 'repeats': [],
        'requests': [], 'responses': [], 'requestFailures': [], 'pageErrors': [], 'consoleWarnings': [],
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(sources[inputs[0]].decode() + '\n' + sources[inputs[1]].decode() + '\nif(window.top===window && location.origin==="https://soundcloud.com"){\n' + injection + '\nbufferedPlayerProbe.observeCommands();\n}')
        page = context.new_page()
        player.observe_page(page, report)
        report['browser'] = browser.version
        try:
            page.goto(player.TRACK, wait_until='domcontentloaded', timeout=35000)
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            player.dismiss_overlays(page)
            page.locator('a[href="/nasa"]').filter(has_text='NASA').first.click()
            page.wait_for_url('https://soundcloud.com/nasa', timeout=15000)
            page.locator('.trackItem__trackTitle').first.wait_for(state='visible', timeout=15000)
            track = page.locator('.trackItem__trackTitle').first.evaluate('link=>({path:new URL(link.href).pathname,title:link.textContent.trim()})')
            report['observedTrack'] = track
            transitions.play_row(page, track['path'])
            transitions.wait_track(page, track['path'])
            transitions.save_rate(page, track['path'], 0.025)
            report['repeatSelection'] = set_repeat(page, True)
            for mode in ['natural', 'preserve'] if options.mode == 'both' else [options.mode]:
                transitions.set_mode(page, mode)
                player.measure(page, 0.025, True, transitions.label(mode, True))
                for cycle in range(options.cycles):
                    repeat_once(page, report, mode, cycle + 1, options.tail_seconds)
            report['repeatRestoration'] = set_repeat(page, False)
            report['status'] = 'PASSED'
        except Exception as error:
            report['error'] = {'phase': 'repeat-one', 'message': str(error)[:4000]}
            try:
                report['failureSnapshot'] = snapshot(page)
            except Exception as failure:
                report['snapshotError'] = str(failure)
        finally:
            try:
                page.evaluate('bufferedTransitionsProbe.stop()')
                report['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                player.check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in report['stopped']['contexts']), 'Audio contexts did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    player.assess_diagnostics(report)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    path = ROOT / f'test-results/buffered-repeat-{options.mode}-{stamp}.json'
    path.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'file': str(path), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
