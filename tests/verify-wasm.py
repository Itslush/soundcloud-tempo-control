import json
import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
CONTEXT_RATE = int(os.environ.get('TEST_CONTEXT_RATE', '48000'))


def main():
    SimpleHTTPRequestHandler.extensions_map['.mjs'] = 'text/javascript'
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio','--autoplay-policy=no-user-gesture-required'])
            page = browser.new_page(viewport={'width':1050,'height':700})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(script='window.rawAudioConnect=AudioNode.prototype.connect;\n'+userscript_source())
            page.goto(f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html')
            page.evaluate('''() => {
                window.workletUrls=new Set();
                window.workletCreations=0;
                const Worklet=window.AudioWorkletNode;
                window.AudioWorkletNode=new Proxy(Worklet,{construct(target,args){
                    const node=Reflect.construct(target,args);
                    if(args[1]==='signalsmith-stretch')workletCreations++;
                    return node;
                }});
                const create=URL.createObjectURL, revoke=URL.revokeObjectURL;
                URL.createObjectURL=function(blob){const url=create.call(this,blob);if(blob.type==='text/javascript')workletUrls.add(url);return url};
                URL.revokeObjectURL=function(url){workletUrls.delete(url);return revoke.call(this,url)};
            }''')
            page.evaluate('''async sampleRate=>{
                const {encodeWave}=await import('/tests/fixtures/test-capture.mjs');
                window.ctx=new AudioContext({sampleRate});
                window.originalAddModule=ctx.audioWorklet.addModule;
                window.audio=new Audio();
                const pcm=Float32Array.from({length:480000},(_,i)=>.2*Math.sin(2*Math.PI*440*i/48000));
                audio.src=URL.createObjectURL(new Blob([encodeWave([pcm,pcm],48000)],{type:'audio/wav'}));
                window.source=ctx.createMediaElementSource(audio);
                window.volume=ctx.createGain();volume.gain.value=.4;
                window.analyser=ctx.createAnalyser();analyser.fftSize=32768;
                const mute=ctx.createGain();mute.gain.value=0;
                source.connect(volume).connect(analyser).connect(mute).connect(ctx.destination);
                window.rawAnalyser=ctx.createAnalyser();rawAnalyser.fftSize=2048;
                rawAudioConnect.call(source,rawAnalyser);rawAnalyser.connect(mute);
                await ctx.resume();await audio.play();
                window.measure=()=>{
                    const pcm=new Float32Array(32768);analyser.getFloatTimeDomainData(pcm);
                    let crosses=0,peak=0;for(let i=1;i<pcm.length;i++){if(pcm[i-1]<=0&&pcm[i]>0)crosses++;peak=Math.max(peak,Math.abs(pcm[i]));}
                    return {frequency:crosses*ctx.sampleRate/pcm.length,peak,preservesPitch:audio.preservesPitch};
                };
            }''', CONTEXT_RATE)
            assert page.evaluate('ctx.sampleRate') == CONTEXT_RATE
            page.locator('#rate-number').fill('0.5')
            page.locator('#rate-number').press('Enter')
            page.locator('.settings-button').click()
            page.locator('.advanced-audio summary').click()
            page.locator('#preserve-key').check()
            page.wait_for_function("document.querySelector('#soundcloud-tempo-control')?.shadowRoot?.querySelector('#wasm-status')?.textContent.includes('WASM active')", timeout=15000)
            page.wait_for_timeout(1200)
            preserved = page.evaluate('measure()')
            assert page.evaluate('workletUrls.size')==0
            assert page.evaluate('ctx.audioWorklet.addModule===originalAddModule')
            assert abs(preserved['frequency']-440)<5 and .01<preserved['peak']<.1 and not preserved['preservesPitch'], preserved
            page.locator('#use-wasm').uncheck()
            page.wait_for_function('audio.preservesPitch === true')
            assert page.evaluate('localStorage.getItem("soundcloud.tempo.useWasm")') == 'false'
            assert 'Browser pitch preservation' in page.locator('#wasm-status').inner_text()
            page.locator('#use-wasm').check()
            page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')")
            page.wait_for_timeout(500)
            assert not page.evaluate('audio.preservesPitch')
            page.evaluate('audio.currentTime=3')
            page.wait_for_timeout(1300)
            seek = page.evaluate('measure()')
            assert abs(seek['frequency']-440)<5, seek
            page.locator('#preserve-key').uncheck()
            page.wait_for_timeout(900)
            natural = page.evaluate('measure()')
            assert abs(natural['frequency']-220)<5 and not natural['preservesPitch'], natural
            page.locator('#preserve-key').check()
            transitions = []
            for index, rate in enumerate([.25, .5, .75, 1, 1.5, 2, 4]):
                frequency = 440 if index % 2 == 0 else 660
                page.locator('#rate-number').fill(str(rate))
                page.locator('#rate-number').press('Enter')
                page.evaluate('''async frequency => {
                    const {encodeWave}=await import('/tests/fixtures/test-capture.mjs');
                    const old=audio.src;
                    const pcm=Float32Array.from({length:576000},(_,i)=>.2*Math.sin(2*Math.PI*frequency*i/48000));
                    audio.src=URL.createObjectURL(new Blob([encodeWave([pcm,pcm],48000)],{type:'audio/wav'}));
                    URL.revokeObjectURL(old);
                    await audio.play();
                    audio.currentTime=1;
                }''', frequency)
                page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')", timeout=10000)
                page.wait_for_timeout(1200)
                result = page.evaluate('measure()')
                assert abs(result['frequency']-frequency)<8 and 0<result['peak']<.2, (rate, frequency, result)
                assert page.evaluate('workletUrls.size')==0
                transitions.append({'rate':rate,'expected_hz':frequency,**result})
            assert page.evaluate('workletCreations') == 1
            page.locator('#rate-number').fill('0.5')
            page.locator('#rate-number').press('Enter')
            for index in range(12):
                page.evaluate('async () => { audio.pause(); audio.currentTime=1; await audio.play(); }')
                page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')")
                page.locator('#use-wasm').uncheck()
                page.locator('#use-wasm').check()
                page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')")
                page.wait_for_function('!audio.preservesPitch && !audio.paused && !audio.seeking')
            assert page.evaluate('workletCreations') == 1
            page.evaluate('''async () => {
                const {encodeWave}=await import('/tests/fixtures/test-capture.mjs');
                const old=audio.src;
                const pcm=new Float32Array(480000);
                for(let i=0;i<96000;i++)pcm[i]=.2*Math.sin(2*Math.PI*660*i/48000);
                audio.src=URL.createObjectURL(new Blob([encodeWave([pcm,pcm],48000)],{type:'audio/wav'}));
                URL.revokeObjectURL(old);
                await audio.play();
            }''')
            page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')")
            page.wait_for_timeout(1000)
            assert abs(page.evaluate('measure().frequency')-660)<8
            boundary = page.evaluate('''() => new Promise(resolve => {
                audio.addEventListener('seeked', () => {
                    const started=ctx.currentTime, samples=[];
                    const peak=node=>{
                        const data=new Float32Array(node.fftSize);node.getFloatTimeDomainData(data);
                        return Math.max(...data.subarray(data.length-128).map(Math.abs));
                    };
                    const timer=setInterval(()=>samples.push({elapsed:ctx.currentTime-started,source:peak(rawAnalyser),output:peak(analyser)}),10);
                    setTimeout(()=>{clearInterval(timer);resolve(samples);},400);
                },{once:true});
                audio.currentTime=4;
            })''')
            assert len(boundary) >= 10 and boundary[-1]['elapsed'] >= .3, boundary
            source_silent = [sample for sample in boundary if sample['source'] < 1e-6]
            assert len(source_silent) >= 10, boundary
            assert all(sample['output'] < 1e-6 for sample in source_silent), boundary
            assert all(sample['output'] < 1e-6 for sample in boundary if sample['elapsed'] >= 0.15), boundary
            page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM active')")
            page.wait_for_timeout(1000)
            silence = page.evaluate('measure()')
            assert silence['peak'] < 1e-6, silence
            assert page.evaluate('workletCreations') == 1
            page.evaluate('audio.pause();ctx.close()')
            page.evaluate('''async sampleRate=>{
                const url=audio.src;
                window.ctx=new AudioContext({sampleRate});
                ctx.audioWorklet.addModule=()=>Promise.reject(new Error('Injected worklet failure'));
                window.audio=new Audio(url);
                const source=ctx.createMediaElementSource(audio);
                const mute=ctx.createGain();mute.gain.value=0;
                source.connect(mute).connect(ctx.destination);
                await ctx.resume();await audio.play();
            }''', CONTEXT_RATE)
            page.locator('.settings-button').click()
            page.locator('#preserve-key').check()
            page.wait_for_function("document.querySelector('#soundcloud-tempo-control').shadowRoot.querySelector('#wasm-status').textContent.includes('WASM unavailable')")
            assert page.evaluate('audio.preservesPitch') is True
            page.evaluate('audio.pause();ctx.close()')
            assert not errors, errors
            boundary_summary = {'samples':len(boundary),'first_seconds':boundary[0]['elapsed'],'last_seconds':boundary[-1]['elapsed'],'source_peak':max(sample['source'] for sample in boundary),'output_peak':max(sample['output'] for sample in boundary)}
            print(json.dumps({'context_rate':CONTEXT_RATE,'wasm':preserved,'after_seek':seek,'natural':natural,'source_and_seek_changes':transitions,'reused_node_after_12_pause_seek_and_mode_cycles':True,'silent_segment_after_seek':silence,'seek_boundary':boundary_summary,'blocked_worklet':'explicit browser fallback passed','speaker_output':'browser mute plus zero gain','scope':'local media graph; not live SoundCloud or listening quality'}, indent=2))
            browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
