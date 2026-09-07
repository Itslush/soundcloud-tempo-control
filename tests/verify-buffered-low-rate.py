import hashlib
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright
from userscript_fixture import ROOT, browser_options


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'<!doctype html><meta charset="utf-8"><title>Buffered audio diagnostic</title>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def control_valid(case):
    measurement = case.get('measurement', {})
    return (
        not case['errors']
        and case.get('nonzeroObservations', 0) >= 8
        and abs(case.get('observedSourceRate', 0) - 1) < .05
        and abs((measurement.get('toneHz') or 0) - case['sourceToneHz']) < 5
        and measurement.get('invalid', 1) == 0
        and .1 < measurement.get('rms', 0) < .2
    )


PROBE = '''async ({rate, natural, sampleRate, trace}) => {
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
    const bounded = async promise => {
        let timer;
        try {
            return await Promise.race([
                promise,
                new Promise((_,reject) => {
                    timer = setTimeout(() => reject(new Error('Library operation timed out')),1500);
                }),
            ]);
        } finally { clearTimeout(timer); }
    };
    const started = performance.now();
    const context = new AudioContext({sampleRate});
    await bounded(context.suspend());
    const originalAddModule = context.audioWorklet.addModule;
    if (trace) {
        context.audioWorklet.addModule = async function(url) {
            const source = await (await fetch(url)).text();
            const prefix = `
                const originalRegister = registerProcessor;
                globalThis.registerProcessor = (name, Processor) => originalRegister(name, class extends Processor {
                    process(inputs, outputs, parameters) {
                        this.probeCalls = (this.probeCalls || 0) + 1;
                        if (this.probeCalls < 5) this.port.postMessage(['diagnostic', {
                            phase:'entry', calls:this.probeCalls, currentTime,
                        }]);
                        let keep;
                        try { keep = super.process(inputs, outputs, parameters); }
                        catch (error) {
                            this.port.postMessage(['diagnostic', {
                                phase:'error', name:error.name, message:error.message,
                                stack:error.stack, currentTime,
                            }]);
                            throw error;
                        }
                        if (this.probeCalls < 5 || this.probeCalls % 32 === 0 || !keep) {
                            this.port.postMessage(['diagnostic', {
                                calls: this.probeCalls, currentTime, keep,
                                ready: this.wasmReady, inputs: inputs.map(input => input.length),
                                outputs: outputs.map(output => output.length), map: this.timeMap,
                            }]);
                        }
                        return keep;
                    }
                });
            `;
            const instrumented = URL.createObjectURL(new Blob([prefix, source], {type: 'text/javascript'}));
            try { return await originalAddModule.call(this, instrumented); }
            finally { URL.revokeObjectURL(instrumented); }
        };
    }
    const analyser = context.createAnalyser();
    analyser.fftSize = 32768;
    const silence = context.createGain();
    silence.gain.value = 0;
    silence.connect(context.destination);
    const tone = 960;
    const semitones = natural ? 12*Math.log2(rate) : 0;
    const result = {
        rate, mode:natural?'natural-offset':'preserve-key', semitones,
        sourceToneHz:tone, expectedToneHz:natural?tone*rate:tone,
        sampleRate:context.sampleRate, inputConnections:0, inputChunkSeconds:1,
        added:[], timeCallbacks:[], observations:[], errors:[], renderTrace:[],
        instrumented:trace, silenceMethod:'zero-gain',
    };
    const urls = new Set();
    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = function(blob) {
        const url = originalCreate.call(this,blob);
        urls.add(url);
        return url;
    };
    let node;
    let callbackCount = 0;
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const measure = () => {
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        let peak=0, energy=0, invalid=0, first=null, last=null, crossings=0;
        for(let index=0; index<data.length; index++) {
            const value=data[index];
            if(!Number.isFinite(value)) invalid++;
            peak=Math.max(peak,Math.abs(value));
            energy+=value*value;
            if(index && data[index-1]<=0 && value>0) {
                const position=index-1-data[index-1]/(value-data[index-1]);
                if(first===null) first=position;
                last=position;
                crossings++;
            }
        }
        analyser.getFloatFrequencyData(spectrum);
        let strongestBin=1;
        for(let index=2; index<spectrum.length; index++) {
            if(spectrum[index]>spectrum[strongestBin]) strongestBin=index;
        }
        const rms=Math.sqrt(energy/data.length);
        return {
            contextTime:context.currentTime, inputTime:node?.inputTime,
            peak, rms, invalid,
            levelRelativeToInputDb:rms>0?20*Math.log10(rms/(.2/Math.sqrt(2))):null,
            toneHz:crossings>1?(crossings-1)*context.sampleRate/(last-first):null,
            strongestBinHz:strongestBin*context.sampleRate/analyser.fftSize,
            strongestBinDb:Number.isFinite(spectrum[strongestBin])?spectrum[strongestBin]:null,
            binWidthHz:context.sampleRate/analyser.fftSize,
        };
    };
    const tailPeak = () => {
        const data=new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        return Math.max(...data.subarray(-128).map(Math.abs));
    };
    try {
        node = await bounded(SignalsmithStretch(context,{
            numberOfInputs:1, numberOfOutputs:1, outputChannelCount:[2],
        }));
        node.port.addEventListener('message', event => {
            if (event.data[0] !== 'diagnostic') return;
            if (result.renderTrace.length < 160) result.renderTrace.push(event.data[1]);
            if (event.data[1].phase === 'error') result.errors.push(event.data[1]);
        });
        result.inputCount = node.numberOfInputs;
        node.addEventListener('processorerror',() => result.errors.push({name:'ProcessorError',message:'The audio worklet processor failed'}));
        const configuration = {
            blockMs:Math.floor(sampleRate*.12)/sampleRate*1000,
            intervalMs:Math.floor(sampleRate*.03)/sampleRate*1000,
            splitComputation:false,
        };
        await bounded(node.configure(configuration));
        result.latencySeconds = await bounded(node.latency());
        await bounded(node.setUpdateInterval(.02,inputTime => {
            callbackCount++;
            if(result.timeCallbacks.length<160)
                result.timeCallbacks.push({contextTime:context.currentTime,inputTime});
        }));
        for(let chunk=0; chunk<4; chunk++) {
            const left=Float32Array.from({length:sampleRate},(_,index)=>.2*Math.sin(2*Math.PI*tone*(chunk+index/sampleRate)));
            const right=left.slice();
            const buffers=[left.buffer,right.buffer];
            const transferredBytes=buffers.reduce((sum,buffer)=>sum+buffer.byteLength,0);
            const end=await bounded(node.addBuffers([left,right],buffers));
            result.added.push({chunk,endSeconds:end,transferredBytes,detached:buffers.every(buffer=>buffer.byteLength===0)});
        }
        result.schedule = await bounded(node.schedule({
            active:true, input:1.5, output:context.currentTime+result.latencySeconds,
            rate, semitones,
        }));
        node.connect(analyser);
        node.connect(silence);
        await bounded(context.resume());
        await sleep(350);
        const first=measure();
        for(let index=0; index<10; index++) {
            await sleep(80);
            result.observations.push(measure());
        }
        const last=result.observations.at(-1);
        result.contextAdvanceSeconds=last.contextTime-first.contextTime;
        result.inputAdvanceSeconds=last.inputTime-first.inputTime;
        result.observedSourceRate=result.inputAdvanceSeconds/result.contextAdvanceSeconds;
        result.measurement=last;
        result.nonzeroObservations=result.observations.filter(sample=>sample.peak>1e-6).length;
        result.retainFromSeconds=Math.max(0,node.inputTime-result.latencySeconds);
        result.afterConsumedDrop=await bounded(node.dropBuffers(result.retainFromSeconds));
        result.stopSchedule=await bounded(node.stop());
        const stoppedInput=node.inputTime;
        await sleep(100);
        result.stoppedSourceClockDelta=node.inputTime-stoppedInput;
        result.afterClear=await bounded(node.dropBuffers());
        await bounded(node.configure(configuration));
        await sleep(80);
        result.outputPeakAfterReset=tailPeak();
        result.callbackCount=callbackCount;
    } catch(error) {
        result.errors.push({name:error.name,message:error.message});
    } finally {
        if(node) {
            try { await bounded(node.stop()); } catch(error) { result.errors.push({cleanup:'stop',message:error.message}); }
            try { result.finalBufferRange=await bounded(node.dropBuffers()); } catch(error) { result.errors.push({cleanup:'buffers',message:error.message}); }
            node.disconnect();
            node.port.onmessage=null;
            node.port.close();
            result.portClosed=true;
        }
        analyser.disconnect();
        silence.disconnect();
        await bounded(context.close()).catch(error=>result.errors.push({cleanup:'context',message:error.message}));
        result.contextClosed=context.state==='closed';
        URL.createObjectURL=originalCreate;
        for(const url of urls) URL.revokeObjectURL(url);
        result.revokedModuleUrls=urls.size;
        result.elapsedMilliseconds=Math.round(performance.now()-started);
    }
    return result;
}'''


metadata = json.loads((ROOT/'vendor/signalsmith/signalsmith.json').read_text(encoding='utf-8'))
library = (ROOT/'vendor/signalsmith'/metadata['file']).read_bytes()
if hashlib.sha256(library).hexdigest() != metadata['sha256']:
    raise ValueError('Pinned Signalsmith library checksum mismatch')
candidate_fix = os.environ.get('BUFFERED_COPY_FIX') == '1'
source = library.decode('utf-8')
if candidate_fix:
    patch = json.loads((ROOT/'tests/fixtures/buffered-cursor-patch.json').read_text(encoding='utf-8'))
    if patch['sha256'] != metadata['sha256'] or patch['revision'] != metadata['revision']:
        raise ValueError('Buffered cursor patch does not target the pinned library')
    for replacement in patch['replacements']:
        if source.count(replacement['find']) != replacement['count']:
            raise ValueError('Pinned buffered cursor patch no longer matches exactly')
        source = source.replace(replacement['find'], replacement['replace'])

started = time.monotonic()
server = ThreadingHTTPServer(('127.0.0.1',0),FixtureHandler)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(
            **browser_options(),headless=True,
            args=['--mute-audio','--autoplay-policy=no-user-gesture-required'],
        )
        page = browser.new_page()
        page.goto(f'http://127.0.0.1:{server.server_port}/')
        page.add_script_tag(content=source)
        cases = []
        control_only = os.environ.get('BUFFERED_CONTROL_ONLY') == '1'
        parameters=[(48000,1,False)] if control_only else [
            (sample_rate,rate,natural)
            for sample_rate in [48000,96000]
            for rate in [1,0.025]
            for natural in [False,True]
        ]
        for sample_rate,rate,natural in parameters:
            if time.monotonic()-started > 45:
                break
            result=page.evaluate(PROBE,{'rate':rate,'natural':natural,'sampleRate':sample_rate,
                'trace':os.environ.get('BUFFERED_TRACE') == '1'})
            cases.append(result)
            print(json.dumps({key:result.get(key) for key in ['rate','mode','sampleRate','observedSourceRate','measurement','errors']}),flush=True)
            if rate==1 and not control_valid(result):
                break
        report={
            'timestampUtc':datetime.now(timezone.utc).isoformat(),
            'browser':browser.version,
            'elapsedSeconds':round(time.monotonic()-started,3),
            'library':metadata,
            'completedCases':len(cases),
            'plannedCases':1 if control_only else 8,
            'status':'inconclusive',
            'speakerOutputMuted':True,
            'productionCodeLoaded':False,
            'candidateCursorFix':candidate_fix,
            'evaluatedLibrarySha256':hashlib.sha256(source.encode('utf-8')).hexdigest(),
            'productionLowRateSupport':False,
            'cases':cases,
            'limits':[
                'Failed positive controls make output feasibility inconclusive, not evidence that the low rate is unsupported.',
                'Scheduled buffered PCM feasibility experiment, not SoundCloud source integration or low-rate product support.',
                'Generated stationary tones do not establish musical quality or missing-frequency restoration.',
                'Source-time callbacks are library-reported clocks, not proof of a host media transport.',
                'Detached submitted buffers and returned ranges establish API ownership behavior, not native memory reclamation.',
                'A short run with four one-second chunks does not establish long-mix buffering, CPU cost or hour-long stability.',
            ],
        }
        controls=[case for case in cases if case['rate']==1]
        report['positiveControlsPassed']=bool(controls) and all(control_valid(case) for case in controls)
        if report['positiveControlsPassed'] and len(cases)==report['plannedCases']:
            report['status']='completed'
        report_name='buffered-low-rate-candidate.json' if candidate_fix else 'buffered-low-rate-baseline.json'
        (ROOT/'test-results'/report_name).write_text(json.dumps(report,indent=2),encoding='utf-8')
        browser.close()
        print(json.dumps({'browser':report['browser'],'elapsedSeconds':report['elapsedSeconds'],'cases':len(cases),'report':'test-results/'+report_name}),flush=True)
finally:
    server.shutdown()
    server.server_close()
if report['status']=='inconclusive':
    sys.exit(2)
