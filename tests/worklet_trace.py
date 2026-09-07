import json
import math
import time
from array import array


class WorkletTrace:
    event_name = 'AudioWorkletProcessor::Process (author script execution)'
    process_event_name = 'AudioWorkletProcessor::Process'

    def __init__(self, session, page, path, sample_rate, start_seconds):
        self.session = session
        self.page = page
        self.path = path
        self.start_seconds = start_seconds
        self.budget_us = 128 * 1_000_000 / sample_rate
        self.durations = array('d')
        self.process_durations = array('d')
        self.started = False
        self.complete = None
        self.invalid = 0
        self.writer = None
        self.maximum_buffer_usage = 0

    def receive(self, payload):
        for event in payload['value']:
            name = event.get('name')
            if name not in (self.event_name, self.process_event_name):
                continue
            duration = event.get('dur')
            if event.get('ph') != 'X' or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                self.invalid += 1
                continue
            values = self.durations if name == self.event_name else self.process_durations
            values.append(duration)
            self.writer.write(json.dumps({key: event.get(key) for key in ('name', 'ts', 'dur', 'pid', 'tid', 'tts', 'tdur')}, separators=(',', ':')) + '\n')

    def maybe_start(self, elapsed):
        if self.started or elapsed < self.start_seconds:
            return
        self.writer = self.path.open('x', encoding='utf-8')
        self.session.on('Tracing.dataCollected', self.receive)
        self.session.on('Tracing.tracingComplete', self.finished)
        self.session.on('Tracing.bufferUsage', self.buffer_usage)
        self.session.send('Tracing.start', {
            'transferMode': 'ReportEvents',
            'bufferUsageReportingInterval': 1000,
            'traceConfig': {
                'recordMode': 'recordUntilFull',
                'traceBufferSizeInKb': 262144,
                'includedCategories': ['disabled-by-default-audio-worklet'],
                'excludedCategories': ['*'],
            },
        })
        self.started = True
        self.started_at = elapsed

    def finished(self, payload):
        self.complete = payload

    def buffer_usage(self, payload):
        self.maximum_buffer_usage = max(self.maximum_buffer_usage, payload.get('percentFull', 0))

    def stop(self):
        try:
            if not self.started:
                return {'status': 'NOT_STARTED', 'requestedStartSeconds': self.start_seconds}
            self.session.send('Tracing.end')
            deadline = time.monotonic() + 30
            while self.complete is None and time.monotonic() < deadline:
                self.page.wait_for_timeout(50)
            values = sorted(self.durations)
            count = len(values)
            percentile = lambda fraction: values[min(count - 1, math.ceil(count * fraction) - 1)] if count else None
            lost = self.complete is None or self.complete.get('dataLossOccurred', False) or self.maximum_buffer_usage >= 1
            processing = sorted(self.process_durations)
            return {
                'status': 'OBSERVED' if count and processing and not lost and not self.invalid else 'INCOMPLETE',
                'source': self.event_name,
                'scope': 'Native Chromium callback trace, including JS dispatch. Instrumented durations are not proof of audible underruns or uninstrumented performance. All traced AudioWorklet callbacks are included; this does not attribute multiple processors by name.',
                'startedAtElapsedSeconds': self.started_at,
                'rawEvents': str(self.path),
                'quantumFrames': 128,
                'quantumBudgetUs': self.budget_us,
                'count': count,
                'meanUs': sum(values) / count if count else None,
                'p50Us': percentile(0.5),
                'p95Us': percentile(0.95),
                'p99Us': percentile(0.99),
                'maxUs': values[-1] if count else None,
                'overQuantumBudgetCount': sum(value > self.budget_us for value in values),
                'fullProcessor': {
                    'source': self.process_event_name,
                    'scope': 'Includes native port topology checks, input/output copies, parameter handling and author callback. Nested author durations must not be added to this total. Processor identity is not present in these Chromium events.',
                    'count': len(processing),
                    'meanUs': sum(processing) / len(processing) if processing else None,
                    'p99Us': processing[math.ceil(len(processing) * 0.99) - 1] if processing else None,
                    'maxUs': processing[-1] if processing else None,
                    'overQuantumBudgetCount': sum(value > self.budget_us for value in processing),
                },
                'invalidEvents': self.invalid,
                'dataLoss': lost,
                'maximumBufferUsage': self.maximum_buffer_usage,
            }
        finally:
            if self.writer:
                self.writer.close()
            self.session.remove_listener('Tracing.dataCollected', self.receive)
            self.session.remove_listener('Tracing.tracingComplete', self.finished)
            self.session.remove_listener('Tracing.bufferUsage', self.buffer_usage)
