import argparse
import array
import base64
import hashlib
import json
import math
from pathlib import Path
import sys
import threading
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source, userscript_bytes

THRESHOLD = 1e-6
QUANTUM = 128
SETUP = r'''async sampleRate => {
    const {encodeWave, encodeBase64} = await import('/tests/fixtures/test-capture.mjs');
    const context = new AudioContext({sampleRate});
    if (context.sampleRate !== sampleRate) throw new Error('Requested sample rate unavailable');
    await context.audioWorklet.addModule('/tests/fixtures/boundary-capture.mjs');
    const zero = context.createGain();
    zero.gain.value = 0;
    zero.connect(context.destination);
    const nodes = new Set(), urls = new Set(), events = [];
    const audio = new Audio();
    const source = context.createMediaElementSource(audio);
    source.connect(zero);
    const sourceEvents = ['seeking', 'seeked', 'emptied', 'loadstart', 'playing', 'pause', 'ended'];
    const recordEvent = event => events.push({type:event.type,
        frame:Math.round(context.currentTime * sampleRate), mediaTime:audio.currentTime});
    for (const name of sourceEvents) audio.addEventListener(name, recordEvent);
    const timeout = (promise, label, milliseconds=12000) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
        })]).finally(() => clearTimeout(timer));
    };
    const waitFrames = async frames => {
        const deadline = performance.now() + 10000;
        while (context.currentTime * sampleRate < frames) {
            if (performance.now() > deadline) throw new Error('Audio context stopped advancing');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    };
    const wave = sounding => {
        const pcm = new Float32Array(sampleRate * 12);
        if (sounding) for (let i=0;i<sampleRate*4;i++) pcm[i]=.2*Math.sin(2*Math.PI*440*i/sampleRate);
        const url = URL.createObjectURL(new Blob([encodeWave([pcm, pcm], sampleRate)], {type:'audio/wav'}));
        urls.add(url);
        return url;
    };
    const toneUrl = wave(true), silentUrl = wave(false);
    const recorder = seconds => {
        const frames = Math.ceil(sampleRate * seconds / 128) * 128;
        const node = new AudioWorkletNode(context, 'boundary-capture', {
            numberOfInputs:2, numberOfOutputs:1, outputChannelCount:[2],
            channelCount:2, channelCountMode:'explicit', processorOptions:{frames}
        });
        nodes.add(node);
        node.connect(zero);
        let startedResolve, completeResolve, reject;
        const started = new Promise(resolve => startedResolve=resolve);
        const complete = new Promise((resolve, fail) => {completeResolve=resolve;reject=fail;});
        node.onprocessorerror = () => reject(new Error('Boundary capture processor failed'));
        node.port.onmessage = ({data}) => {
            if (data.type === 'started') startedResolve(data.frame);
            if (data.type === 'complete') completeResolve(data);
        };
        return {node, frames, started:()=>timeout(started, 'Capture start'),
            complete:()=>timeout(complete, 'Capture completion'), start:()=>node.port.postMessage('start'),
            close:()=>{node.disconnect();node.port.close();nodes.delete(node);}};
    };
    const packageCapture = data => ({frames:data.frames, sampleRate,
        pcmBase64:encodeBase64(data.pcm.buffer), timestamps:[...data.timestamps],
        inputChannels:[...data.inputChannels], destinationGain:zero.gain.value});
    const status = () => document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent;
    const waitActive = async () => {
        const deadline = performance.now()+12000;
        while (!status().includes('WASM active')) {
            if (performance.now()>deadline) throw new Error('WASM did not activate: '+status());
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };
    await context.resume();
    window.boundaryFixture = {
        async positiveControl() {
            const capture = recorder(.2);
            const raw = context.createConstantSource(), dirty = context.createOscillator();
            const scale = context.createGain();
            raw.offset.value=0;dirty.frequency.value=440;scale.gain.value=.1;
            raw.connect(capture.node,0,0);dirty.connect(scale).connect(capture.node,0,1);
            raw.start();dirty.start();
            try { capture.start();await capture.started();return packageCapture(await capture.complete()); }
            finally {raw.stop();dirty.stop();raw.disconnect();dirty.disconnect();scale.disconnect();capture.close();}
        },
        async warm() {
            audio.pause();audio.src=toneUrl;audio.load();await timeout(audio.play(),'Playback');
            await waitActive();
            await waitFrames(context.currentTime*sampleRate + sampleRate*.75);
            return {rate:audio.playbackRate, latency:await boundaryStretchNodes[0].latency(),
                status:status(), mediaTime:audio.currentTime};
        },
        async capture(kind) {
            const capture = recorder(2.25);
            rawAudioConnect.call(source,capture.node,0,0);
            source.connect(capture.node,0,1);
            events.length=0;
            let commandFrame, commandMediaTime;
            try {
                capture.start();
                const firstFrame=await capture.started();
                await waitFrames(firstFrame + sampleRate*.35);
                commandFrame=Math.round(context.currentTime*sampleRate);
                commandMediaTime=audio.currentTime;
                if (kind==='seek') audio.currentTime=6;
                else if (kind==='replacement') {
                    audio.src=silentUrl;audio.load();await timeout(audio.play(),'Replacement playback');
                } else throw new Error('Unknown boundary operation');
                const data=await capture.complete();
                await waitActive();
                return {...packageCapture(data), kind, commandFrame, commandMediaTime, events:[...events],
                    final:{rate:audio.playbackRate, paused:audio.paused, seeking:audio.seeking,
                        mediaTime:audio.currentTime, status:status(), stretchNodes:boundaryStretchNodes.length}};
            } finally {
                rawAudioDisconnect.call(source,capture.node,0,0);
                source.disconnect(capture.node,0,1);
                capture.close();
            }
        },
        async close() {
            audio.pause();audio.removeAttribute('src');audio.load();
            for(const name of sourceEvents) audio.removeEventListener(name,recordEvent);
            rawAudioDisconnect.call(source);source.disconnect();
            for(const node of nodes){node.disconnect();node.port.close();}
            nodes.clear();zero.disconnect();await context.close();
            for(const url of urls)URL.revokeObjectURL(url);
            urls.clear();
            return {contextState:context.state, captureNodes:nodes.size, mediaUrls:urls.size,
                audioPaused:audio.paused, audioSource:audio.getAttribute('src'), destinationGain:zero.gain.value};
        }
    };
}'''


def decode_capture(capture):
    raw = base64.b64decode(capture.pop('pcmBase64'), validate=True)
    pcm = array.array('f')
    pcm.frombytes(raw)
    if sys.byteorder != 'little':
        pcm.byteswap()
    frames = capture['frames']
    assert frames % QUANTUM == 0 and frames <= capture['sampleRate'] * 5, capture
    assert len(pcm) == frames * 4 and len(capture['timestamps']) == frames // QUANTUM
    assert len(capture['inputChannels']) == frames // QUANTUM * 2
    assert all(channels == 2 for channels in capture['inputChannels']), 'A stereo capture input was missing'
    assert all(b - a == QUANTUM for a, b in zip(capture['timestamps'], capture['timestamps'][1:])), 'Missing or duplicated render quantum'
    assert all(math.isfinite(sample) for sample in pcm), 'Nonfinite captured PCM'
    assert capture['destinationGain'] == 0, capture
    return raw, pcm


def quantum_peaks(capture, pcm):
    return [{
        'frame': frame,
        'rawPeak': max(abs(pcm[index]) for index in range(q * QUANTUM * 4, (q + 1) * QUANTUM * 4) if index % 4 < 2),
        'outputPeak': max(abs(pcm[index]) for index in range(q * QUANTUM * 4, (q + 1) * QUANTUM * 4) if index % 4 >= 2),
    } for q, frame in enumerate(capture['timestamps'])]


def frequency(pcm, first, last, channel, sample_rate):
    values = pcm[first * 4 + channel:last * 4:4]
    crosses = sum(left <= 0 < right for left, right in zip(values, values[1:]))
    return crosses * sample_rate / len(values)


def stale_output(peaks, deadline):
    return [item for item in peaks if item['frame'] >= deadline and item['outputPeak'] > THRESHOLD]


def analyze(capture, pcm, latency, rate):
    sample_rate = capture['sampleRate']
    peaks = quantum_peaks(capture, pcm)
    baseline = [item for item in peaks if item['frame'] + QUANTUM < capture['commandFrame']]
    assert len(baseline) >= sample_rate * .2 / QUANTUM, 'Insufficient pre-boundary capture'
    assert all(item['rawPeak'] > .005 and item['outputPeak'] > .005 for item in baseline), 'Silent positive baseline'
    baseline_frames = len(baseline) * QUANTUM
    raw_frequency = frequency(pcm, 0, baseline_frames, 0, sample_rate)
    output_frequency = frequency(pcm, 0, baseline_frames, 2, sample_rate)
    assert abs(raw_frequency - 440 * rate) < 12, ('Raw source tap invalid', raw_frequency)
    assert abs(output_frequency - 440) < 12, ('Processed output tap invalid', output_frequency)
    after_command = [item for item in peaks if item['frame'] >= capture['commandFrame']]
    nonzero = [item for item in after_command if item['rawPeak'] > THRESHOLD]
    boundary = nonzero[-1]['frame'] + QUANTUM if nonzero else after_command[0]['frame']
    assert boundary - capture['commandFrame'] < sample_rate * .25, 'Raw source did not reach requested silence promptly'
    silent = [item for item in peaks if item['frame'] >= boundary]
    assert len(silent) * QUANTUM >= sample_rate, 'Insufficient stable source-silent capture'
    assert all(item['rawPeak'] <= THRESHOLD for item in silent)
    deadline = boundary + math.ceil(latency * sample_rate)
    checked = [item for item in peaks if item['frame'] >= deadline]
    assert len(checked) * QUANTUM >= sample_rate * .75, 'Insufficient post-reset capture'
    violations = stale_output(peaks, deadline)
    immediate = stale_output(peaks, boundary)
    final = capture['final']
    assert final['rate'] == rate and not final['paused'] and not final['seeking'], final
    assert final['mediaTime'] > (6 if capture['kind'] == 'seek' else 0), final
    assert 'WASM active' in final['status'] and final['stretchNodes'] == 1, final
    expected_event = 'seeked' if capture['kind'] == 'seek' else 'loadstart'
    assert any(event['type'] == expected_event for event in capture['events']), capture['events']
    return {
        'rawFrequencyHz': raw_frequency, 'processedFrequencyHz': output_frequency,
        'commandFrame': capture['commandFrame'], 'sourceSilentBoundaryFrame': boundary,
        'resetLatencySeconds': latency, 'deadlineFrame': deadline,
        'checkedQuanta': len(checked), 'checkedSamplesPerChannel': len(checked) * QUANTUM,
        'postResetOutputPeak': max(item['outputPeak'] for item in checked),
        'immediateSourceSilentOutputPeak': max(item['outputPeak'] for item in silent),
        'immediateSourceSilentNonzeroQuanta': immediate,
        'violations': violations, 'quantumPeaks': peaks,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rates', nargs='+', type=int, choices=[48000, 96000], default=[48000, 96000])
    parser.add_argument('--report', default='wasm-boundaries.json')
    options = parser.parse_args()
    report_path = Path(options.report)
    if report_path.name != options.report or report_path.suffix != '.json':
        parser.error('--report must be a JSON filename within test-results')
    source = userscript_source()
    result = {'timestampUtc': datetime.now(timezone.utc).isoformat(),
              'userscriptSha256': hashlib.sha256(userscript_bytes()).hexdigest(),
              'threshold': THRESHOLD, 'capture': 'Every stereo frame from both inputs in one 128-frame render callback',
              'pcmLayout': 'little-endian float32 interleaved rawL/rawR/processedL/processedR',
              'scope': 'Isolated generated WAV fixtures; no external media, profile, network or perceptual assessment',
              'audio': 'Browser --mute-audio and destination gain zero', 'cases': [], 'cleanup': []}
    SimpleHTTPRequestHandler.extensions_map['.mjs'] = 'text/javascript'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as runtime:
            browser = runtime.chromium.launch(**browser_options(), headless=True,
                args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
            result['browser'] = browser.version
            try:
                for sample_rate in options.rates:
                    context = browser.new_context(viewport={'width': 1100, 'height': 800})
                    context.route('**/*', lambda route: route.continue_() if route.request.url.startswith(origin + '/') or route.request.url.startswith('blob:') else route.abort())
                    context.add_init_script('window.rawAudioConnect=AudioNode.prototype.connect;window.rawAudioDisconnect=AudioNode.prototype.disconnect;\n' + source)
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    try:
                        page.goto(origin + '/tests/fixtures/inline-fixture.html')
                        page.evaluate('''() => {
                            window.boundaryStretchNodes=[];
                            const Original=AudioWorkletNode;
                            window.AudioWorkletNode=new Proxy(Original,{construct(target,args){
                                const node=Reflect.construct(target,args);
                                if(args[1]==='signalsmith-stretch')boundaryStretchNodes.push(node);
                                return node;
                            }});
                        }''')
                        page.locator('.settings-button').click()
                        page.locator('.advanced-audio summary').click()
                        page.locator('#preserve-key').check()
                        page.locator('.close-settings').click()
                        page.evaluate(SETUP, sample_rate)
                        positive = page.evaluate('boundaryFixture.positiveControl()')
                        positive_bytes, positive_pcm = decode_capture(positive)
                        control_peaks = quantum_peaks(positive, positive_pcm)
                        assert all(item['rawPeak'] <= THRESHOLD for item in control_peaks)
                        assert all(item['outputPeak'] > .05 for item in control_peaks)
                        rejected = stale_output(control_peaks, control_peaks[0]['frame'])
                        assert len(rejected) == len(control_peaks)
                        result['cases'].append({'name': 'contaminated-silence detector control', 'sampleRate': sample_rate,
                            'status': 'PASS', 'capturedFrames': positive['frames'], 'detectorRejected': bool(rejected),
                            'rawPeak': max(item['rawPeak'] for item in control_peaks),
                            'outputPeak': max(item['outputPeak'] for item in control_peaks)})
                        del positive_bytes, positive_pcm
                        for rate in [.5, 1.5]:
                            page.locator('#rate-number').fill(str(rate))
                            page.locator('#rate-number').press('Enter')
                            for kind in ['seek', 'replacement']:
                                case = {'name': kind, 'sampleRate': sample_rate, 'rate': rate}
                                result['cases'].append(case)
                                try:
                                    warm = page.evaluate('boundaryFixture.warm()')
                                    assert warm['rate'] == rate and 0 < warm['latency'] <= .15, warm
                                    capture = page.evaluate('kind => boundaryFixture.capture(kind)', kind)
                                    raw, pcm = decode_capture(capture)
                                    artifact = f'{report_path.stem}-{sample_rate}-{rate}-{kind}.f32'
                                    (ROOT / 'test-results' / artifact).write_bytes(raw)
                                    case.update({'pcmArtifact': artifact, 'pcmSha256': hashlib.sha256(raw).hexdigest(),
                                        'pcmBytes': len(raw), 'captureCapFrames': capture['frames'],
                                        'timestamps': capture['timestamps'], 'inputChannels': capture['inputChannels'],
                                        'events': capture['events'], 'final': capture['final']})
                                    analysis = analyze(capture, pcm, warm['latency'], rate)
                                    case.update(analysis)
                                    case['status'] = 'FAIL' if analysis['violations'] else 'PASS'
                                    del raw, pcm, capture
                                except Exception as error:
                                    case.update({'status': 'FAIL', 'error': str(error)})
                        assert not errors, errors
                    except Exception as error:
                        result['cases'].append({'name': 'harness', 'sampleRate': sample_rate, 'status': 'FAIL', 'error': str(error), 'pageErrors': errors})
                    finally:
                        try:
                            cleanup = page.evaluate('boundaryFixture.close()')
                            assert cleanup == {'contextState': 'closed', 'captureNodes': 0, 'mediaUrls': 0,
                                'audioPaused': True, 'audioSource': None, 'destinationGain': 0}, cleanup
                            result['cleanup'].append({'sampleRate': sample_rate, **cleanup})
                        except Exception as error:
                            result['cases'].append({'name': 'cleanup', 'sampleRate': sample_rate, 'status': 'FAIL', 'error': str(error)})
                        context.close()
            finally:
                browser.close()
                result['browserClosed'] = True
    finally:
        server.shutdown()
        server.server_close()
        result['serverClosed'] = True
    result['status'] = 'PASS' if all(case['status'] == 'PASS' for case in result['cases']) else 'FAIL'
    (ROOT / 'test-results' / options.report).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    compact = {**result, 'cases': [{key: value for key, value in case.items()
        if key not in ['timestamps', 'inputChannels', 'quantumPeaks', 'immediateSourceSilentNonzeroQuanta']} for case in result['cases']]}
    print(json.dumps(compact, indent=2))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
