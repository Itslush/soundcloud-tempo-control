import argparse
import hashlib
import json
from pathlib import Path

import numpy as np


def analyze(path, aligned=False):
    data = path.read_bytes()
    report = json.loads(data)
    rows = []
    if any('capturedPcm' in case for case in report['cases']):
        for case in report['cases']:
            capture = case.get('capturedPcm')
            if not capture:
                continue
            pcm = np.asarray(capture['samples'], dtype=np.float64)
            if not np.isfinite(pcm).all():
                raise ValueError('Captured PCM contains nonfinite samples')
            sample_rate = capture['sampleRate']
            start = max(0, case['scheduledStartFrame'] - capture['firstFrame'] + int(sample_rate * 0.35))
            for offset in range(start, pcm.size - 16384 + 1, int(sample_rate * 0.1)):
                samples = pcm[offset:offset + 16384]
                indexes = np.flatnonzero((samples[:-1] <= 0) & (samples[1:] > 0))
                crossings = indexes - samples[indexes] / (samples[indexes + 1] - samples[indexes])
                spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size), n=262144))
                rows.append({
                    'rate': case['rate'],
                    'sourceSampleRate': case['sourceRate'],
                    'outputSampleRate': sample_rate,
                    'centerOutputSeconds': (capture['firstFrame'] + offset + samples.size / 2 - case['scheduledStartFrame']) / sample_rate,
                    'zeroCrossingHz': float((crossings.size - 1) * sample_rate / (crossings[-1] - crossings[0])) if crossings.size > 1 else None,
                    'hannSpectralPeakHz': int(np.argmax(spectrum)) * sample_rate / 262144,
                    'rms': float(np.sqrt(np.mean(samples * samples))),
                })
        return {
            'sourceReport': str(path.resolve()),
            'sourceReportSha256': hashlib.sha256(data).hexdigest(),
            'originalStatus': report['status'],
            'status': 'OBSERVED',
            'scope': 'Render-frame-indexed worklet PCM windows, not a replacement acceptance test. Overlapping windows are correlated.',
            'windows': rows,
        }
    if 'sampleRate' in report and any('runs' in case for case in report['cases']):
        for case in report['cases']:
            for run in case['runs']:
                for window in run['windows']:
                    if 'samples' not in window:
                        continue
                    samples = np.asarray(window['samples'], dtype=np.float64)
                    if samples.shape != (16384,) or not np.isfinite(samples).all():
                        raise ValueError('Expected a complete finite analyser window')
                    spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size), n=262144))
                    rows.append({
                        'rate': case['rate'],
                        'prehistory': case['prehistory'],
                        'streaming': case['streaming'],
                        'blockSamples': case.get('blockSamples', 5760),
                        'runSha256': run['sha256'],
                        'startFrame': window['startFrame'],
                        'zeroCrossingHz': window['zeroCrossingHz'],
                        'hannSpectralPeakHz': int(np.argmax(spectrum)) * report['sampleRate'] / 262144,
                        'rms': float(np.sqrt(np.mean(samples * samples))),
                    })
        return {
            'sourceReport': str(path.resolve()),
            'sourceReportSha256': hashlib.sha256(data).hexdigest(),
            'status': 'OBSERVED',
            'scope': 'Saved direct-WASM windows. Spectral estimates do not replace the original acceptance criteria.',
            'windows': rows,
        }
    for case in report['cases']:
        for window in case.get('pitchWindows', []):
            capture = window['aligned'] if aligned else window
            samples = np.asarray(capture['samples'], dtype=np.float64)
            if samples.shape != (16384,) or not np.isfinite(samples).all():
                raise ValueError('Expected a complete finite analyser window')
            sample_rate = case['outputSampleRate']
            indexes = np.flatnonzero((samples[:-1] <= 0) & (samples[1:] > 0))
            crossings = indexes - samples[indexes] / (samples[indexes + 1] - samples[indexes])
            spectrum = np.abs(np.fft.rfft(samples * np.hanning(samples.size), n=262144))
            rows.append({
                'sourceSampleRate': case['sourceSampleRate'],
                'outputSampleRate': sample_rate,
                'rate': window['rate'],
                'sourcePositionSeconds': window['transport']['position'],
                'contextTime': window['contextTime'],
                'zeroCrossingHz': float((crossings.size - 1) * sample_rate / (crossings[-1] - crossings[0]))
                if crossings.size > 1 else None,
                'alignedStartFrame': capture.get('startFrame'),
                'alignedOffsetFrames': capture.get('offsetFrames'),
                'hannSpectralPeakHz': int(np.argmax(spectrum)) * sample_rate / 262144,
                'rms': float(np.sqrt(np.mean(samples * samples))),
                'crossingIntervalPercentiles': np.percentile(np.diff(crossings), [0, 1, 25, 50, 75, 99, 100]).tolist()
                if crossings.size > 1 else None,
            })
    return {
        'sourceReport': str(path.resolve()),
        'sourceReportSha256': hashlib.sha256(data).hexdigest(),
        'transportPath': report['transportPath'],
        'originalStatus': report['status'],
        'status': 'OBSERVED',
        'aligned': aligned,
        'scope': 'Two estimates from saved analyser samples, not a replacement acceptance test. Spectral zero-padding interpolates the spectrum and does not increase measurement resolution.',
        'windows': rows,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('report', type=Path)
    parser.add_argument('--aligned', action='store_true')
    options = parser.parse_args()
    result = analyze(options.report, options.aligned)
    suffix = '-aligned-pitch-analysis.json' if options.aligned else '-pitch-analysis.json'
    output = options.report.with_name(options.report.stem + suffix)
    with output.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'windows': len(result['windows']), 'status': result['status']}))


if __name__ == '__main__':
    main()
