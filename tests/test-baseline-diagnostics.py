import importlib.util
import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('baseline', Path(__file__).with_name('verify-playback-baseline.py'))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


class BaselineFixture:
    def __init__(self, events=None, measurement_error=None, stop_error=None):
        self.events = events or {}
        self.measurement_error = measurement_error
        self.stop_error = stop_error
        self.callbacks = {}
        self.order = []
        self.report = {'conditions': []}
        self.snapshot = {'media': [{'id': 0, 'paused': False, 'ended': False, 'position': 3}]}
        self.page = Mock()
        self.page.url = baseline.BASE.TRACK
        self.page.on.side_effect = self.callbacks.__setitem__
        self.page.goto.return_value.status = 200
        self.page.evaluate.side_effect = self.evaluate
        self.context = Mock()
        self.context.new_page.return_value = self.page
        self.context.close.side_effect = lambda: self.emit('context-close')
        self.browser = Mock()
        self.browser.version = 'diagnostic-fixture'
        self.browser.new_context.return_value = self.context
        self.browser.close.side_effect = lambda: self.emit('browser-close')
        self.runtime = SimpleNamespace(chromium=SimpleNamespace(launch=lambda **options: self.browser))

    def emit(self, phase):
        self.order.append(phase)
        for kind, message in self.events.get(phase, []):
            if kind == 'pageerror':
                self.callbacks['pageerror'](RuntimeError(message))
            else:
                self.callbacks['console'](SimpleNamespace(type=kind, text=message))

    def evaluate(self, expression, *args):
        if expression == 'bufferedPlayerProbe.stop()':
            self.emit('stop')
            if self.stop_error:
                raise self.stop_error
            return {'contexts': [{'state': 'closed', 'sinkGain': 0}]}
        return self.snapshot

    def capture(self, *args):
        self.emit('measure')
        if self.measurement_error:
            raise self.measurement_error

    def run(self):
        replacements = [
            (baseline, 'browser_options', lambda: {'executable_path': 'fixture'}),
            (baseline.SESSION, 'ProcessTree', lambda *args: SimpleNamespace(proof={})),
            (baseline.BASE, 'dismiss_overlays', lambda *args: None),
            (baseline.BASE, 'play_public_track', lambda *args: None),
            (baseline.BASE, 'pause_public_track', lambda *args: None),
            (baseline.BASE, 'snapshot', lambda *args: self.snapshot),
            (baseline, 'observation', lambda *args: self.snapshot),
            (baseline, 'validate', lambda *args: None),
            (baseline, 'wait_ready', lambda *args: self.snapshot),
            (baseline, 'timed_capture', self.capture),
        ]
        with ExitStack() as stack:
            for owner, name, value in replacements:
                stack.enter_context(patch.object(owner, name, value))
            passed = baseline.run_condition(self.runtime, baseline.CONDITIONS[0], '', self.report)
        return passed, self.report['conditions'][0]


class BaselineDiagnostics(unittest.TestCase):
    def test_clean_condition_is_assessed_after_cleanup(self):
        fixture = BaselineFixture()
        passed, result = fixture.run()
        self.assertTrue(passed)
        self.assertEqual(result['status'], 'PASSED')
        self.assertEqual(result['runtimeDiagnostics']['status'], 'PASSED')
        self.assertEqual(fixture.order, ['measure', 'stop', 'context-close', 'browser-close'])
        self.assertTrue(result['contextClosed'] and result['browserClosed'])

    def test_third_party_warnings_do_not_change_success(self):
        passed, result = BaselineFixture({'stop': [('warning', 'Third-party warning')]}).run()
        self.assertTrue(passed)
        self.assertEqual(result['runtimeDiagnostics']['projectWarningCount'], 0)

    def test_project_warning_during_measurement_invalidates_success(self):
        passed, result = BaselineFixture({'measure': [('warning', '[SoundCloud Tempo] failed')]}).run()
        self.assertFalse(passed)
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertEqual(result['error']['phase'], 'runtime-diagnostics')

    def test_cleanup_project_warnings_invalidate_success(self):
        for phase in ['stop', 'context-close', 'browser-close']:
            with self.subTest(phase=phase):
                passed, result = BaselineFixture({phase: [('error', '[SoundCloud Tempo] cleanup failed')]}).run()
                self.assertFalse(passed)
                self.assertEqual(result['runtimeDiagnostics']['projectWarningCount'], 1)

    def test_cleanup_page_errors_invalidate_success(self):
        for phase in ['stop', 'context-close', 'browser-close']:
            with self.subTest(phase=phase):
                passed, result = BaselineFixture({phase: [('pageerror', 'Uncaught cleanup failure')]}).run()
                self.assertFalse(passed)
                self.assertEqual(result['runtimeDiagnostics']['pageErrorCount'], 1)

    def test_bounded_histories_cannot_hide_late_failures(self):
        events = {
            'measure': [('warning', 'Third-party warning')] * 130,
            'browser-close': [('error', '[SoundCloud Tempo] failed')] * 40 + [('pageerror', 'Failed')] * 121,
        }
        passed, result = BaselineFixture(events).run()
        self.assertFalse(passed)
        self.assertEqual(len(result['consoleWarnings']), 120)
        self.assertEqual(len(result['projectWarnings']), 32)
        self.assertEqual(len(result['pageErrors']), 120)
        self.assertEqual(result['runtimeDiagnostics']['projectWarningCount'], 40)
        self.assertEqual(result['runtimeDiagnostics']['pageErrorCount'], 121)

    def test_existing_clock_failure_is_not_replaced(self):
        events = {'browser-close': [('error', '[SoundCloud Tempo] cleanup failed')]}
        passed, result = BaselineFixture(events, measurement_error=AssertionError('Wall-clock shortfall')).run()
        self.assertFalse(passed)
        self.assertEqual(result['error'], {'name': 'AssertionError', 'message': 'Wall-clock shortfall'})
        self.assertEqual(result['runtimeDiagnostics']['projectWarningCount'], 1)

    def test_cleanup_failure_stays_incomplete_without_console_error(self):
        passed, result = BaselineFixture(stop_error=RuntimeError('Context did not close')).run()
        self.assertFalse(passed)
        self.assertEqual(result['cleanupError'], 'Context did not close')
        self.assertEqual(result['status'], 'INCOMPLETE')
        self.assertEqual(result['runtimeDiagnostics']['status'], 'PASSED')
        self.assertTrue(result['contextClosed'] and result['browserClosed'])


class BaselineCheckpoints(unittest.TestCase):
    def test_checkpoint_serializes_partial_samples_without_marking_completion(self):
        report = {'status': 'INCOMPLETE', 'conditions': [{'status': 'INCOMPLETE', 'samples': [{'sourceProgressSeconds': 0.5}]}]}
        with tempfile.TemporaryDirectory() as directory:
            output, latest = Path(directory) / 'run.json', Path(directory) / 'latest.json'
            baseline.checkpoint(report, output, latest)
            self.assertEqual(output.read_bytes(), latest.read_bytes())
            saved = json.loads(output.read_text())
            self.assertEqual(saved['completedConditions'], 0)
            self.assertEqual(saved['status'], 'INCOMPLETE')
            self.assertEqual(saved['conditions'][0]['samples'][0]['sourceProgressSeconds'], 0.5)

    def test_periodic_gate_uses_elapsed_target_not_the_full_hour(self):
        with patch.object(baseline, 'SECONDS', 3600):
            result = baseline.wall_clock_progress({'before': 0, 'after': 0.001}, {'before': 20, 'after': 20.001}, 0.5, 0.025, True, 20)
            self.assertEqual(result['minimumForRequestedDuration'], 0.499)

    def test_periodic_gate_rejects_shortfall_immediately(self):
        with self.assertRaisesRegex(AssertionError, 'less than 20'):
            baseline.wall_clock_progress({'before': 0, 'after': 0.001}, {'before': 20, 'after': 20.001}, 0.4, 0.025, True, 20)


if __name__ == '__main__':
    unittest.main()
