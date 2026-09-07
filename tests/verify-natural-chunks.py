import json
import hashlib
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options

PROBE = '''async () => {
    const sourceRate = 44100;
    const frames = 8192;
    const chunkFrames = 1024;
    const channels = Array.from({length:2}, () => new Float32Array(frames));
    let seed = 19283;
    for (let frame = 0; frame < frames; frame++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = (seed / 4294967296 - .5) * .04;
        const time = frame / sourceRate;
        channels[0][frame] = .2 * Math.sin(2*Math.PI*960*time + .7) + noise;
        channels[1][frame] = .15 * Math.sin(2*Math.PI*(360*time + 2000*time*time)) - noise;
    }
    const render = async (sampleRate, rate, padding, chunked, program, probeClock = false, legacy = false) => {
        rate = Math.fround(rate);
        const lead = 128 / sampleRate;
        const at = sourceFrame => program ? program.outputAt(sourceFrame)/sampleRate : lead + sourceFrame/sourceRate/rate;
        const length = Math.ceil(at(frames)*sampleRate) + 128;
        const context = new OfflineAudioContext(2, length, sampleRate);
        for (let offset = 0; offset < frames; offset += chunked ? chunkFrames : frames) {
            const count = chunked ? chunkFrames : frames;
            const start = Math.max(0,offset-padding), end = Math.min(frames,offset+count+padding);
            const buffer = context.createBuffer(2,end-start,sourceRate);
            channels.forEach((channel,index) => buffer.copyToChannel(probeClock ? Float32Array.from({length:end-start}, (_,frame)=>(start+frame)/frames) : channel.subarray(start,end),index));
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = program && !legacy ? program.intervals.findLast(event=>event.outputFrame<=at(offset)*sampleRate).rate : rate;
            if (program) for (const event of program.intervals)
                source.playbackRate.setValueAtTime(event.rate,(event.outputFrame-(legacy?0:.5))/sampleRate);
            source.connect(context.destination);
            source.start(at(offset), (offset-start)/sourceRate);
            source.stop(at(offset+count));
        }
        return await context.startRendering();
    };
    const cases = [];
    for (const sampleRate of [48000,96000]) {
        for (const rate of [.025,.25,.85,1,2,4]) {
            const reference = await render(sampleRate,rate,0,false);
            for (const padding of [0,32,128]) {
                const actual = await render(sampleRate,rate,padding,true);
                let square = 0, peak = 0, invalid = 0, boundaryPeak = 0, peakFrame = 0, peakValues;
                for (let channel = 0; channel < 2; channel++) {
                    const a = actual.getChannelData(channel), b = reference.getChannelData(channel);
                    for (let index = 128; index < a.length - 128; index++) {
                        const delta = a[index] - b[index];
                        if (!Number.isFinite(delta)) invalid++;
                        square += delta * delta;
                        if (Math.abs(delta) > peak) {
                            peak = Math.abs(delta);
                            peakFrame = index;
                            peakValues = [a[index],b[index]];
                        }
                    }
                    for (let chunk = 1; chunk < frames/chunkFrames; chunk++) {
                        const center = 128 + Math.round(chunk*chunkFrames/sourceRate/rate*sampleRate);
                        for (let index = center-128; index < center+128; index++)
                            boundaryPeak = Math.max(boundaryPeak,Math.abs(a[index]-b[index]));
                    }
                }
                const rms = Math.sqrt(square/((actual.length-256)*2));
                cases.push({sampleRate,sourceRate,rate,effectiveRate:Math.fround(rate),padding,frames:actual.length,rms,peak,peakFrame,peakValues,boundaryPeak,invalid,
                    matchesReference: invalid === 0 && rms <= 1e-5 && peak <= 1e-3});
            }
        }
    }
    const dynamic = [];
    const controls = [];
    const curves = {
        step: time => time < .07 ? .85 : .025,
        ramp: time => .025 + Math.min(1,time/.16)*.225,
        smooth: time => { const x=Math.min(1,time/.16); return .85 - .825*x*x*(3-2*x); },
        fast: time => time < .09 ? .025 : 4,
    };
    for (const sampleRate of [48000,96000]) {
        for (const [name,rateAt] of Object.entries(curves)) {
            const windows = [];
            let sourceStartFrame = 0, outputStartFrame = 128;
            while (sourceStartFrame < frames) {
                const window = createRateWindow({sourceStartFrame,outputStartFrame,
                    sourceSampleRate:sourceRate,outputSampleRate:sampleRate,
                    frameCount:Math.floor(sampleRate*2/128)*128,rateAt});
                windows.push(window);
                sourceStartFrame=window.sourceEndFrame;
                outputStartFrame=window.outputEndFrame;
                if (windows.length > 8) throw new Error('Unbounded test schedule');
            }
            const program = {
                intervals:windows.flatMap(window=>window.intervals),
                outputAt:frame=>windows.find(window=>frame<=window.sourceEndFrame).outputAt(frame),
            };
            const reference = await render(sampleRate,1,0,false,program);
            const actual = await render(sampleRate,1,128,true,program);
            const clockProbe = await render(sampleRate,1,0,false,program,true);
            const chunkClockProbe = await render(sampleRate,1,128,true,program,true);
            const clockValues = clockProbe.getChannelData(0);
            const chunkClockValues = chunkClockProbe.getChannelData(0);
            let firstClockMismatch = null, maximumClockError = 0;
            let firstChunkClockMismatch = null;
            for (let frame=128;frame<Math.floor(program.outputAt(frames-2));frame++) {
                const window=windows.find(window=>frame<window.outputEndFrame);
                const expected=window.sourceAt(frame);
                const observed=clockValues[frame]*frames;
                const error=Math.abs(observed-expected);
                maximumClockError=Math.max(maximumClockError,error);
                if (!firstClockMismatch && error>.005) firstClockMismatch={frame,expected,observed,error};
                if (!firstChunkClockMismatch && Math.abs(chunkClockValues[frame]*frames-expected)>.005)
                    firstChunkClockMismatch={frame,expected,observed:chunkClockValues[frame]*frames};
            }
            let square=0,peak=0,invalid=0,peakFrame=0;
            for (let channel=0;channel<2;channel++) {
                const a=actual.getChannelData(channel), b=reference.getChannelData(channel);
                for (let frame=0;frame<a.length;frame++) {
                    const delta=a[frame]-b[frame];
                    if (!Number.isFinite(delta)) invalid++;
                    square+=delta*delta;
                    if (Math.abs(delta)>peak) { peak=Math.abs(delta); peakFrame=frame; }
                }
            }
            const rms=Math.sqrt(square/(actual.length*2));
            dynamic.push({name,sampleRate,frames:actual.length,rms,peak,peakFrame,invalid,firstClockMismatch,maximumClockError,firstChunkClockMismatch,
                matchesReference:invalid===0&&rms<=1e-5&&peak<=1e-3&&!firstClockMismatch&&!firstChunkClockMismatch});
            if (name === 'ramp') {
                const contaminated = await render(sampleRate,1,128,true,program,false,true);
                let peak=0;
                const a=contaminated.getChannelData(0),b=reference.getChannelData(0);
                for (let frame=0;frame<a.length;frame++) peak=Math.max(peak,Math.abs(a[frame]-b[frame]));
                controls.push({sampleRate,peak,rejected:peak>1e-3});
            }
        }
    }
    return {cases,dynamic,controls};
}'''


def main():
    result = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Offline generated PCM; independent contiguous native reference versus separately scheduled chunks',
        'audio': 'OfflineAudioContext only; muted browser; no device output',
        'status': 'MEASURED',
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        try:
            page = browser.new_page()
            result['browser'] = browser.version
            source = (ROOT / 'src/audio/rate-clock.mjs').read_text(encoding='utf-8')
            result['rateClockSha256'] = hashlib.sha256(source.encode('utf-8')).hexdigest()
            page.add_script_tag(type='module', content=source+'\nwindow.createRateWindow=createRateWindow;')
            page.wait_for_function('typeof createRateWindow === "function"')
            page.add_script_tag(content='window.naturalChunksProbe='+PROBE)
            result.update(page.evaluate('''async () => {
                let timer;
                try {
                    return await Promise.race([
                        naturalChunksProbe(),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chunk diagnostic timed out')), 30000); }),
                    ]);
                } finally { clearTimeout(timer); }
            }'''))
        finally:
            browser.close()
    result['allPaddedCasesMatch'] = all(case['matchesReference'] for case in result['cases'] if case['padding'] == 128)
    result['allDynamicCasesMatch'] = all(case['matchesReference'] for case in result['dynamic'])
    result['controlsRejected'] = all(case['rejected'] for case in result['controls'])
    (ROOT / 'test-results/natural-chunks.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if result['allPaddedCasesMatch'] and result['allDynamicCasesMatch'] and result['controlsRejected'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
