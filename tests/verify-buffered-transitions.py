import argparse
import hashlib
import importlib.util
import json
import math
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source

spec = importlib.util.spec_from_file_location('buffered_player_verifier', ROOT / 'tests/verify-buffered-player.py')
player = importlib.util.module_from_spec(spec)
spec.loader.exec_module(player)


def snapshot(page):
    return page.evaluate('bufferedTransitionsProbe.snapshot()')


def source_identity(source):
    return source.get('src') or source.get('currentSrc')


def completed_host_pause(commands, command_id, source, rate):
    if not isinstance(source, str) or not source:
        return None
    for event in commands:
        if not (
            event.get('name') == 'pause'
            and event.get('commandId') == command_id
            and event.get('source', {}).get('src') == source
            and event.get('sourceAfter', {}).get('src') == source
            and event.get('ended') is True
            and event.get('paused') is True
            and event.get('seeking') is False
            and event.get('nativePaused') is True
            and event.get('nativeEnded') is False
            and event.get('playbackRate') == rate
        ):
            continue
        position, duration = event.get('position'), event.get('duration')
        values = [position, duration]
        if not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in values):
            continue
        if duration > 0 and abs(position - duration) < 0.00005:
            return event
    return None


def set_mode(page, mode):
    if page.locator('.settings-button').get_attribute('aria-expanded') != 'true':
        page.locator('.settings-button').click()
    if not page.locator('.advanced-audio').evaluate('element=>element.open'):
        page.locator('.advanced-audio summary').click()
    page.locator('#preserve-key').set_checked(mode == 'preserve')
    page.locator('#use-wasm').check()
    page.keyboard.press('Escape')


def play_row(page, path):
    rows = page.locator('.trackItem')
    index = rows.evaluate_all('(rows,path)=>rows.findIndex(row=>{const link=row.querySelector("a.trackItem__trackTitle");return link && new URL(link.href).pathname===path})', path)
    player.check(index >= 0, 'Observed track row is no longer available')
    row = rows.nth(index)
    row.hover(timeout=10000)
    row.locator('.playButton').click(timeout=10000)


def wait_track(page, path):
    page.wait_for_function('path=>bufferedTransitionsProbe.snapshot().loadedTrack===path', arg=path, timeout=15000)
    page.wait_for_function('bufferedPlayerProbe.snapshot().media.filter(audio=>!audio.paused&&!audio.ended).length===1', timeout=30000)
    value = snapshot(page)
    active = [audio for audio in value['media'] if not audio['paused'] and not audio['ended']]
    player.check(len(active) == 1, 'Transition has no unique playing media')
    page.evaluate('id=>bufferedPlayerProbe.select(id)', active[0]['id'])
    return snapshot(page)


def save_rate(page, path, rate):
    player.select_tempo(page, rate)
    saved = page.locator('.memory')
    if saved.get_attribute('aria-pressed') != 'true':
        saved.click()
    page.wait_for_function('({path,rate})=>localStorage.getItem("soundcloud.tempo.track."+encodeURIComponent(path))===String(rate)', arg={'path': path, 'rate': rate}, timeout=5000)


def label(mode, buffered):
    if buffered:
        return 'Buffered playback · Preserve key.' if mode == 'preserve' else 'Buffered playback · Natural pitch.'
    return 'Signalsmith WASM active.' if mode == 'preserve' else 'Natural pitch follows speed.'


def seek_distinct_position(page):
    before = snapshot(page)
    active = before['selected']
    player.check(active is not None and not active['paused'], 'No active source for pre-transition seek')
    duration = active['duration']
    player.check(duration is not None and duration > 12, 'Observed track is too short for a distinct old-source position')
    progress = page.locator('.playbackTimeline__progressBackground')
    progress.wait_for(state='attached', timeout=5000)
    box = progress.bounding_box()
    player.check(box is not None and box['width'] > 80, 'Native seek control is not measurable')
    target = min(max(6, 4 * duration / box['width']), duration * 0.5)
    tolerance = 2 * duration / box['width'] + 0.5
    point = {'x': box['x'] + box['width'] * target / duration, 'y': box['y'] + box['height'] / 2}
    control = progress.evaluate('element=>({html:element.closest(".playbackTimeline").outerHTML.slice(0,6000),role:element.getAttribute("role")})')
    player.check(page.evaluate('point=>Boolean(document.elementFromPoint(point.x,point.y)?.closest(".playbackTimeline"))', point), 'Native seek point is obstructed')
    page.mouse.click(point['x'], point['y'])
    page.wait_for_function('''({id,target,tolerance})=>{
      const value=bufferedTransitionsProbe.snapshot();
      const audio=value.media[id];
      return audio && !audio.paused && !value.sources[id].seeking && audio.position>=3 && Math.abs(audio.position-target)<=tolerance;
    }''', arg={'id': active['id'], 'target': target, 'tolerance': tolerance}, timeout=15000)
    after = snapshot(page)
    player.check(after['loadedTrack'] == before['loadedTrack'], 'Native seek changed the selected track')
    player.check(after['selected']['position'] >= 3, 'Native seek did not establish a distinguishable old position')
    return {'targetSeconds': target, 'pixelToleranceSeconds': tolerance, 'control': control, 'point': point, 'before': before, 'after': after}


def inspect_next_up(page, expected_path):
    page.locator('.playbackSoundBadge__showQueue').click(timeout=5000)
    page.locator('.queue__hide').wait_for(state='visible', timeout=5000)
    page.wait_for_function('bufferedTransitionsProbe.queue().filter(row=>row.path).length>1', timeout=10000)
    rows = page.evaluate('bufferedTransitionsProbe.queue()')
    current = snapshot(page)['loadedTrack']
    indexed = [index for index, row in enumerate(rows) if row['path'] == current]
    result = {'currentTrack': current, 'rows': rows, 'expectedNext': expected_path}
    try:
        player.check(len(indexed) == 1, 'Actual Next-up UI does not uniquely identify the current queue item')
        following = [row for row in rows[indexed[0] + 1:] if row['path']]
        player.check(bool(following), 'Actual Next-up UI has no following track')
        result['observedNext'] = following[0]['path']
        player.check(result['observedNext'] == expected_path, 'Host Next-up order differs from the observed playlist order')
        return result
    finally:
        page.locator('.queue__hide').click(timeout=5000)


def transition(page, report, name, mode, path, rate, action):
    result = {'name': name, 'mode': mode, 'track': path, 'rate': rate, 'status': 'INCOMPLETE', 'before': snapshot(page)}
    report['transitions'].append(result)
    result['distinctOldPosition'] = seek_distinct_position(page)
    if name.startswith('queue-'):
        result['queue'] = inspect_next_up(page, path)
    result['beforeAction'] = snapshot(page)
    action()
    result['selected'] = wait_track(page, path)
    buffered = rate < 0.25
    result['playback'] = player.measure(page, rate, buffered, label(mode, buffered))
    result['after'] = snapshot(page)
    before, after = result['beforeAction'], result['after']
    player.check(before['documentId'] == after['documentId'], 'Track change unexpectedly replaced the document')
    player.check(after['panelCount'] == 1 and after['loadedTrack'] == path, 'Track identity/controller changed unexpectedly')
    active = after['selected']
    player.check(before['selected']['position'] >= 3, 'Old source position was not distinct at the switch')
    player.check(active['position'] < 2, 'New track inherited an old source position')
    player.check(all(audio['nativePaused'] for audio in after['media'] if audio['id'] != active['id']), 'Old native media remained playing after track change')
    selected_source = after['sources'][active['id']]['currentSrc']
    player.check(bool(selected_source), 'Selected media has no public source identity')
    if before['selected'] and before['loadedTrack'] != path:
        old_source = before['sources'][before['selected']['id']]['currentSrc']
        player.check(selected_source != old_source, 'Track change reused the previous public source identity')
    for point in result['playback']['points']:
        for audio in point['snapshot']['media']:
            if audio['id'] == active['id']:
                continue
            reference = result['playback']['first']['media'][audio['id']]
            player.check(audio['nativePaused'] and abs(audio['nativePosition'] - reference['nativePosition']) < 0.000001, 'Old native media clock advanced after source replacement')
    result['status'] = 'PASSED'


def automatic_eof(page, report, mode, next_path, next_rate, tail_seconds, native_control=False):
    rate = 0.85 if native_control else 0.025
    result = {'mode': mode, 'sourceRate': rate, 'nativeControl': native_control, 'requestedTailSeconds': tail_seconds, 'nextTrack': next_path, 'nextRate': next_rate, 'status': 'INCOMPLETE', 'phase': 'queue', 'before': snapshot(page)}
    report['automaticEof'].append(result)
    result['queue'] = inspect_next_up(page, next_path)
    result['repeatControl'] = page.locator('.repeatControl').evaluate('element=>({title:element.title,pressed:element.getAttribute("aria-pressed"),className:element.className,html:element.outerHTML})')
    player.check(result['repeatControl']['title'] == 'Repeat' and result['repeatControl']['pressed'] != 'true' and 'm-active' not in result['repeatControl']['className'].split(), 'Host repeat-off state is not established')
    before = snapshot(page)
    active = before['selected']
    old_source = source_identity(before['sources'][active['id']])
    result['sourceBeforeSeek'] = old_source
    player.check(active['duration'] is not None and active['duration'] > 12 and not active['paused'] and active['nativePaused'] != native_control, 'Automatic EOF needs a playing source on the requested route with a finite duration')
    player.check(active['playbackRate'] == rate and active['defaultPlaybackRate'] == rate, 'Tail source rate does not match the requested route')
    result['phase'] = 'native-seek-near-end'
    progress = page.locator('.playbackTimeline__progressBackground')
    box = progress.bounding_box()
    player.check(box is not None and box['width'] > 80, 'Native EOF seek control is not measurable')
    tail_pixels = max(0.75, box['width'] * tail_seconds / active['duration'])
    point = {'x': box['x'] + box['width'] - tail_pixels, 'y': box['y'] + box['height'] / 2}
    result['seekGeometry'] = {'box': box, 'tailPixels': tail_pixels, 'durationUsed': active['duration']}
    result['seekControl'] = progress.evaluate('element=>element.closest(".playbackTimeline").outerHTML')
    result['seekPoint'] = point
    player.check(page.evaluate('point=>Boolean(document.elementFromPoint(point.x,point.y)?.closest(".playbackTimeline"))', point), 'Native EOF seek point is obstructed')
    result['observation'] = page.evaluate('bufferedTransitionsProbe.beginTail()')
    page.mouse.click(point['x'], point['y'])
    page.wait_for_function('''({id,duration})=>{
      const value=bufferedTransitionsProbe.snapshot();
      const audio=value.media[id];
      return audio && !audio.paused && !value.sources[id].seeking && audio.position>duration-5;
    }''', arg={'id': active['id'], 'duration': active['duration']}, timeout=15000)
    result['afterSeek'] = snapshot(page)
    tail = result['afterSeek']['selected']
    player.check(result['afterSeek']['loadedTrack'] == before['loadedTrack'], 'Seek reached the next track before the bounded tail observation')
    remaining = tail['duration'] - tail['position']
    player.check(0 < remaining <= 4, 'Native UI seek did not leave a bounded nonempty source tail')
    result['remainingSourceSeconds'] = remaining
    result['predictedTailWallSeconds'] = remaining / rate
    timeout = min(180000, math.ceil((remaining / rate + 20) * 1000))
    result['timeoutMs'] = timeout
    click_count = len(result['afterSeek']['clickEvents'])
    result['phase'] = 'await-host-advance-and-classify-completion'
    page.wait_for_function('next=>bufferedTransitionsProbe.snapshot().loadedTrack===next', arg=next_path, timeout=timeout)
    result['advanced'] = snapshot(page)
    player.check(len(result['advanced']['clickEvents']) == click_count, 'Automatic EOF used an extra click after the final seek')
    result['phase'] = 'measure-next-source'
    wait_track(page, next_path)
    result['playback'] = player.measure(page, next_rate, next_rate < 0.25, label(mode, next_rate < 0.25))
    result['after'] = snapshot(page)
    player.check(result['after']['documentId'] == before['documentId'] and result['after']['panelCount'] == 1, 'Automatic EOF changed document/controller ownership')
    player.check(source_identity(result['after']['sources'][result['after']['selected']['id']]) != old_source, 'Automatic EOF retained the previous source identity')
    player.check(result['after']['selected']['position'] < 2, 'Automatic EOF inherited the ended source position')
    player.check(len(result['after']['clickEvents']) == click_count and click_count < 128, 'Next-source verification used a playback control click or saturated its click history')
    tail_observation = result['after']['tailObservation']
    player.check(tail_observation['errors'] == 0 and all(count == 0 for count in tail_observation['dropped'].values()), 'Tail observation failed or exceeded its bounded evidence capacity')
    player.check(len(result['after']['commandEvents']) < 128, 'Tail command history reached its capacity')
    ended = [event for event in result['after']['mediaEvents'] if event['sequence'] > result['observation']['sequence'] and event['id'] == active['id'] and event['name'] == 'ended' and source_identity(event['source']) == old_source]
    dispatched = [event for event in tail_observation['dispatches'] if event['id'] == active['id'] and event['name'] == 'ended' and source_identity(event['before']['source']) == old_source]
    timeupdates = [event for event in tail_observation['timeupdates'] if event['id'] == active['id'] and source_identity(event['source']) == old_source]
    tail_dispatches = [event for event in tail_observation['dispatches'] if event['id'] == active['id'] and source_identity(event['before']['source']) == old_source]
    tail_commands = [event for event in result['after']['commandEvents'] if event['commandId'] == active['commandId'] and event['time'] >= result['observation']['time']]
    completed_pause = None if native_control else completed_host_pause(tail_commands, active['commandId'], old_source, rate)
    completed_before_detach = [event for event in tail_dispatches if event['name'] == 'timeupdate' and event['before']['ended'] and event['after'] and source_identity(event['after']['source']) != old_source]
    replacement_events = [event for event in tail_observation['timeupdates'] if event['id'] == active['id'] and event['source']['currentSrc'] == old_source and source_identity(event['source']) != old_source]
    result['completionEvidence'] = {'capturedEnded': ended, 'dispatchedEnded': dispatched, 'completedBeforeDetach': completed_before_detach, 'completedAtHostPause': completed_pause, 'timeupdates': timeupdates, 'dispatches': tail_dispatches, 'commands': tail_commands, 'replacementEventsWithOldCurrentSrc': replacement_events}
    result['endedEventDelivery'] = 'OBSERVED' if ended else 'UNOBSERVED'
    player.check(len(ended) <= 1 and len(dispatched) <= 1, 'Automatic transition duplicated completion for its old source')
    evidence = dispatched[0]['before'] if dispatched else ended[0] if ended else completed_before_detach[0]['before'] if completed_before_detach else completed_pause
    if evidence is not None:
        player.check(evidence['ended'] and evidence['paused'], 'Completion event did not expose ended and paused state')
        player.check(evidence['nativePaused'] and (evidence['nativeEnded'] == native_control), 'Completion did not originate from the requested playback route')
        player.check(evidence['duration'] is not None and abs(evidence['position'] - evidence['duration']) < 0.00005, 'Completion position did not reach its reported source end')
        result['completionClassification'] = 'native-ended' if native_control else 'buffered-dispatched-ended' if dispatched else 'buffered-captured-ended' if ended else 'transport-completed-before-host-source-change' if completed_before_detach else 'transport-completed-before-host-pause'
    else:
        result['completionClassification'] = 'host-advanced-without-observed-ended'
    page.evaluate('bufferedTransitionsProbe.endTail()')
    result['handoffStatus'] = 'PASSED'
    result['decodedCompletionObserved'] = not native_control and evidence is not None
    result['status'] = 'OBSERVED' if native_control or evidence is None else 'PASSED'
    result['phase'] = 'complete'


def exercise(page, report, automatic=False, native_control=False, tail_seconds=1):
    tracks = page.locator('.trackItem__trackTitle').evaluate_all('links=>links.slice(0,3).map(link=>({path:new URL(link.href).pathname,title:link.textContent.trim(),href:link.getAttribute("href")}))')
    player.check(len(tracks) == 3 and len({track['path'] for track in tracks}) == 3, 'NASA did not expose three distinct playable playlist tracks')
    report['observedTracks'] = tracks
    report['preparation'] = []
    report['transitions'] = []
    report['automaticEof'] = []
    set_mode(page, 'natural')
    for track, rate in zip(tracks, [0.85, 0.85, 0.85] if native_control else [0.025, 0.025, 0.85]):
        prep = {'track': track['path'], 'rate': rate, 'before': snapshot(page)}
        report['preparation'].append(prep)
        play_row(page, track['path'])
        wait_track(page, track['path'])
        save_rate(page, track['path'], rate)
        prep['playback'] = player.measure(page, rate, rate < 0.25, label('natural', rate < 0.25))
        prep['after'] = snapshot(page)
    for mode in ['natural'] if native_control else ['natural', 'preserve']:
        set_mode(page, mode)
        if automatic or native_control:
            play_row(page, tracks[0]['path'])
            wait_track(page, tracks[0]['path'])
            rate = 0.85 if native_control else 0.025
            player.measure(page, rate, not native_control, label(mode, not native_control))
            automatic_eof(page, report, mode, tracks[1]['path'], rate, tail_seconds, native_control)
            automatic_eof(page, report, mode, tracks[2]['path'], 0.85, tail_seconds, native_control)
            continue
        transition(page, report, 'row-native-to-saved-low', mode, tracks[0]['path'], 0.025, lambda: play_row(page, tracks[0]['path']))
        transition(page, report, 'queue-low-to-saved-low', mode, tracks[1]['path'], 0.025, lambda: page.get_by_role('button', name='Skip to next', exact=True).click())
        transition(page, report, 'queue-low-to-saved-native', mode, tracks[2]['path'], 0.85, lambda: page.get_by_role('button', name='Skip to next', exact=True).click())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--automatic-eof', action='store_true')
    parser.add_argument('--eof-native-control', action='store_true')
    parser.add_argument('--tail-seconds', type=float, default=1)
    parser.add_argument('--artifact', default='dist/soundcloud-tempo-control.user.js')
    options = parser.parse_args()
    player.check(sum([options.inspect, options.automatic_eof, options.eof_native_control]) <= 1, 'Inspection, automatic EOF, and native control modes are separate')
    player.check(math.isfinite(options.tail_seconds) and 0 <= options.tail_seconds <= 2, 'Tail seek must request between zero and two source seconds')
    artifact_path = ROOT / options.artifact
    artifact = artifact_path.read_bytes()
    injection = userscript_source(artifact_path)
    player.check(injection.count(artifact.decode()) == 1, 'Exact artifact not contained in injection')
    base_probe = (ROOT / 'tests/fixtures/buffered-player-probe.js').read_bytes()
    probe = (ROOT / 'tests/fixtures/buffered-transitions-probe.js').read_bytes()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Exact public userscript in an isolated signed-out browser, permanently muted via inherited final-edge analyser/gain0 and browser mute. Actual observed NASA links and SoundCloud host controls. No source playlist, factory, or internal state injection. Sampled output is not continuous source-contamination proof or installed-manager coverage.',
        'artifactSha256': hashlib.sha256(artifact).hexdigest(),
        'artifactBytes': len(artifact),
        'probeSha256': hashlib.sha256(probe).hexdigest(),
        'baseProbeSha256': hashlib.sha256(base_probe).hexdigest(),
        'verifierSha256': hashlib.sha256((ROOT / 'tests/verify-buffered-transitions.py').read_bytes()).hexdigest(),
        'helperSha256': hashlib.sha256((ROOT / 'tests/verify-buffered-player.py').read_bytes()).hexdigest(),
        'status': 'INCOMPLETE',
        'mode': 'native-eof-control' if options.eof_native_control else 'automatic-eof' if options.automatic_eof else 'inspection' if options.inspect else 'manual-transitions',
        'tailSeconds': options.tail_seconds,
        'eventObservationScope': 'Delegating dispatchEvent observation catches JavaScript ended/timeupdate calls before host listeners, with bounded capture-timeupdate history. Native browser dispatch is observed only by capture listeners, whose precedence over all host listeners is not guaranteed. No synthetic events are sent by the diagnostic. Native control is observation, not buffered decoded-EOF coverage.',
        'requests': [], 'responses': [], 'requestFailures': [], 'pageErrors': [], 'consoleWarnings': [],
    }
    phase = 'navigate'
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        report['browser'] = browser.version
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        context.add_init_script(base_probe.decode() + '\n' + probe.decode() + '\nif(window.top===window && location.origin==="https://soundcloud.com"){\n' + injection + '\nbufferedPlayerProbe.observeCommands();\n}')
        page = context.new_page()
        player.observe_page(page, report)
        try:
            page.goto(player.TRACK, wait_until='domcontentloaded', timeout=35000)
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            player.dismiss_overlays(page)
            report['initial'] = snapshot(page)
            phase = 'observed-nasa-profile'
            owner = page.locator('a[href="/nasa"]').filter(has_text='NASA').first
            owner.wait_for(state='visible', timeout=15000)
            report['observedOwnerLink'] = owner.get_attribute('href')
            owner.click()
            page.wait_for_url('https://soundcloud.com/nasa', timeout=15000)
            page.locator('.soundList__item').first.wait_for(state='attached', timeout=15000)
            report['inventory'] = page.evaluate('bufferedTransitionsProbe.inventory()')
            if options.inspect:
                report['status'] = 'INSPECTED'
            else:
                phase = 'track-and-queue-transitions'
                exercise(page, report, options.automatic_eof, options.eof_native_control, options.tail_seconds)
                report['status'] = 'OBSERVED' if options.eof_native_control else 'PASSED'
                if options.automatic_eof:
                    report['automaticQueueStatus'] = 'PASSED'
                    report['decodedEofStatus'] = 'PASSED' if all(item['decodedCompletionObserved'] for item in report['automaticEof']) else 'UNOBSERVED'
                    if report['decodedEofStatus'] == 'UNOBSERVED':
                        report['status'] = 'INCOMPLETE'
                        report['unproven'] = 'Host queue handoffs completed; one or more outgoing buffered sources were replaced without observed decoded completion.'
        except Exception as error:
            report['error'] = {'phase': phase, 'message': str(error)[:4000]}
            report['failureSnapshot'] = snapshot(page)
            report['inventory'] = page.evaluate('bufferedTransitionsProbe.inventory()')
            report['failureQueue'] = page.evaluate('bufferedTransitionsProbe.queue()')
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
    output = ROOT / f'test-results/buffered-transitions-{report["mode"]}-{stamp}.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'file': str(output), 'error': report.get('error')}, indent=2))
    return 0 if report['status'] in ['PASSED', 'INSPECTED', 'OBSERVED'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
