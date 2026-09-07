import argparse
import hashlib
import importlib.util
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import psutil
from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source

SECONDS_PER_MODE = 120
SAMPLE_SECONDS = 20
RATE = 0.025
BASE_PATH = ROOT / 'tests/verify-buffered-player.py'
SPEC = importlib.util.spec_from_file_location('buffered_player_session_base', BASE_PATH)
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)


def check(value, message):
    if not value:
        raise AssertionError(message)


def identity(process):
    return f'{process.pid}:{process.create_time():.6f}'


def page_metrics(session):
    values = {item['name']: item['value'] for item in session.send('Performance.getMetrics')['metrics']}
    names = ['Timestamp', 'JSHeapUsedSize', 'JSHeapTotalSize', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'Nodes', 'Documents']
    check(all(name in values for name in names), 'Page metrics omitted a required field')
    return {name: values[name] for name in names}


class ProcessTree:
    def __init__(self, browser, launched_at, expected_executable):
        session = browser.new_browser_cdp_session()
        try:
            browser_processes = [item for item in session.send('SystemInfo.getProcessInfo')['processInfo'] if item['type'] == 'browser']
        finally:
            session.detach()
        check(len(browser_processes) == 1, 'Cannot identify one isolated Chrome browser process')
        self.root = psutil.Process(int(browser_processes[0]['id']))
        self.root_identity = identity(self.root)
        self.executable = Path(self.root.exe()).resolve()
        self.started = self.root.create_time()
        command = self.root.cmdline()
        check(expected_executable and self.executable == Path(expected_executable).resolve(), 'Isolated browser executable does not match the configured Chrome')
        check(self.started >= launched_at - 2, 'CDP browser process predates this test launch')
        ancestors = self.root.parents()
        check(any(process.pid == os.getpid() for process in ancestors), 'CDP browser is not a descendant of this test process')
        check('--mute-audio' in command and any(value.startswith('--headless') for value in command), 'Browser was not launched headless and muted')
        profile = next((value.split('=', 1)[1] for value in command if value.startswith('--user-data-dir=')), '')
        check('playwright_chromiumdev_profile-' in profile, 'Browser does not use an isolated Playwright temporary profile')
        self.proof = {
            'browserPid': self.root.pid,
            'browserIdentity': self.root_identity,
            'executable': str(self.executable),
            'createdAfterTestLaunch': True,
            'testProcessIsAncestor': True,
            'temporaryPlaywrightProfile': True,
            'headless': True,
            'muteAudio': True,
            'psutilVersion': psutil.__version__,
        }

    def records(self, memory):
        check(identity(self.root) == self.root_identity, 'Isolated browser PID identity changed')
        records = []
        vanished = []
        before = time.monotonic()
        for process in [self.root, *self.root.children(recursive=True)]:
            try:
                key = identity(process)
                executable = Path(process.exe()).resolve()
                check(executable == self.executable, f'Unexpected executable in isolated browser process tree: {process.pid} ({executable})')
                check(process.create_time() >= self.started - 2, 'A child process predates the isolated browser')
                cpu = process.cpu_times()
                command = process.cmdline()
                kind = next((value.split('=', 1)[1] for value in command if value.startswith('--type=')), 'browser')
                record = {'identity': key, 'pid': process.pid, 'type': kind, 'userSeconds': cpu.user, 'systemSeconds': cpu.system, 'createdAt': process.create_time()}
                if memory:
                    value = process.memory_full_info()
                    check(hasattr(value, 'uss') and hasattr(value, 'private'), 'Private memory metrics are unavailable')
                    record.update({'privateWorkingSetBytes': value.uss, 'privateCommittedBytes': value.private, 'workingSetBytes': value.rss})
                records.append(record)
            except psutil.NoSuchProcess:
                vanished.append(process.pid)
        return {'before': before, 'after': time.monotonic(), 'processes': records, 'vanishedDuringRead': vanished}

    def memory(self):
        value = self.records(True)
        for name in ['privateWorkingSetBytes', 'privateCommittedBytes', 'workingSetBytes']:
            value[name] = sum(process[name] for process in value['processes'])
        return value


def process_delta(before, after):
    first = {item['identity']: item for item in before['processes']}
    last = {item['identity']: item for item in after['processes']}
    missing = sorted(set(first) - set(last))
    added = sorted(set(last) - set(first))
    elapsed = (after['before'] + after['after'] - before['before'] - before['after']) / 2
    cpu_seconds = 0
    for key, item in last.items():
        old = first.get(key, {'userSeconds': 0, 'systemSeconds': 0})
        delta = item['userSeconds'] + item['systemSeconds'] - old['userSeconds'] - old['systemSeconds']
        check(delta >= 0, 'Process CPU clock moved backwards')
        cpu_seconds += delta
    logical_processors = psutil.cpu_count(logical=True)
    return {
        'elapsedSeconds': elapsed,
        'observedCpuSeconds': cpu_seconds,
        'oneCorePercent': cpu_seconds / elapsed * 100,
        'allLogicalProcessorsPercent': cpu_seconds / elapsed / logical_processors * 100 if logical_processors else None,
        'logicalProcessors': logical_processors,
        'processesAtStart': len(first),
        'processesAtEnd': len(last),
        'addedProcessIdentities': added,
        'endedProcessIdentities': missing,
        'endpointReadRaces': before['vanishedDuringRead'] + after['vanishedDuringRead'],
        'scope': 'Sum of observed user plus kernel CPU for the isolated Chrome process tree. Processes created and destroyed entirely between endpoint samples are not observable; ended processes may leave uncounted CPU. This is not a per-library or audio-render-thread measurement.',
    }


def validate_sample(first, current, label):
    before = first['selected']
    after = current['selected']
    check(current['documentId'] == first['documentId'], 'Document changed during the sustained interval')
    check(current['panelCount'] == 1 and current['label'] == label, 'Userscript controller or playback mode changed during the interval')
    check(after and after['id'] == before['id'], 'Selected media changed during the interval')
    check(after['contextState'] == 'running' and not after['paused'] and not after['ended'], 'Buffered playback stopped during the interval')
    check(after['nativePaused'] and abs(after['nativePosition'] - before['nativePosition']) < 0.000001, 'Native media was not parked throughout the sampled interval')
    check(abs(after['playbackRate'] - RATE) < 0.000001 and abs(after['defaultPlaybackRate'] - RATE) < 0.000001, 'Public media rate changed during the interval')
    check(after['sinkGain'] == 0 and all(item['sinkGain'] == 0 for item in current['contexts']), 'Diagnostic output mute changed')
    check(after['finite'] and after['peak'] > 1e-7, 'A sampled output window was silent or nonfinite')
    progress = after['position'] - before['position']
    minimum = RATE * (after['before'] - before['after'])
    maximum = RATE * (after['after'] - before['before'])
    check(minimum - 0.00005 <= progress <= maximum + 0.00005, f'Source clock diverged: {progress} outside {minimum}..{maximum}')
    return {'sourceProgressSeconds': progress, 'expectedMinimum': minimum, 'expectedMaximum': maximum, 'snapshot': current}


def sustained_mode(page, session, tree, mode, report):
    label = 'Buffered playback · Preserve key.' if mode == 'preserve' else 'Buffered playback · Natural pitch.'
    result = {'mode': mode, 'requestedRate': RATE, 'requestedSeconds': SECONDS_PER_MODE, 'sampleIntervalSeconds': SAMPLE_SECONDS, 'status': 'INCOMPLETE', 'samples': []}
    report['intervals'].append(result)
    result['readiness'] = BASE.measure(page, RATE, True, label)
    result['memoryBefore'] = tree.memory()
    result['pageBefore'] = page_metrics(session)
    result['first'] = BASE.snapshot(page)
    result['cpuBefore'] = tree.records(False)
    started = time.monotonic()
    result['startedUtc'] = datetime.now(timezone.utc).isoformat()
    for index in range(1, SECONDS_PER_MODE // SAMPLE_SECONDS + 1):
        deadline = started + SAMPLE_SECONDS * index
        while time.monotonic() < deadline:
            page.wait_for_timeout(min(SAMPLE_SECONDS * 1000, max(1, (deadline - time.monotonic()) * 1000)))
        observed = BASE.snapshot(page)
        sample = validate_sample(result['first'], observed, label)
        sample['elapsedSeconds'] = time.monotonic() - started
        result['samples'].append(sample)
        print(f'{mode}: {sample["elapsedSeconds"]:.1f}s / {SECONDS_PER_MODE}s, source +{sample["sourceProgressSeconds"]:.6f}s, finite output, speaker gain 0.', flush=True)
    result['elapsedSeconds'] = time.monotonic() - started
    result['cpuAfter'] = tree.records(False)
    result['pageAfter'] = page_metrics(session)
    result['memoryAfter'] = tree.memory()
    result['cpu'] = process_delta(result['cpuBefore'], result['cpuAfter'])
    elapsed = result['pageAfter']['Timestamp'] - result['pageBefore']['Timestamp']
    tasks = result['pageAfter']['TaskDuration'] - result['pageBefore']['TaskDuration']
    result['pageMetrics'] = {
        'intervalSeconds': elapsed,
        'taskDurationSeconds': tasks,
        'taskDurationPercent': tasks / elapsed * 100,
        'jsHeapUsedBeforeBytes': result['pageBefore']['JSHeapUsedSize'],
        'jsHeapUsedAfterBytes': result['pageAfter']['JSHeapUsedSize'],
        'jsHeapUsedDeltaBytes': result['pageAfter']['JSHeapUsedSize'] - result['pageBefore']['JSHeapUsedSize'],
        'scope': 'Whole page and diagnostic instrumentation. TaskDuration does not isolate DSP or native audio CPU; JS heap does not include all native, WASM or browser process memory. No forced garbage collection or profiler recording.',
    }
    check(result['elapsedSeconds'] >= SECONDS_PER_MODE, 'Sustained interval ended early')
    check(result['samples'][-1]['sourceProgressSeconds'] >= RATE * SECONDS_PER_MODE - 0.001, 'Source progression was shorter than the requested interval')
    result['status'] = 'PASSED'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-artifact')
    options = parser.parse_args()
    artifact_path = ROOT / 'dist/soundcloud-tempo-control.user.js'
    artifact = artifact_path.read_bytes()
    artifact_hash = hashlib.sha256(artifact).hexdigest()
    check(options.expected_artifact is None or artifact_hash == options.expected_artifact.lower(), 'Built userscript does not match the expected session artifact')
    original = artifact.decode('utf-8')
    check(original.count('const MIN = 0.025;') == 1, 'Actual userscript minimum is not 0.025')
    injection = userscript_source(artifact_path)
    check(injection.count(original) == 1, 'The injected artifact changed or was modified')
    fixture_path = ROOT / 'tests/fixtures/buffered-player-probe.js'
    fixture = fixture_path.read_bytes()
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'track': BASE.TRACK,
        'scope': 'One signed-out public SoundCloud track in a fresh isolated Chrome process, using the exact built userscript and pinned @require bytes. 120 actual seconds per mode at 0.025 through production source observation, decoding, ownership and rendering. No source URL, factory, minimum-rate or storage overrides. Not an installed userscript-manager test.',
        'artifactSha256': artifact_hash,
        'expectedArtifactSha256': options.expected_artifact,
        'artifactBytes': len(artifact),
        'injectedSourceSha256': hashlib.sha256(injection.encode()).hexdigest(),
        'baseVerifierSha256': hashlib.sha256(BASE_PATH.read_bytes()).hexdigest(),
        'baseProbeSha256': hashlib.sha256(fixture).hexdigest(),
        'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'status': 'INCOMPLETE',
        'intervals': [],
        'requests': [], 'responses': [], 'requestFailures': [], 'pageErrors': [], 'consoleWarnings': [],
        'limitations': [
            'Four minutes of low-rate playback consumes about six source seconds. This does not test an hour-long mix, full-track download growth or long-distance source turnover.',
            'Six periodic analyser windows per mode verify finite nonzero sampled output, not continuous glitch-free playback, spectral fidelity or subjective listening quality.',
            'The preserved base fixture retains bounded diagnostic media, command and rate-event records. Its analyser and snapshots contribute measurement overhead.',
            'Process memory is sampled only before and after each interval. Intermediate peaks are not measured. No forced garbage collection means heap changes include natural GC timing.',
            'Windows privateWorkingSetBytes uses psutil USS; privateCommittedBytes is committed private memory. Summed workingSetBytes can double-count shared pages.',
            'Whole Chrome CPU includes the SoundCloud site, decoder, rendering, network handling, browser services and test instrumentation. It cannot attribute cost to a DSP library.',
            'Process CPU endpoint sampling cannot recover CPU from children that exit between samples. CPU percentages are observations, not a negligible-footprint threshold or cross-machine benchmark.',
            'Other coordinated test browsers are idle during this run; unrelated user processes and machine power or scheduler state remain uncontrolled.',
            'Headless Chrome in an isolated profile does not establish installed Edge/Chrome manager behavior or other platform support.',
        ],
    }
    phase = 'browser-startup'
    with sync_playwright() as runtime:
        launch_options = browser_options()
        launched_at = time.time()
        browser = runtime.chromium.launch(**launch_options, headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        BASE.observe_page(page, report)
        initialization = fixture.decode() + '\nif (window.top === window && location.origin === "https://soundcloud.com") {\n' + injection + '\nbufferedPlayerProbe.observeCommands();\n}'
        context.add_init_script(initialization)
        try:
            tree = ProcessTree(browser, launched_at, launch_options.get('executable_path'))
            report['processIdentification'] = tree.proof
            report['browser'] = browser.version
            session = context.new_cdp_session(page)
            session.send('Performance.enable')
            phase = 'public-native-play'
            response = page.goto(BASE.TRACK, wait_until='domcontentloaded', timeout=35000)
            report['navigation'] = {'url': BASE.public_url(page.url), 'status': response.status if response else None}
            page.locator('#soundcloud-tempo-control').wait_for(state='attached', timeout=15000)
            BASE.dismiss_overlays(page)
            BASE.play_public_track(page)
            page.wait_for_function('bufferedPlayerProbe.snapshot().media.some(audio=>!audio.paused && audio.position>2)', timeout=30000)
            observed = BASE.snapshot(page)
            active = [audio for audio in observed['media'] if not audio['paused'] and not audio['ended'] and audio['position'] > 0]
            check(len(active) == 1, 'Public native player selection is ambiguous')
            report['nativeBaseline'] = page.evaluate('id=>bufferedPlayerProbe.select(id)', active[0]['id'])
            check(report['nativeBaseline']['selected']['sinkGain'] == 0, 'Native graph was not routed through the diagnostic mute')
            page.locator('.settings-button').click()
            page.locator('.advanced-audio summary').click()
            page.locator('#preserve-key').uncheck()
            page.locator('#use-wasm').check()
            BASE.select_tempo(page, RATE)
            phase = 'natural-120-seconds'
            sustained_mode(page, session, tree, 'natural', report)
            phase = 'preserve-120-seconds'
            page.locator('#preserve-key').check()
            sustained_mode(page, session, tree, 'preserve', report)
            report['status'] = 'PASSED'
        except Exception as error:
            report['error'] = {'phase': phase, 'name': type(error).__name__, 'message': str(error)[:4000]}
            try:
                report['failureSnapshot'] = BASE.snapshot(page)
            except Exception as capture:
                report['captureError'] = str(capture)[:1000]
        finally:
            try:
                report['stopped'] = page.evaluate('bufferedPlayerProbe.stop()')
                check(all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in report['stopped']['contexts']), 'Diagnostic contexts did not close muted')
            except Exception as error:
                report['cleanupError'] = str(error)[:2000]
                report['status'] = 'INCOMPLETE'
            context.close()
            browser.close()
            report['contextClosed'] = True
            report['browserClosed'] = True
    output = ROOT / 'test-results/buffered-session.json'
    output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    summary = {'status': report['status'], 'artifactSha256': artifact_hash, 'file': str(output), 'error': report.get('error'), 'pageErrors': report['pageErrors'], 'intervals': [{key: interval.get(key) for key in ['mode', 'status', 'elapsedSeconds', 'cpu', 'pageMetrics']} for interval in report['intervals']]}
    print(json.dumps(summary, indent=2), flush=True)
    return 0 if report['status'] == 'PASSED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
