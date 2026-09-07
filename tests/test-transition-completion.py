import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace


spec = importlib.util.spec_from_file_location('transitions', Path(__file__).with_name('verify-buffered-transitions.py'))
transitions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transitions)


class RuntimeDiagnostics(unittest.TestCase):
    def test_clean_output_and_third_party_warnings_keep_playback_result(self):
        report = {'status': 'PASSED', 'consoleWarnings': ['Third-party feature warning'], 'pageErrors': []}
        transitions.player.assess_diagnostics(report)
        self.assertEqual(report['status'], 'PASSED')
        self.assertEqual(report['runtimeDiagnostics']['status'], 'PASSED')

    def test_project_warning_invalidates_successful_playback(self):
        report = {'status': 'PASSED', 'consoleWarnings': ['[SoundCloud Tempo] teardown failed']}
        transitions.player.assess_diagnostics(report)
        self.assertEqual(report['status'], 'INCOMPLETE')
        self.assertEqual(report['error']['phase'], 'runtime-diagnostics')

    def test_uncaught_page_error_invalidates_successful_playback(self):
        report = {'status': 'PASSED', 'pageErrors': ['Uncaught TypeError']}
        transitions.player.assess_diagnostics(report)
        self.assertEqual(report['status'], 'INCOMPLETE')

    def test_bounded_history_cannot_hide_later_errors(self):
        report = {'status': 'PASSED', 'projectWarnings': [], 'projectWarningCount': 33, 'pageErrors': [], 'pageErrorCount': 121}
        transitions.player.assess_diagnostics(report)
        self.assertEqual(report['status'], 'INCOMPLETE')
        self.assertEqual(report['runtimeDiagnostics']['projectWarningCount'], 33)
        self.assertEqual(report['runtimeDiagnostics']['pageErrorCount'], 121)

    def test_diagnostics_preserve_the_first_failure(self):
        error = {'phase': 'seek', 'message': 'failed'}
        report = {'status': 'INCOMPLETE', 'error': error, 'projectWarningCount': 1}
        transitions.player.assess_diagnostics(report)
        self.assertIs(report['error'], error)

    def test_observer_keeps_project_errors_after_third_party_history_fills(self):
        callbacks = {}
        page = SimpleNamespace(on=lambda event, callback: callbacks.__setitem__(event, callback))
        report = {'status': 'PASSED', 'consoleWarnings': [], 'pageErrors': []}
        transitions.player.observe_page(page, report)
        for _ in range(130):
            callbacks['console'](SimpleNamespace(type='warning', text='Third-party warning'))
        for _ in range(40):
            callbacks['console'](SimpleNamespace(type='error', text='[SoundCloud Tempo] failed'))
        for _ in range(121):
            callbacks['pageerror'](RuntimeError('Failed'))
        transitions.player.assess_diagnostics(report)
        self.assertEqual(report['status'], 'INCOMPLETE')
        self.assertEqual(len(report['consoleWarnings']), 120)
        self.assertEqual(len(report['projectWarnings']), 32)
        self.assertEqual(report['projectWarningCount'], 40)
        self.assertEqual(len(report['pageErrors']), 120)
        self.assertEqual(report['pageErrorCount'], 121)


class CompletionEvidence(unittest.TestCase):
    def setUp(self):
        self.source = 'blob:https://soundcloud.com/current'
        self.event = {
            'name': 'pause', 'commandId': 3,
            'source': {'src': self.source, 'currentSrc': self.source},
            'sourceAfter': {'src': self.source, 'currentSrc': self.source},
            'ended': True, 'paused': True, 'seeking': False,
            'nativePaused': True, 'nativeEnded': False,
            'playbackRate': 0.025, 'duration': 10.5, 'position': 10.5,
        }

    def accepted(self, event):
        return transitions.completed_host_pause([event], 3, self.source, 0.025)

    def test_exact_completed_buffered_pause_is_accepted(self):
        self.assertIs(self.accepted(self.event), self.event)

    def test_missing_fields_and_incomplete_states_are_rejected(self):
        for field in self.event:
            with self.subTest(missing=field):
                event = deepcopy(self.event)
                del event[field]
                self.assertIsNone(self.accepted(event))
        for field, value in [
            ('name', 'play'), ('commandId', 4), ('ended', False),
            ('paused', False), ('seeking', True), ('nativePaused', False),
            ('nativeEnded', True), ('playbackRate', 0.85),
            ('position', 10.49), ('position', 10.51), ('duration', 0),
            ('position', float('nan')), ('duration', float('inf')),
            ('position', True), ('duration', '10.5'), ('ended', 1),
        ]:
            with self.subTest(field=field, value=value):
                event = deepcopy(self.event)
                event[field] = value
                self.assertIsNone(self.accepted(event))

    def test_source_changes_and_stale_current_src_are_rejected(self):
        for field in ['source', 'sourceAfter']:
            for src in ['blob:https://soundcloud.com/next', '']:
                with self.subTest(field=field, src=src):
                    event = deepcopy(self.event)
                    event[field] = {'src': src, 'currentSrc': 'blob:https://soundcloud.com/next'}
                    self.assertIsNone(self.accepted(event))
            event = deepcopy(self.event)
            event[field]['src'] = 'blob:https://soundcloud.com/next'
            self.assertIsNone(self.accepted(event))
            for src in ['', None]:
                event = deepcopy(self.event)
                event[field]['src'] = src
                self.assertIsNone(self.accepted(event))

    def test_paused_at_end_without_ended_state_is_insufficient(self):
        event = deepcopy(self.event)
        event['ended'] = False
        self.assertIsNone(self.accepted(event))

    def test_missing_expected_source_cannot_match_missing_observations(self):
        event = deepcopy(self.event)
        event['source'] = {}
        event['sourceAfter'] = {}
        for source in [None, '']:
            self.assertIsNone(transitions.completed_host_pause([event], 3, source, 0.025))

    def test_endpoint_tolerance_does_not_accept_a_larger_tail(self):
        event = deepcopy(self.event)
        event['position'] -= 0.000049
        self.assertIs(self.accepted(event), event)
        event['position'] = event['duration'] - 0.000051
        self.assertIsNone(self.accepted(event))


if __name__ == '__main__':
    unittest.main()
