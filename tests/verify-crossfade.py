import json
import subprocess

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, userscript_source

NODE = r'C:/Users/xxlus/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
modules = subprocess.check_output([
    NODE, '-p', "require('./tests/module-fixture.cjs')(['tempo-crossfade.js','tempo-wasm.js','tempo-dependency.js'])"
], cwd=ROOT, text=True, encoding='utf-8')

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio', '--autoplay-policy=no-user-gesture-required'])
    results = []
    for scenario in [{'shift':0,'rate':1,'preserve':False}, {'shift':12,'rate':1,'preserve':False}, {'shift':0,'rate':.5,'preserve':True}]:
        page = browser.new_page()
        page.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        page.goto('https://soundcloud.com/test-artist/first-track')
        page.add_script_tag(content=modules)
        result = page.evaluate('''async ({shift,rate:nextRate,preserve}) => {
          const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
          const context = new AudioContext({sampleRate:48000});
          await context.resume();
          const analyser = context.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
          const energy = context.createAnalyser(); energy.fftSize=1024; analyser.connect(energy);
          const silent = context.createGain(); silent.gain.value = 0;
          analyser.connect(silent).connect(context.destination);
          function wav(frequency) {
            const frames = 48000 * 12, bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
            const text = (at, value) => [...value].forEach((letter,i)=>view.setUint8(at+i, letter.charCodeAt(0)));
            text(0,'RIFF'); view.setUint32(4,36+frames*2,true); text(8,'WAVE'); text(12,'fmt ');
            view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
            view.setUint32(24,48000,true); view.setUint32(28,96000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
            text(36,'data'); view.setUint32(40,frames*2,true);
            for(let i=0;i<frames;i++) view.setInt16(44+i*2, Math.sin(2*Math.PI*frequency*i/48000)*.08*32767,true);
            return URL.createObjectURL(new Blob([bytes], {type:'audio/wav'}));
          }
          const urls = [wav(440), wav(880)];
          let audio = new Audio(urls[0]); audio.volume = .5;
          const outgoing = audio;
          const nextAudio = new Audio(); nextAudio.preload = 'auto'; nextAudio.volume = .5;
          document.body.append(audio);
          let graph;
          const refresh = () => {
            audio.playbackRate=audio===outgoing?1:nextRate; audio.preservesPitch=false;
            graph?.sync(audio, shift !== 0 || preserve, audio.playbackRate);
          };
          graph = createWasmAudio({
            audioModules: {}, createStretchNode, preservesKey:()=>preserve, readKeyShift:()=>shift,
            readUseWasm:()=>true, references:new Set([new WeakRef(audio)]),
            apply:refresh, updateAll:refresh, discover:()=>{}, onGraphReady:()=>{},
            outputLevel:{subscribeLevel(target, callback){callback({volume:.5,muted:false,outputDb:0});return ()=>{};}},
          });
          context.createMediaElementSource(audio).connect(analyser);
          audio.addEventListener('playing', refresh);
          await audio.play(); audio.currentTime = 7.5;
          await new Promise(resolve => audio.addEventListener('seeked',resolve,{once:true}));
          refresh();
          for(let i=0; (shift||preserve) && !graph.active(audio) && i<100; i++) await wait(30);
          if((shift||preserve) && !graph.active(audio)) throw new Error('Pitch processor not ready');
          let track = 'first', clicks = 0, requestedAt = null, clickedAt = null, readyAtClick = false, nativeStarted = false;
          const values = new Map();
          const crossfade = createCrossfade({graph, readSettings:()=>({rate:audio===outgoing?1:nextRate,preserve,shift,variable:false}),
            readNextRate:()=>nextRate,
            readNextSettings:()=>({rate:nextRate,preserve,shift,variable:false}),
            readTrack:()=>track, sourceFor:()=>({status:'bound',sourceId:track,playlistUrl:'https://a.sndcdn.com/test.m3u8'}),
            preloadNext:async()=>{
              if (track !== 'first') throw new Error('End of queue');
              requestedAt = performance.now();
              // Simulate a slow initial network load. No queue advance may happen during it.
              await wait(1200);
              nextAudio.src=urls[1]; nextAudio.load();
              return {
                matches:()=>track==='first',
                streamUrl:()=> 'https://a.sndcdn.com/next.m3u8',
                ready:seconds=>nextAudio.buffered.length>0 && nextAudio.buffered.start(0)<=.05 && nextAudio.buffered.end(0)>=seconds,
                isCurrent:target=>track==='second'&&target===nextAudio,
                dispose(){},
              };
            },
            nextButton:()=>({click(){
              clicks++; clickedAt=performance.now(); readyAtClick=nextAudio.readyState>=3;
              track='second'; outgoing.pause(); audio=nextAudio; document.body.append(audio);
              context.createMediaElementSource(audio).connect(analyser);
              crossfade.select(audio); audio.addEventListener('playing',refresh);
              setTimeout(()=>{nativeStarted=true; audio.play();},1200);
            }}),
            storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},
            modules:{loadAudioDependencies:async()=>({}),createPcmSource:options=>options,createPcmWindow:({source})=>({
              info:async()=>({durationHint:12,sampleRate:48000}),
              acquire:async(from,to)=>{const hz=source.url.includes('next')?880:440; const plane=Float32Array.from({length:to-from},(_,i)=>.08*Math.sin(2*Math.PI*hz*(from+i)/48000));return {channels:[plane,plane],release(){}};},
              dispose:async()=>{},
            })},
          });
          crossfade.select(audio); crossfade.set(true,2);
          const spectrum = new Float32Array(analyser.frequencyBinCount);
          function measure() {
            analyser.getFloatFrequencyData(spectrum);
            const peak = hz => { const bin=Math.round(hz*analyser.fftSize/context.sampleRate); return Math.max(...spectrum.slice(bin-2,bin+3)); };
            return {old:peak(440*2**(shift/12)),next:peak(880*2**(shift/12))};
          }
          const readings=[];
          const levels=[], samples=new Float32Array(energy.fftSize);
          for(let i=0;i<900;i++) {
            await wait(10);
            if(clicks && performance.now()-clickedAt>150) {
              energy.getFloatTimeDomainData(samples);
              levels.push(Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length));
            }
            if(i%10===0) readings.push({clicks,nativeStarted,stage:crossfade.diagnostics().stage,...measure()});
          }
          const simultaneous=readings.some(row=>row.clicks===1&&row.old>-58&&row.next>-58);
          const final=readings.at(-1);
          crossfade.dispose(); audio.pause(); await context.close(); urls.forEach(URL.revokeObjectURL);
          return {shift,nextRate,preserve,clicks,simultaneous,final,readings,readyAtClick,minimumRms:Math.min(...levels),preloadLeadMs:clickedAt-requestedAt,diagnostics:crossfade.diagnostics()};
        }''', scenario)
        assert result['clicks'] == 1 and result['simultaneous'], result
        assert result['readyAtClick'] and result['preloadLeadMs'] >= 1200, result
        assert any(row['clicks'] == 1 and not row['nativeStarted'] and row['next'] > -58 for row in result['readings']), result
        assert any(row['stage'] == 'handing-off' for row in result['readings']) or any(entry['message'] == 'Crossfade complete.' for entry in result['diagnostics']['history']), result
        assert result['final']['old'] < -65 and result['final']['next'] > -50, result
        assert result['minimumRms'] > .004, result
        results.append({key:value for key,value in result.items() if key != 'readings'})
        page.close()
    context = browser.new_context()
    context.add_init_script(userscript_source())
    context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
    page = context.new_page()
    page.goto('https://soundcloud.com/test-artist/first-track')
    page.locator('.settings-button').click(); page.locator('.advanced-audio > summary').click()
    expect(page.locator('#crossfade')).not_to_be_checked()
    expect(page.locator('#crossfade-seconds')).to_be_disabled()
    page.locator('#crossfade').check()
    page.locator('#crossfade-seconds').fill('8')
    page.locator('#crossfade-seconds').dispatch_event('change')
    page.locator('.crossfade-debug > summary').focus()
    page.keyboard.press('Enter')
    expect(page.locator('#crossfade-debug-output')).to_contain_text('overlapSeconds')
    page.evaluate('''() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
      writeText:async text=>{window.copiedCrossfadeReport=text;}
    }})''')
    page.locator('#crossfade-debug-copy').click()
    report = json.loads(page.evaluate('window.copiedCrossfadeReport'))
    assert report['overlapSeconds'] == 8 and report['enabled']
    assert 'https://' not in json.dumps(report) and 'blob:' not in json.dumps(report)
    expect(page.locator('#crossfade-debug-feedback')).to_contain_text('Diagnostics copied')
    for width in [1440, 390]:
        page.set_viewport_size({'width':width,'height':900})
        panel = page.locator('.settings')
        assert panel.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
        page.locator('.advanced-audio').screenshot(path=str(ROOT/f'test-results/crossfade-settings-{width}.png'))
    page.evaluate('''() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
      writeText:async()=>{throw new Error('Permission denied');}
    }})''')
    page.locator('#crossfade-debug-copy').click()
    expect(page.locator('#crossfade-debug-feedback')).to_contain_text('Could not copy')
    page.evaluate('''async () => {
      const frames=8000*30, bytes=new ArrayBuffer(44+frames*2), v=new DataView(bytes);
      const text=(at,s)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
      text(0,'RIFF'); v.setUint32(4,36+frames*2,true); text(8,'WAVE'); text(12,'fmt ');
      v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
      v.setUint32(24,8000,true); v.setUint32(28,16000,true); v.setUint16(32,2,true); v.setUint16(34,16,true);
      text(36,'data'); v.setUint32(40,frames*2,true);
      const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
      const active=new Audio(url), queued=new Audio(url), ctx=new AudioContext();
      active.volume=0; queued.volume=0;
      document.body.append(active,queued);
      ctx.createMediaElementSource(active).connect(ctx.destination);
      await ctx.resume(); await active.play();
      ctx.createMediaElementSource(queued).connect(ctx.destination);
      window.preloadSelectionCleanup=async()=>{active.pause(); queued.pause(); await ctx.close(); URL.revokeObjectURL(url);};
    }''')
    page.locator('#crossfade-debug-refresh').click()
    selection = json.loads(page.locator('#crossfade-debug-output').inner_text())
    assert selection['player']['paused'] is False, 'Silent preload stole the active-player selection'
    page.evaluate('preloadSelectionCleanup()')
    page.locator('.close-settings').click()
    page.evaluate('''() => {
      window.badgeFades=[];
      const animate=Element.prototype.animate;
      Element.prototype.animate=function(frames,options){
        if(this.matches('.playbackSoundBadge__avatar,.playbackSoundBadge__titleContextContainer'))
          window.badgeFades.push({target:this.className,frames,options});
        return animate.call(this,frames,options);
      };
    }''')
    for index, width in enumerate([1440, 390]):
        page.set_viewport_size({'width':width,'height':900})
        page.evaluate('''index=>{
          const link=document.querySelector('.playbackSoundBadge__titleLink');
          link.href='/test-artist/transition-'+index;
          link.textContent='The next track';
        }''', index)
        page.wait_for_function('(count)=>window.badgeFades.length===count', arg=(index+1)*2)
        page.locator('.playControls').screenshot(path=str(ROOT/f'test-results/track-fade-{width}.png'))
    fades = page.evaluate('window.badgeFades')
    assert all(fade['options']['duration'] == 240 for fade in fades), fades
    assert fades[0]['frames'] == fades[1]['frames']
    page.emulate_media(reduced_motion='reduce')
    page.evaluate("document.querySelector('.playbackSoundBadge__titleLink').href='/test-artist/reduced-motion'")
    page.wait_for_timeout(300)
    assert page.evaluate('window.badgeFades.length') == 4
    assert page.locator('.playbackSoundBadge__avatar').evaluate('el=>getComputedStyle(el).opacity') == '1'
    page.reload(); page.locator('.settings-button').click(); page.locator('.advanced-audio > summary').click()
    expect(page.locator('#crossfade')).to_be_checked()
    expect(page.locator('#crossfade-seconds')).to_have_value('8')
    page.locator('#crossfade').uncheck()
    browser.close()
    print(json.dumps({'crossfade_audio':results,'settings':'passed','diagnostics':'copy and denied-copy passed','preload_selection':'silent player does not steal selection','badge_motion':'paired fade and reduced motion passed'}))
