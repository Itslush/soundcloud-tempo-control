import base64
import io
import json
import math
import struct
import time
import wave
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright
from userscript_fixture import ROOT, browser_options


def generated_audio():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        sample_rate = 48000
        audio.setparams((1, 2, sample_rate, sample_rate * 2, 'NONE', 'not compressed'))
        pcm = bytearray(sample_rate * 2 * 2)
        for index in range(sample_rate * 2):
            value = 0.2 * math.sin(2 * math.pi * 440 * index / sample_rate)
            struct.pack_into('<h', pcm, index * 2, round(value * 32767))
        audio.writeframes(pcm)
    return base64.b64encode(output.getvalue()).decode('ascii')


PROBE = '''async ({rate, preserve, sampleRate, encoded}) => {
    const bounded = async promise => {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_,reject) => {
                    timer = setTimeout(() => reject(new Error('Audio setup timed out')),3000);
                }),
            ]);
        } finally { clearTimeout(timer); }
    };
    const started = performance.now();
    const context = new AudioContext({sampleRate});
    const audio = new Audio();
    audio.volume = 0.2;
    audio.preservesPitch = preserve;
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], {type:'audio/wav'}));
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(analyser).connect(silence).connect(context.destination);
    const result = {
        requestedRate:rate,
        requestedPreservesPitch:preserve,
        actualPreservesPitch:audio.preservesPitch,
        contextSampleRate:context.sampleRate,
        setterError:null,
        playbackError:null,
        playbackAttempted:false,
        contextAdvanceSeconds:0,
        mediaAdvanceSeconds:0,
        peak:0,
        nonzeroSamples:0,
        observations:[],
        speakerOutputGain:silence.gain.value,
    };
    try {
        const metadata = new Promise(resolve => audio.addEventListener('loadedmetadata',resolve,{once:true}));
        audio.src = url;
        await bounded(metadata);
        try { audio.playbackRate = rate; }
        catch (error) { result.setterError = {name:error.name, message:error.message}; }
        result.actualRate = audio.playbackRate;
        if (result.setterError) return result;
        await bounded(context.resume());
        await bounded(audio.play());
        result.playbackAttempted = true;
        result.rateAtPlaybackStart = audio.playbackRate;
        const clockStart = context.currentTime;
        const mediaStart = audio.currentTime;
        const data = new Float32Array(analyser.fftSize);
        for (let index = 0; index < 12; index++) {
            await new Promise(resolve => setTimeout(resolve,50));
            analyser.getFloatTimeDomainData(data);
            let peak = 0;
            for (const sample of data.subarray(-128)) peak = Math.max(peak,Math.abs(sample));
            result.peak = Math.max(result.peak,peak);
            if (peak > 0.000001) result.nonzeroSamples++;
            result.observations.push({
                contextSeconds:context.currentTime-clockStart,
                mediaSeconds:audio.currentTime-mediaStart,
                actualRate:audio.playbackRate,
                peak,
            });
        }
        result.contextAdvanceSeconds = context.currentTime-clockStart;
        result.mediaAdvanceSeconds = audio.currentTime-mediaStart;
        result.rateAtPlaybackEnd = audio.playbackRate;
        result.observedMediaToContextRatio = result.mediaAdvanceSeconds/result.contextAdvanceSeconds;
        result.mediaError = audio.error?.message || null;
    } catch (error) {
        result.playbackError = {name:error.name,message:error.message};
    } finally {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        source.disconnect();
        analyser.disconnect();
        silence.disconnect();
        await context.close();
        URL.revokeObjectURL(url);
        result.contextClosed = context.state === 'closed';
        result.blobRevoked = true;
        result.elapsedMilliseconds = Math.round(performance.now()-started);
    }
    return result;
}'''


started = time.monotonic()
with sync_playwright() as runtime:
    browser = runtime.chromium.launch(
        **browser_options(), headless=True,
        args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    )
    page = browser.new_page()
    page.goto('about:blank')
    encoded = generated_audio()
    cases = []
    for sample_rate in [48000, 96000]:
        for preserve in [False, True]:
            for rate in [1, 0.25, 0.125, 0.0625, 0.025]:
                result = page.evaluate(PROBE, {
                    'rate':rate, 'preserve':preserve,
                    'sampleRate':sample_rate, 'encoded':encoded,
                })
                cases.append(result)
                print(json.dumps({key:value for key,value in result.items() if key != 'observations'}), flush=True)
    report = {
        'timestampUtc':datetime.now(timezone.utc).isoformat(),
        'browser':browser.version,
        'elapsedSeconds':round(time.monotonic()-started,3),
        'source':'Generated 2-second, 440 Hz mono PCM WAV at 48 kHz',
        'speakerOutputMuted':True,
        'productionCodeLoaded':False,
        'cases':cases,
        'limits':[
            'Native HTMLMediaElement capability diagnostic, not userscript or WASM support verification.',
            'Only this isolated Chromium build and machine were tested.',
            'Nonzero samples and advancing clocks do not establish musical quality or exact time/pitch fidelity.',
            'The test does not establish sustained playback, buffering or CPU behavior.',
            'Rejected rates are recorded without playing their unchanged fallback rate.',
        ],
    }
    assert all(case['contextClosed'] and case['blobRevoked'] and case['speakerOutputGain'] == 0 for case in cases)
    assert all(all(sample['actualRate'] == case['requestedRate'] for sample in case['observations']) for case in cases)
    controls = [case for case in cases if case['requestedRate'] == 1]
    assert all(case['nonzeroSamples'] > 0 and case['contextAdvanceSeconds'] > 0 and case['mediaAdvanceSeconds'] > 0 for case in controls), controls
    (ROOT/'test-results'/'native-rate-limits.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    browser.close()
    print(json.dumps({'browser':report['browser'],'elapsedSeconds':report['elapsedSeconds'],'cases':len(cases),'report':'test-results/native-rate-limits.json'}),flush=True)
