import base64
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options, text_contrast

ROOT = Path(__file__).resolve().parent.parent
TRACK = '/test-artist/first-track'
KEY = 'soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track'


def code(data):
    return 'SCT1.' + base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            page = browser.new_page(viewport={'width': 1050, 'height': 820})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script(script='if(navigator.clipboard)navigator.clipboard.writeText=async text=>{window.copied=text};\n'+userscript_source())
            url = f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html'
            page.goto(url)
            page.evaluate('''() => {
                window.clockTime=0; window.testAudio=new Audio(); testAudio.muted=true;
                testAudio.play().catch(()=>{});testAudio.pause();
                Object.defineProperty(testAudio,'currentTime',{get:()=>clockTime});
                Object.defineProperty(testAudio,'duration',{get:()=>200});
                document.body.append(testAudio);
            }''')
            page.locator('.settings-button').click()
            page.locator('.open-editor').click()
            panel = page.locator('.tempo-editor')
            expect(panel).to_be_visible()
            for theme in ['dark', 'light']:
                page.evaluate('(theme) => {document.body.classList.toggle("light", theme === "light"); dispatchEvent(new Event("resize"));}', theme)
                save = page.locator('.editor-save')
                assert text_contrast(save) >= 4.5, theme
                save.hover()
                assert text_contrast(save) >= 4.5, (theme, 'hover')
                assert save.evaluate('el => getComputedStyle(el).color') == 'rgb(255, 85, 0)'
                page.locator('.point-rate').hover()
            page.evaluate('document.body.classList.remove("light"); dispatchEvent(new Event("resize"));')
            page.locator('.point-add').click()
            page.locator('.point-time').fill('20'); page.locator('.point-time').press('Tab')
            page.locator('.point-rate').fill('0.5'); page.locator('.point-rate').press('Tab')
            page.locator('.point-duration').fill('10'); page.locator('.point-duration').press('Tab')
            page.locator('.editor-save').click()
            data = page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', KEY)
            assert data['data']['points'][1] == {'t': 20, 'r': .5, 'd': 10, 'c': 'linear'}, data

            def seek(t, expected):
                page.evaluate('(t)=>{clockTime=t;testAudio.dispatchEvent(new Event("seeking"));}', t)
                expect(page.locator('#rate-number')).to_have_value(str(expected))
                assert abs(page.evaluate('testAudio.playbackRate')-expected) < .001
                assert page.evaluate('testAudio.preservesPitch') is False

            seek(0, 1); seek(10, 1); seek(15, .75); seek(20, .5); seek(100, .5); seek(5, 1)
            for curve, expected in [('ease-in', .969), ('ease-out', .781), ('smooth', .922), ('instant', 1)]:
                page.locator('.point-curve').select_option(curve)
                page.locator('.editor-save').click()
                seek(12.5, expected)
            page.locator('.point-curve').select_option('linear'); page.locator('.editor-save').click()
            page.locator('.tempo-editor summary').click()
            page.locator('.editor-copy').click()
            exported = page.evaluate('copied')
            assert exported.startswith('SCT1.')
            page.locator('.editor-code').fill('SCT1.bad')
            page.locator('.editor-preview').click()
            expect(page.locator('.editor-import')).to_be_disabled()
            expect(page.locator('.editor-status')).to_contain_text('Cannot import')
            for invalid in [
                {'v': 1, 'track': 'https://evil.example/a/b', 'duration': 200, 'points': [{'t':0,'r':1,'d':0,'c':'instant'}]},
                {'v': 1, 'track': TRACK, 'duration': 200, 'points': [{'t':0,'r':1,'d':0,'c':'instant'},{'t':10,'r':.5,'d':11,'c':'linear'}]},
            ]:
                page.locator('.editor-code').fill(code(invalid)); page.locator('.editor-preview').click()
                expect(page.locator('.editor-import')).to_be_disabled()
            before = page.evaluate('(key)=>localStorage.getItem(key)', KEY)
            page.locator('.editor-code').fill(exported); page.locator('.editor-preview').click()
            expect(page.locator('.editor-import')).to_be_enabled()
            assert page.evaluate('(key)=>localStorage.getItem(key)', KEY) == before
            page.locator('.editor-close').click()
            expect(page.locator('.settings-button')).to_be_focused()
            page.locator('.settings-button').click(); page.locator('.open-editor').click()
            expect(page.locator('.editor-import')).to_be_disabled()
            page.locator('.editor-graph circle').nth(1).focus(); page.locator('.editor-graph circle').nth(1).press('Enter')
            expect(page.locator('.point-time')).to_be_focused()
            page.locator('.editor-preview').click()
            expect(page.locator('.editor-import')).to_be_enabled()
            page.locator('.editor-import').click()
            page.locator('.editor-revert').click()
            expect(page.locator('.editor-import')).to_be_disabled()
            page.locator('.editor-graph circle').nth(1).focus(); page.locator('.editor-graph circle').nth(1).press('Enter')
            expect(page.locator('.point-time')).to_be_focused()
            page.locator('.editor-preview').click()
            page.locator('.editor-import').click()
            assert page.evaluate('(key)=>localStorage.getItem(key)', KEY) == before
            page.evaluate('() => {window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error("Storage blocked")};}')
            page.locator('.editor-save').click()
            expect(page.locator('.editor-status')).to_contain_text('Not saved')
            page.evaluate('() => {Storage.prototype.setItem=window.originalSet;}')
            graph = page.locator('.editor-graph')
            b = graph.bounding_box()
            graph.dblclick(position={'x': b['width']*.6, 'y': b['height']*.55})
            assert page.locator('.editor-graph circle').count() == 3
            point = page.locator('.editor-graph circle').nth(2).bounding_box()
            page.mouse.move(point['x']+point['width']/2, point['y']+point['height']/2)
            page.mouse.down(); page.mouse.move(point['x']-30, point['y']-15); page.mouse.up()
            assert 'Unsaved' in page.locator('.editor-status').inner_text()
            page.locator('.editor-save').click()
            page.locator('.editor-enabled').uncheck(); seek(15, 1)
            page.locator('.editor-enabled').check(); seek(15, .75)
            page.locator('.editor-close').click()
            page.locator('#rate-number').fill('0.9'); page.locator('#rate-number').press('Enter')
            seek(16, .9)
            page.locator('#other-input').focus()
            page.locator('.playbackSoundBadge__titleLink').evaluate("el=>el.href='https://soundcloud.com/other/track'")
            expect(page.locator('#rate-number')).to_have_value('1')
            page.locator('.playbackSoundBadge__titleLink').evaluate("el=>el.href='https://soundcloud.com/test-artist/first-track'")
            seek(15, .75)
            page.locator('.settings-button').click(); page.locator('.open-editor').click()
            page.locator('.editor-graph circle').nth(1).focus()
            page.locator('.editor-graph circle').nth(1).press('Enter')
            expect(page.locator('.point-time')).to_be_focused()
            for width, theme in [(1050,'dark'),(768,'dark'),(1050,'light')]:
                page.set_viewport_size({'width':width,'height':820})
                page.evaluate('(theme)=>{document.body.classList.toggle("light",theme==="light");dispatchEvent(new Event("resize"));}',theme)
                box=panel.bounding_box()
                assert box['x']>=0 and box['x']+box['width']<=width and box['y']>=0
                assert panel.evaluate('el=>el.scrollWidth<=el.clientWidth')
                panel.screenshot(path=str(ROOT/f'test-results/timeline-{width}-{theme}.png'))
            page.locator('.editor-close').press('Escape'); expect(panel).to_be_hidden()
            expect(page.locator('.settings-button')).to_be_focused()
            page.reload()
            page.evaluate('''() => {window.clockTime=15;window.testAudio=new Audio();testAudio.muted=true;testAudio.play().catch(()=>{});testAudio.pause();Object.defineProperty(testAudio,'currentTime',{get:()=>clockTime});document.body.append(testAudio);}''')
            expect(page.locator('#rate-number')).to_have_value('0.75')
            assert not errors, errors
            browser.close()
            print(json.dumps({'timeline_editor_curves_seeking_codes_dragging_toggle_manual_override':'passed','silent':True,'errors':errors}))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
