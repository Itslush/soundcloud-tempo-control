import json
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

from userscript_fixture import userscript_source, browser_options, userscript_bytes

ROOT = Path(__file__).resolve().parent.parent


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            page = browser.new_page()
            page.add_init_script('''
                window.overhead = {intervalTicks:0, documentScans:0, frames:0};
                const interval = window.setInterval;
                window.setInterval = (callback, delay, ...args) => interval(() => {overhead.intervalTicks++;callback(...args)}, delay);
                const scan = Document.prototype.querySelectorAll;
                Document.prototype.querySelectorAll = function(...args) {overhead.documentScans++;return scan.apply(this,args)};
                const frame = window.requestAnimationFrame;
                window.requestAnimationFrame = callback => frame(time => {overhead.frames++;callback(time)});
            ''')
            page.add_init_script(script=userscript_source())
            page.goto(f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html')
            page.wait_for_timeout(700)
            page.evaluate('Object.keys(overhead).forEach(key => overhead[key]=0)')
            page.wait_for_timeout(3200)
            idle = page.evaluate('({...overhead})')
            page.evaluate('''() => {
                const clock=document.createElement('div');clock.id='unrelated-clock';document.body.append(clock);
            }''')
            page.wait_for_timeout(100)
            page.evaluate('Object.keys(overhead).forEach(key => overhead[key]=0)')
            for n in range(20):
                page.evaluate('(n)=>document.getElementById("unrelated-clock").textContent=String(n)', n)
                page.wait_for_timeout(20)
            page.wait_for_timeout(100)
            churn = page.evaluate('({...overhead})')
            page.evaluate('''() => {
                window.schedulerTicks=0;
                const timeout=window.setTimeout;
                window.setTimeout=(fn,delay,...args)=>timeout(()=>{if(delay===50)schedulerTicks++;fn(...args)},delay);
                window.clockPaused=true;window.clockStart=performance.now();
                window.clockAudio=new Audio();clockAudio.muted=true;
                clockAudio.play().catch(() => {});clockAudio.pause();
                Object.defineProperty(clockAudio,'paused',{get:()=>clockPaused});
                Object.defineProperty(clockAudio,'duration',{get:()=>200});
                Object.defineProperty(clockAudio,'currentTime',{get:()=>(performance.now()-clockStart)/1000});
                document.body.append(clockAudio);
                const key='soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track';
                localStorage.setItem(key,JSON.stringify({enabled:true,data:{v:1,track:'/test-artist/first-track',duration:200,points:[{t:0,r:1,d:0,c:'instant'},{t:2,r:.5,d:2,c:'linear'}]}}));
                window.dispatchEvent(new StorageEvent('storage',{key}));
            }''')
            page.wait_for_timeout(100)
            page.evaluate('clockPaused=false;clockStart=performance.now();clockAudio.dispatchEvent(new Event("playing"))')
            page.wait_for_timeout(350)
            running = page.evaluate('({ticks:schedulerTicks,rate:clockAudio.playbackRate})')
            assert running['ticks']>=2 and .7<running['rate']<1,running
            page.evaluate('clockPaused=true;clockAudio.dispatchEvent(new Event("pause"));schedulerTicks=0')
            page.wait_for_timeout(180)
            assert page.evaluate('schedulerTicks')==0
            page.evaluate('clockPaused=false;clockAudio.dispatchEvent(new Event("playing"))')
            page.wait_for_timeout(120)
            assert page.evaluate('schedulerTicks')>0
            page.locator('#rate-number').fill('0.85')
            page.locator('#rate-number').press('Enter')
            page.evaluate('schedulerTicks=0')
            page.wait_for_timeout(180)
            assert page.evaluate('schedulerTicks')==0
            result = {'idle_3_2s':idle,'unrelated_text_updates_20':churn,'script_bytes':len(userscript_bytes()),'scope':'muted local fixture; counts, not CPU or total heap'}
            result['scheduler']='continuous fade, pause, resume and manual override passed with synthetic media clock'
            (ROOT/f'test-results/overhead-{sys.argv[1] if len(sys.argv)>1 else "current"}.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
            print(json.dumps(result,indent=2))
            if '--assert' in sys.argv:
                assert idle == {'intervalTicks':0,'documentScans':0,'frames':0},idle
                assert churn['documentScans']==0 and churn['frames']==0,churn
            browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
