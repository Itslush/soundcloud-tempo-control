import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source
from worklet_trace import WorkletTrace

SESSION_PATH = ROOT / 'tests/verify-buffered-session.py'
SPEC = importlib.util.spec_from_file_location('playback_baseline_measurements', SESSION_PATH)
SESSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SESSION)
BASE = SESSION.BASE
SECONDS = 40
SAMPLE_SECONDS = 20
WARMUP_SECONDS = 10
SOURCE_START = 30
START_TOLERANCE_SECONDS = 0.5
CONDITIONS = [
    {'name': 'plain-natural', 'userscript': False, 'preserve': False, 'rate': 0.85, 'buffered': False, 'label': None},
    {'name': 'userscript-natural', 'userscript': True, 'preserve': False, 'rate': 0.85, 'buffered': False, 'label': 'Natural pitch follows speed.'},
    {'name': 'plain-preserve', 'userscript': False, 'preserve': True, 'rate': 0.85, 'buffered': False, 'label': None},
    {'name': 'userscript-preserve-wasm', 'userscript': True, 'preserve': True, 'rate': 0.85, 'buffered': False, 'label': 'Signalsmith WASM active.'},
    {'name': 'buffered-natural', 'userscript': True, 'preserve': False, 'rate': 0.025, 'buffered': True, 'label': 'Buffered playback · Natural pitch.'},
    {'name': 'buffered-preserve', 'userscript': True, 'preserve': True, 'rate': 0.025, 'buffered': True, 'label': 'Buffered playback · Preserve key.'},
]
CONTROL_PROBE = '''
(() => {
  if (window.top !== window || location.origin !== 'https://soundcloud.com') return;
  const create = AudioContext.prototype.createMediaElementSource;
  const descriptors = Object.getOwnPropertyDescriptors(HTMLMediaElement.prototype);
  const records = [];
  const clocks = new WeakMap();
  AudioContext.prototype.createMediaElementSource = function (audio) {
    const source = Reflect.apply(create, this, [audio]);
    if (records.length >= 8) throw new Error('Baseline observation capacity exceeded');
    records.push(audio);
    const context = this;
    const history = {events: [], dropped: 0};
    context.addEventListener('statechange', () => {
      const event = {wall: performance.now(), audio: context.currentTime, state: context.state};
      if (history.events.length < 32) history.events.push(event);
      else history.dropped++;
    });
    clocks.set(audio, {context, history});
    return source;
  };
  const media = id => {
    if (!Number.isInteger(id) || !records[id]) throw new Error('Unknown baseline media');
    return records[id];
  };
  const native = (audio, key) => descriptors[key]?.get?.call(audio);
  globalThis.playbackBaselineControl = {
    facts(id) {
      const audio = media(id);
      const {context, history} = clocks.get(audio);
      return {
        seeking: audio.seeking,
        preservesPitch: audio.preservesPitch,
        nativePreservesPitch: native(audio, 'preservesPitch'),
        nativeVolume: native(audio, 'volume'),
        nativeMuted: native(audio, 'muted'),
        nativeRate: native(audio, 'playbackRate'),
        nativeDefaultRate: native(audio, 'defaultPlaybackRate'),
        outputSetting: document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('#output-level')?.value ?? null,
        settingsExpanded: document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('.settings-button')?.getAttribute('aria-expanded') ?? null,
        visibilityState: document.visibilityState,
        audioClock: {wall: performance.now(), audio: context.currentTime, state: context.state,
          outputTimestamp: context.getOutputTimestamp(), baseLatency: context.baseLatency,
          outputLatency: context.outputLatency, events: history.events.slice(), dropped: history.dropped},
      };
    },
    configureNative(id, rate, preserve) {
      const audio = media(id);
      audio.playbackRate = rate;
      audio.defaultPlaybackRate = rate;
      audio.preservesPitch = preserve;
    },
    volume(id, value) {
      media(id).volume = value;
    },
    seek(id, position) {
      const audio = media(id);
      audio.currentTime = position;
      return {requestedPosition: position, actualPosition: audio.currentTime, seeking: audio.seeking, paused: audio.paused, time: performance.now()};
    },
  };
})();
'''


def check(value, message):
    if not value:
        raise AssertionError(message)


def atomic_write(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='wb', dir=path.parent, prefix=f'.{path.name}.', suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def preserve_report(path):
    if not path.exists():
        return None
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    archive = path.with_name(f'{path.stem}-preserved-{digest}{path.suffix}')
    if archive.exists():
        check(archive.read_bytes() == data, 'Existing preserved report differs from its content hash')
    else:
        atomic_write(archive, data)
    return str(archive)


def checkpoint(report, output, latest):
    report['checkpointUtc'] = datetime.now(timezone.utc).isoformat()
    report['completedConditions'] = sum(item['status'] == 'PASSED' for item in report['conditions'])
    report['comparisons'] = comparisons(report['conditions'])
    data = (json.dumps(report, indent=2) + '\n').encode('utf-8')
    atomic_write(output, data)
    atomic_write(latest, data)


def wall_clock_progress(first_bounds, last_bounds, progress, rate, buffered, seconds=None):
    tolerance = 0.001 if buffered else 0.035
    minimum = rate * (last_bounds['before'] - first_bounds['after'])
    maximum = rate * (last_bounds['after'] - first_bounds['before'])
    required_seconds = SECONDS if seconds is None else seconds
    fixed_minimum = rate * required_seconds - tolerance
    check(progress >= fixed_minimum, f'Source advanced less than {required_seconds} wall seconds at the requested rate')
    check(minimum - tolerance <= progress <= maximum + tolerance, f'Source progression differs from wall time: {progress} outside {minimum}..{maximum}')
    return {'sourceProgressSeconds': progress, 'expectedMinimum': minimum, 'expectedMaximum': maximum, 'minimumForRequestedDuration': fixed_minimum, 'toleranceSeconds': tolerance}


def observation(page, selected_id):
    return page.evaluate('id => ({playback: bufferedPlayerProbe.snapshot(), mode: playbackBaselineControl.facts(id)})', selected_id)


def render_metrics(session, contexts):
    results = []
    for context_id, context in contexts.items():
        if context.get('contextType') != 'realtime':
            continue
        try:
            results.append({'contextId': context_id, **session.send('WebAudio.getRealtimeData', {'contextId': context_id})})
        except Exception as error:
            results.append({'contextId': context_id, 'error': str(error)[:500]})
    return results


def validate(value, condition):
    playback = value['playback']
    audio = playback['selected']
    facts = value['mode']
    rate = condition['rate']
    check(playback['panelCount'] == int(condition['userscript']), 'Unexpected userscript presence')
    check(playback['label'] == condition['label'], 'Playback engine label changed')
    check(audio and not audio['paused'] and not audio['ended'] and audio['contextState'] == 'running', 'Playback stopped')
    check(abs(audio['playbackRate'] - rate) < 0.000001 and abs(audio['defaultPlaybackRate'] - rate) < 0.000001, 'Public media rate differs from the requested condition')
    check(audio['nativePaused'] == condition['buffered'], 'Native and buffered route ownership differs from the condition')
    check(audio['finite'] and audio['peak'] > 1e-7, 'A sampled output window is silent or nonfinite')
    check(audio['sinkGain'] == 0 and all(item['sinkGain'] == 0 for item in playback['contexts']), 'Permanent diagnostic mute changed')
    check(not facts['seeking'] and facts['visibilityState'] == 'visible', 'Playback is seeking or the page is hidden')
    expected_browser_preserve = condition['preserve'] and not condition['userscript']
    check(facts['nativePreservesPitch'] == expected_browser_preserve, 'Actual browser pitch preservation differs from the condition')
    check(not facts['nativeMuted'] and abs(facts['nativeVolume'] - 0.5) < 0.000001, 'Matched native signal level changed')
    if not condition['buffered']:
        check(abs(facts['nativeRate'] - rate) < 0.000001 and abs(facts['nativeDefaultRate'] - rate) < 0.000001, 'Native transport rate differs from the requested condition')
    if condition['userscript']:
        check(facts['outputSetting'] == '0' and facts['settingsExpanded'] == 'false', 'Matched output level or closed settings changed')


def wait_ready(page, selected_id, condition):
    page.wait_for_function('''({id, condition}) => {
      const state = bufferedPlayerProbe.snapshot();
      const audio = state.selected;
      const facts = playbackBaselineControl.facts(id);
      const checks = {
        selected: !!audio,
        label: state.label === (condition.label ?? null),
        playing: !!audio && !audio.paused && !audio.ended,
        settled: !facts.seeking,
        rate: audio?.playbackRate === condition.rate,
        defaultRate: audio?.defaultPlaybackRate === condition.rate,
        ownership: audio?.nativePaused === condition.buffered,
        context: audio?.contextState === 'running',
        mutedSink: audio?.sinkGain === 0,
        signal: !!audio && audio.finite && audio.peak > 1e-7,
      };
      globalThis.playbackBaselineReadiness = {checks, condition, label: state.label, facts};
      return Object.values(checks).every(Boolean);
    }''', arg={'id': selected_id, 'condition': condition}, timeout=45000)
    result = observation(page, selected_id)
    validate(result, condition)
    return result


def timed_capture(page, session, tree, selected_id, condition, result, checkpoint=None, profile=None):
    result['memoryBefore'] = tree.memory()
    result['pageBefore'] = SESSION.page_metrics(session)
    first_wall_before = time.monotonic()
    first = observation(page, selected_id)
    result['firstObservationWallBounds'] = {'before': first_wall_before, 'after': time.monotonic()}
    validate(first, condition)
    position = first['playback']['selected']['position']
    check(SOURCE_START <= position <= SOURCE_START + START_TOLERANCE_SECONDS, 'Measured source start is outside the declared matching tolerance')
    result['first'] = first
    result['renderBefore'] = render_metrics(session, result.get('audioContexts', {}))
    result['actualSourceStart'] = position
    result['networkBefore'] = {key: len(result[key]) for key in ['requests', 'responses', 'requestFailures']}
    result['cpuBefore'] = tree.records(False)
    started = time.monotonic()
    result['startedUtc'] = datetime.now(timezone.utc).isoformat()
    for index in range(1, SECONDS // SAMPLE_SECONDS + 1):
        if profile:
            profile.maybe_start(time.monotonic() - started)
        deadline = started + SAMPLE_SECONDS * index
        while time.monotonic() < deadline:
            page.wait_for_timeout(min(SAMPLE_SECONDS * 1000, max(1, (deadline - time.monotonic()) * 1000)))
        sample_wall_before = time.monotonic()
        current = observation(page, selected_id)
        sample_wall_bounds = {'before': sample_wall_before, 'after': time.monotonic()}
        validate(current, condition)
        before = first['playback']['selected']
        after = current['playback']['selected']
        check(current['playback']['documentId'] == first['playback']['documentId'] and after['id'] == before['id'], 'Document or selected media changed')
        progress = after['position'] - before['position']
        minimum = condition['rate'] * (after['before'] - before['after'])
        maximum = condition['rate'] * (after['after'] - before['before'])
        tolerance = 0.00005 if condition['buffered'] else 0.035
        check(minimum - tolerance <= progress <= maximum + tolerance, f'Playback clock diverged: {progress} outside {minimum}..{maximum}')
        if condition['buffered']:
            check(abs(after['nativePosition'] - before['nativePosition']) < 0.000001, 'Parked native clock advanced')
        result['samples'].append({'elapsedSeconds': time.monotonic() - started, 'sourceProgressSeconds': progress, 'expectedMinimum': minimum, 'expectedMaximum': maximum, 'observationWallBounds': sample_wall_bounds, 'observation': current})
        result['samples'][-1]['renderMetrics'] = render_metrics(session, result.get('audioContexts', {}))
        if checkpoint:
            checkpoint()
        result['samples'][-1]['wallClockProgress'] = wall_clock_progress(result['firstObservationWallBounds'], sample_wall_bounds, progress, condition['rate'], condition['buffered'], SAMPLE_SECONDS * index)
        print(f'{condition["name"]}: {result["samples"][-1]["elapsedSeconds"]:.1f}s / {SECONDS}s, source +{progress:.6f}s, finite output, speaker gain 0.', flush=True)
    result['elapsedSeconds'] = time.monotonic() - started
    result['cpuAfter'] = tree.records(False)
    result['pageAfter'] = SESSION.page_metrics(session)
    result['memoryAfter'] = tree.memory()
    result['networkAfter'] = {key: len(result[key]) for key in ['requests', 'responses', 'requestFailures']}
    result['actualSourceEnd'] = result['samples'][-1]['observation']['playback']['selected']['position']
    result['cpu'] = SESSION.process_delta(result['cpuBefore'], result['cpuAfter'])
    elapsed = result['pageAfter']['Timestamp'] - result['pageBefore']['Timestamp']
    tasks = result['pageAfter']['TaskDuration'] - result['pageBefore']['TaskDuration']
    result['pageMetrics'] = {
        'intervalSeconds': elapsed,
        'taskDurationSeconds': tasks,
        'taskDurationPercent': tasks / elapsed * 100,
        'jsHeapUsedBeforeBytes': result['pageBefore']['JSHeapUsedSize'],
        'jsHeapUsedAfterBytes': result['pageAfter']['JSHeapUsedSize'],
        'jsHeapUsedDeltaBytes': result['pageAfter']['JSHeapUsedSize'] - result['pageBefore']['JSHeapUsedSize'],
    }
    check(result['elapsedSeconds'] >= SECONDS, 'Measured interval ended early')
    last = result['samples'][-1]
    result['wallClockProgress'] = wall_clock_progress(result['firstObservationWallBounds'], last['observationWallBounds'], last['sourceProgressSeconds'], condition['rate'], condition['buffered'])


def verify_host_recovery(page):
    inspector = (ROOT / 'tests/fixtures/host-clock-probe.js').read_text(encoding='utf-8').strip().removesuffix(';')
    before = BASE.snapshot(page)['selected']
    injection = page.evaluate(f'''() => ({inspector})(runtime => {{
        const prototype = runtime.c['572']?.exports.HTML5PlayerBase?.prototype;
        if (!prototype) throw new Error('Expected host prototype is unavailable');
        const descriptor = Object.getOwnPropertyDescriptor(prototype, '_getTruePosition');
        if (typeof descriptor?.value !== 'function') throw new Error('Expected host method is unavailable');
        Object.defineProperty(prototype, '_getTruePosition', {{...descriptor,
            value: function (...args) {{ return Reflect.apply(descriptor.value, this, args); }}
        }});
        return {{changedMethod: '_getTruePosition'}};
    }})''')
    page.wait_for_function('''() => {
        const value = bufferedPlayerProbe.snapshot().selected;
        return value && !value.nativePaused && value.nativePlaybackRate === 0.25 && value.playbackRate === 0.25;
    }''', timeout=15000)
    first = BASE.snapshot(page)['selected']
    page.wait_for_timeout(2000)
    last = BASE.snapshot(page)['selected']
    check(last['nativePosition'] > first['nativePosition'] + 0.3, 'Native recovery did not advance')
    check(last['finite'] and last['peak'] > 0.000001 and last['sinkGain'] == 0, 'Recovered output was not finite, active and muted')
    check(abs(first['position'] - before['position']) < 1, 'Recovery lost the source position')
    return {'before': before, 'injection': injection, 'first': first, 'last': last, 'status': 'PASSED'}


def run_condition(runtime, condition, initialization, report, checkpoint=None, trace_host=False, trace_audio_from=None, block_dependency_cdn=False, recover_host=False, continuous_output=False):
    profile = None
    result = {'condition': condition, 'status': 'INCOMPLETE', 'phase': 'launch', 'samples': [], 'requests': [], 'responses': [], 'requestFailures': [], 'pageErrors': [], 'consoleWarnings': []}
    report['conditions'].append(result)
    options = browser_options()
    launched_at = time.time()
    browser = runtime.chromium.launch(**options, headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    result['blockedDependencyRequests'] = []
    if block_dependency_cdn:
        def block_cdn(route):
            result['blockedDependencyRequests'].append(route.request.url)
            route.abort()
        context.route('https://cdn.jsdelivr.net/**', block_cdn)
    page = context.new_page()
    context.add_init_script(initialization)
    BASE.observe_page(page, result)
    try:
        tree = SESSION.ProcessTree(browser, launched_at, options.get('executable_path'))
        result['processIdentification'] = tree.proof
        result['browser'] = browser.version
        session = context.new_cdp_session(page)
        session.send('Performance.enable')
        result['audioContexts'] = {}
        def record_context(event):
            value = event['context']
            if len(result['audioContexts']) < 8:
                result['audioContexts'][value['contextId']] = value
        session.on('WebAudio.contextCreated', record_context)
        session.send('WebAudio.enable')
        result['phase'] = 'navigate'
        response = page.goto(BASE.TRACK, wait_until='domcontentloaded', timeout=35000)
        result['navigation'] = {'url': BASE.public_url(page.url), 'status': response.status if response else None}
        if condition['userscript']:
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
        BASE.dismiss_overlays(page)
        BASE.play_public_track(page)
        page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio=>!audio.paused && audio.position>2)', timeout=30000)
        observed = BASE.snapshot(page)
        active = [audio for audio in observed['media'] if not audio['paused'] and not audio['ended'] and audio['position'] > 0]
        check(len(active) == 1, 'Host-created media source selection is ambiguous; this test never constructs a substitute source')
        selected_id = active[0]['id']
        result['initialNative'] = page.evaluate('id=>bufferedPlayerProbe.select(id)', selected_id)
        result['phase'] = 'configure'
        if condition['userscript']:
            page.locator('.settings-button').click()
            page.locator('.advanced-audio summary').click()
            page.locator('#output-level').fill('0')
            page.locator('#preserve-key').set_checked(condition['preserve'])
            page.locator('#use-wasm').check()
            BASE.select_tempo(page, condition['rate'])
            page.locator('.settings-button').click()
        else:
            page.evaluate('({id, rate, preserve})=>playbackBaselineControl.configureNative(id, rate, preserve)', {'id': selected_id, 'rate': condition['rate'], 'preserve': condition['preserve']})
        page.evaluate('id=>playbackBaselineControl.volume(id, 0.5)', selected_id)
        result['readyBeforeWarmup'] = wait_ready(page, selected_id, condition)
        result['phase'] = 'warmup'
        warmup_started = time.monotonic()
        page.wait_for_timeout(WARMUP_SECONDS * 1000)
        result['warmupSeconds'] = time.monotonic() - warmup_started
        result['warmupEnd'] = observation(page, selected_id)
        validate(result['warmupEnd'], condition)
        BASE.pause_public_track(page)
        result['phase'] = 'fixed-source-seek'
        result['beforeSeek'] = observation(page, selected_id)
        result['seekRequested'] = page.evaluate('({id, position})=>playbackBaselineControl.seek(id, position)', {'id': selected_id, 'position': SOURCE_START})
        page.wait_for_function('''({id, position}) => {
          const audio=bufferedPlayerProbe.snapshot().selected;
          return audio && audio.paused && !playbackBaselineControl.facts(id).seeking && Math.abs(audio.position-position)<0.001;
        }''', arg={'id': selected_id, 'position': SOURCE_START}, timeout=15000)
        result['beforeResume'] = observation(page, selected_id)
        resume_started = time.monotonic()
        BASE.play_public_track(page)
        result['resumed'] = wait_ready(page, selected_id, condition)
        if trace_host:
            inspector = (ROOT / 'tests/fixtures/host-clock-probe.js').read_text(encoding='utf-8').strip().removesuffix(';')
            lifecycle = (ROOT / 'tests/fixtures/host-lifecycle-probe.js').read_text(encoding='utf-8').strip().removesuffix(';')
            result['hostLifecycleInstallation'] = page.evaluate(f'() => ({inspector})({lifecycle})')
        result['resumeReadinessSeconds'] = time.monotonic() - resume_started
        result['resumeReadinessMeaning'] = 'Time until the state and last analyser window satisfy the readiness predicate. This is not audible latency or proof of fresh post-seek samples; the analyser may still contain earlier audio.'
        result['phase'] = 'measure'
        if continuous_output:
            monitor = (ROOT / 'tests/fixtures/continuous-output-worklet.js').read_text(encoding='utf-8')
            page.evaluate('source => bufferedPlayerProbe.monitorOutput(source)', monitor)
        if trace_audio_from is not None:
            profile = WorkletTrace(session, page,
                ROOT / f'test-results/worklet-trace-{report["runId"]}-{condition["name"]}.jsonl',
                result['resumed']['playback']['selected']['contextSampleRate'], trace_audio_from)
            timed_capture(page, session, tree, selected_id, condition, result, checkpoint, profile)
        else:
            timed_capture(page, session, tree, selected_id, condition, result, checkpoint)
        if continuous_output:
            output = page.evaluate('bufferedPlayerProbe.readOutputMonitor()')
            result['continuousOutput'] = output
            check(output['frames'] >= SECONDS * output['sampleRate'], 'Continuous output capture is too short')
            check(output['end'] - output['start'] == output['frames'] and output['gaps'] == 0, 'Output monitor frame coverage has gaps')
            check(output['nonfinite'] == 0 and output['peak'] > 1e-7, 'Continuous output is nonfinite or inactive')
            check(output['longestSilentRun'] < 128, 'Continuous output contains a silent quantum; inspect source silence or starvation')
        if recover_host:
            result['phase'] = 'host-recovery'
            check(result.get('projectWarningCount', 0) == 0, 'Unexpected project warning before host fault injection')
            result['hostRecovery'] = verify_host_recovery(page)
        check(not result['pageErrors'], 'Page errors occurred during the condition; inspect the recorded errors')
        if block_dependency_cdn:
            check(not result['blockedDependencyRequests'], 'Bundled playback attempted a dependency CDN request')
        result['status'] = 'PASSED'
        result['phase'] = 'complete'
    except Exception as error:
        result['error'] = {'name': type(error).__name__, 'message': str(error)[:4000]}
        try:
            result['failureSnapshot'] = BASE.snapshot(page)
            result['failureReadiness'] = page.evaluate('globalThis.playbackBaselineReadiness ?? null')
        except Exception as capture:
            result['captureError'] = str(capture)[:1000]
    finally:
        if continuous_output and 'continuousOutput' not in result:
            try:
                result['continuousOutput'] = page.evaluate('bufferedPlayerProbe.readOutputMonitor()')
            except Exception as error:
                result['continuousOutputError'] = str(error)[:1000]
        if profile:
            try:
                result['workletTrace'] = profile.stop()
                if result['workletTrace']['status'] != 'OBSERVED':
                    result['status'] = 'INCOMPLETE'
            except Exception as error:
                result['workletTraceError'] = str(error)[:1000]
                result['status'] = 'INCOMPLETE'
        if trace_host:
            try:
                result['hostLifecycle'] = page.evaluate('() => { const probe = globalThis.hostLifecycleProbe; return probe ? {...probe.snapshot(), restored: probe.restore()} : null; }')
            except Exception as error:
                result['hostLifecycleCaptureError'] = str(error)[:1000]
        try:
            result['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
            check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in result['stopped']['contexts']), 'Diagnostic contexts did not close muted')
        except Exception as error:
            result['cleanupError'] = str(error)[:2000]
            result['status'] = 'INCOMPLETE'
        context.close()
        browser.close()
        result['contextClosed'] = True
        result['browserClosed'] = True
    if recover_host and result.get('hostRecovery', {}).get('status') == 'PASSED':
        expected = '[SoundCloud Tempo] SoundCloudHostClockError: SoundCloud playback integration is unavailable: the _getTruePosition implementation changed.'
        warnings = result.get('projectWarnings', [])
        accepted = (result.get('projectWarningCount', 0) == 1 and len(warnings) == 1
                    and warnings[0].startswith(expected) and result.get('pageErrorCount', 0) == 0)
        result['runtimeDiagnostics'] = {
            'status': 'PASSED' if accepted else 'INCOMPLETE',
            'expectedInjectedWarningCount': 1,
            'projectWarnings': warnings,
            'projectWarningCount': result.get('projectWarningCount', 0),
            'pageErrorCount': result.get('pageErrorCount', 0),
        }
        if not accepted:
            result['status'] = 'INCOMPLETE'
            result['error'] = {'phase': 'runtime-diagnostics', 'message': 'Fault injection did not produce exactly its expected diagnostic'}
    else:
        BASE.assess_diagnostics(result)
    return result['status'] == 'PASSED'


def comparisons(results):
    passed = {item['condition']['name']: item for item in results if item['status'] == 'PASSED'}
    pairs = [
        ('natural-userscript-vs-plain', 'plain-natural', 'userscript-natural'),
        ('browser-preserve-vs-natural', 'plain-natural', 'plain-preserve'),
        ('wasm-userscript-vs-browser-preserve', 'plain-preserve', 'userscript-preserve-wasm'),
        ('buffered-preserve-vs-natural', 'buffered-natural', 'buffered-preserve'),
    ]
    result = []
    for name, before, after in pairs:
        if before not in passed or after not in passed:
            continue
        first = passed[before]
        last = passed[after]
        result.append({
            'name': name,
            'baseline': before,
            'condition': after,
            'rate': first['condition']['rate'],
            'oneCorePercentDifference': last['cpu']['oneCorePercent'] - first['cpu']['oneCorePercent'],
            'pageTaskPercentDifference': last['pageMetrics']['taskDurationPercent'] - first['pageMetrics']['taskDurationPercent'],
            'privateWorkingSetEndpointDifferenceBytes': last['memoryAfter']['privateWorkingSetBytes'] - first['memoryAfter']['privateWorkingSetBytes'],
            'actualSourceStartDifferenceSeconds': last['actualSourceStart'] - first['actualSourceStart'],
            'scope': 'Single sequential fresh-profile observations at the same rate and commanded source window, not a causal per-library overhead estimate or statistical benchmark.',
        })
    return result


def main():
    global SECONDS
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-artifact', required=True)
    parser.add_argument('--case', choices=[item['name'] for item in CONDITIONS], action='append')
    parser.add_argument('--artifact', default='dist/soundcloud-tempo-control.user.js')
    parser.add_argument('--seconds', type=int, choices=[40, 120, 360, 720, 1800, 3600], default=40)
    parser.add_argument('--trace-host-lifecycle', action='store_true')
    parser.add_argument('--trace-audio-from', type=int)
    parser.add_argument('--block-dependency-cdn', action='store_true')
    parser.add_argument('--verify-host-recovery', action='store_true')
    parser.add_argument('--continuous-output', action='store_true')
    options = parser.parse_args()
    SECONDS = options.seconds
    if options.trace_audio_from is not None:
        check(0 <= options.trace_audio_from < SECONDS and options.trace_audio_from % 20 == 0, 'Audio tracing must start at a twenty-second checkpoint before completion')
    artifact_path = ROOT / options.artifact
    artifact = artifact_path.read_bytes()
    artifact_hash = hashlib.sha256(artifact).hexdigest()
    check(artifact_hash == options.expected_artifact.lower(), 'Built userscript does not match the expected artifact')
    original = artifact.decode('utf-8')
    constants = subprocess.run(
        [os.environ.get('NODE', 'node'), str(ROOT / 'tests/artifact-constants.cjs'), str(artifact_path), 'MIN'],
        check=True, capture_output=True, text=True, timeout=30,
    )
    check(json.loads(constants.stdout) == {'MIN': 0.025}, 'Actual userscript minimum is not 0.025')
    injection = userscript_source(artifact_path)
    check(injection.count(original) == 1, 'Injected userscript was modified or changed while loading')
    fixture_path = ROOT / 'tests/fixtures/buffered-player-probe.js'
    fixture = fixture_path.read_bytes()
    common = fixture.decode() + '\n' + CONTROL_PROBE
    condition_list = [item for item in CONDITIONS if not options.case or item['name'] in options.case]
    check(not options.verify_host_recovery or all(item['buffered'] for item in condition_list), 'Host recovery requires buffered conditions')
    check(SECONDS <= 120 or all(item['buffered'] for item in condition_list), 'Long sessions require explicitly selected buffered cases')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
    latest = ROOT / 'test-results/playback-baseline.json'
    output = latest.with_name(f'playback-baseline-{run_id}.json')
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'status': 'RUNNING',
        'runId': run_id,
        'suiteKind': 'selected-conditions' if options.case else 'full-matrix',
        'reportPath': str(output),
        'latestReportPath': str(latest),
        'previousReportArchive': preserve_report(latest),
        'activeCondition': None,
        'track': BASE.TRACK,
        'artifactSha256': artifact_hash,
        'artifactBytes': len(artifact),
        'hostLifecycleTrace': options.trace_host_lifecycle,
        'audioTraceFromSeconds': options.trace_audio_from,
        'dependencyCdnBlocked': options.block_dependency_cdn,
        'hostRecoveryRequested': options.verify_host_recovery,
        'continuousOutputRequested': options.continuous_output,
        'continuousOutputProbeSha256': hashlib.sha256((ROOT / 'tests/fixtures/continuous-output-worklet.js').read_bytes()).hexdigest() if options.continuous_output else None,
        'hostLifecycleProbeSha256': hashlib.sha256((ROOT / 'tests/fixtures/host-lifecycle-probe.js').read_bytes()).hexdigest() if options.trace_host_lifecycle else None,
        'hostLifecycleInspectorSha256': hashlib.sha256((ROOT / 'tests/fixtures/host-clock-probe.js').read_bytes()).hexdigest() if options.trace_host_lifecycle else None,
        'injectedSourceSha256': hashlib.sha256(injection.encode()).hexdigest(),
        'baseProbeSha256': hashlib.sha256(fixture).hexdigest(),
        'controlProbeSha256': hashlib.sha256(CONTROL_PROBE.encode()).hexdigest(),
        'measurementVerifierSha256': hashlib.sha256(SESSION_PATH.read_bytes()).hexdigest(),
        'baseVerifierSha256': hashlib.sha256(SESSION.BASE_PATH.read_bytes()).hexdigest(),
        'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'viewport': {'width': 1440, 'height': 1000},
        'requestedSecondsPerCondition': SECONDS,
        'requestedWarmupSeconds': WARMUP_SECONDS,
        'requestedSourceStartSeconds': SOURCE_START,
        'maximumActualSourceStartOffsetSeconds': START_TOLERANCE_SECONDS,
        'sampleIntervalSeconds': SAMPLE_SECONDS,
        'matchedOutputLevel': {'logicalVolume': 0.5, 'userscriptOutputDb': 0, 'speakerGain': 0},
        'plannedConditions': condition_list,
        'conditions': [],
        'scope': 'Matched public SoundCloud diagnostic using fresh isolated Chrome processes. Every condition has the same host-media observer, command observer, final analyser and permanent zero-gain sink. Plain controls omit all userscript and @require bytes. Controls only set public volume, rate, pitch-preservation and seek properties; no media source or library factory is substituted.',
        'limitations': [
            f'For the requested {SECONDS}-second wall interval, expected source coverage is {SECONDS * 0.85:g} seconds at 0.85 and {SECONDS * 0.025:g} seconds at 0.025. Failed runs may stop earlier. Comparisons stay within each rate group. Native 0.025 playback is not fabricated.',
            'All conditions request a 30-second source start. Measured boundaries include native scheduling and readiness delay, are reported explicitly and must stay within 0.5 seconds of the requested start. They are not sample-identical windows.',
            'Analyser windows every twenty seconds verify sampled signal, not continuous glitch-free output, pitch accuracy or perceptual quality.',
            'Resume readiness measures only the state predicate and potentially stale analyser history, not audible startup latency. Final source progression must independently agree with monotonic wall time as well as the audio-context clock.',
            'Fresh profiles have no shared browser cache, auth or storage. Public-site responses, advertisements, compilation timing, network state and sequential run order remain uncontrolled.',
            'Whole Chrome CPU includes browser services, SoundCloud, decoding, DSP and the shared diagnostic instrumentation. Page TaskDuration and JS heap are not total native or worklet metrics.',
            'Private working set is Windows psutil USS; private committed bytes are different. Summed RSS can double-count shared pages. Only endpoint memory is measured, without forced garbage collection; no peak or leak conclusion follows.',
            'CPU endpoint sampling can miss processes that exist only between endpoints. Reported process identity and churn delimit the available measurements.',
            'No CPU profiler or continuous resource sampling runs inside the measured interval. Signal snapshots every twenty seconds and ordinary test event handling still contribute instrumentation cost.',
            'This is one run per condition, not a statistical benchmark, negligible-overhead claim, installed-manager verification or long-mix test.',
            'Other coordinated browser tests should be idle; unrelated user processes, power state and scheduler load are outside this diagnostic’s control.',
            'Reports are checkpointed before each condition, after each twenty-second sample and after browser cleanup. Sample checkpoint I/O is inside the wall interval but outside the observed browser process tree. A crash retains completed samples and remains incomplete. These runs are not directly comparable to older CPU runs without interval checkpointing.',
        ],
    }
    checkpoint(report, output, latest)
    print(f'Run {run_id}: {output}', flush=True)
    try:
        with sync_playwright() as runtime:
            for condition in condition_list:
                report['activeCondition'] = condition['name']
                checkpoint(report, output, latest)
                source = common + '\nif (window.top === window && location.origin === "https://soundcloud.com") {\n'
                if condition['userscript']:
                    source += injection + '\n'
                source += 'bufferedPlayerProbe.observeCommands();\n}'
                print(f'Preparing {condition["name"]} in a fresh muted browser.', flush=True)
                passed = run_condition(runtime, condition, source, report, lambda: checkpoint(report, output, latest), trace_host=options.trace_host_lifecycle, trace_audio_from=options.trace_audio_from, block_dependency_cdn=options.block_dependency_cdn, recover_host=options.verify_host_recovery, continuous_output=options.continuous_output)
                report['activeCondition'] = None
                if not passed:
                    report['status'] = 'INCOMPLETE'
                checkpoint(report, output, latest)
                if not passed:
                    break
        report['status'] = 'PASSED' if len(report['conditions']) == len(condition_list) and all(item['status'] == 'PASSED' for item in report['conditions']) else 'INCOMPLETE'
    except Exception as error:
        report['status'] = 'INCOMPLETE'
        report['error'] = {'name': type(error).__name__, 'message': str(error)[:4000]}
    finally:
        checkpoint(report, output, latest)
    print(json.dumps({'status': report['status'], 'file': str(output), 'artifactSha256': artifact_hash, 'conditions': [{'name': item['condition']['name'], 'status': item['status'], 'phase': item['phase'], 'error': item.get('error'), 'cpu': item.get('cpu'), 'pageMetrics': item.get('pageMetrics')} for item in report['conditions']], 'comparisons': report['comparisons']}, indent=2), flush=True)
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
