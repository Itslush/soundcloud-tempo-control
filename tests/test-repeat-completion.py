import importlib.util
import unittest
from copy import deepcopy
from pathlib import Path


spec = importlib.util.spec_from_file_location('repeat', Path(__file__).with_name('verify-buffered-repeat.py'))
repeat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repeat)


class RepeatCompletion(unittest.TestCase):
    def setUp(self):
        self.source = 'blob:https://soundcloud.com/current'
        self.event = {
            'id': 0, 'name': 'timeupdate',
            'before': {'source': {'src': self.source}, 'time': 100,
                       'ended': True, 'paused': True, 'nativePaused': True,
                       'nativeEnded': False, 'playbackRate': 0.025,
                       'position': 22, 'duration': 22},
        }

    def check_event(self, event):
        return repeat.completed_dispatch([event], 0, self.source, 0.025, 90)

    def test_completed_current_source_is_accepted(self):
        self.assertIs(self.check_event(self.event), self.event)

    def test_wrong_media_source_event_or_rate_is_rejected(self):
        for key, value in [('id', 1), ('name', 'pause')]:
            event = deepcopy(self.event)
            event[key] = value
            self.assertIsNone(self.check_event(event))
        for key, value in [('source', {'src': 'blob:old'}), ('playbackRate', 0.85)]:
            event = deepcopy(self.event)
            event['before'][key] = value
            self.assertIsNone(self.check_event(event))

    def test_only_buffered_completed_state_is_accepted(self):
        for key, value in [('ended', False), ('paused', False), ('nativePaused', False), ('nativeEnded', True)]:
            event = deepcopy(self.event)
            event['before'][key] = value
            self.assertIsNone(self.check_event(event))

    def test_completion_before_established_tail_is_rejected(self):
        self.event['before']['time'] = 89.999
        self.assertIsNone(self.check_event(self.event))

    def test_missing_expected_source_is_rejected(self):
        for source in ['', None, 0]:
            self.assertIsNone(repeat.completed_dispatch([self.event], 0, source, 0.025))

    def test_nonfinite_or_boolean_clock_data_is_rejected(self):
        for key in ['time', 'position', 'duration']:
            for value in [None, True, float('nan'), float('inf'), '22']:
                event = deepcopy(self.event)
                event['before'][key] = value
                self.assertIsNone(self.check_event(event))

    def test_unfinished_zero_and_out_of_tolerance_endpoints_are_rejected(self):
        for position, duration in [(21.9, 22), (0, 0), (22.0001, 22)]:
            event = deepcopy(self.event)
            event['before'].update(position=position, duration=duration)
            self.assertIsNone(self.check_event(event))


if __name__ == '__main__':
    unittest.main()
