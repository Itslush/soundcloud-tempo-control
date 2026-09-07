import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            page = browser.new_page(viewport={'width':1050,'height':700})
            errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.add_init_script(script=userscript_source())
            page.goto(f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html')
            page.evaluate('() => {window.a=new Audio();a.muted=true;a.play().catch(()=>{});a.pause();document.body.append(a);}')
            page.locator('.settings-button').click()
            page.locator('.advanced-audio summary').click()
            toggle=page.locator('#preserve-key')
            expect(toggle).not_to_be_checked()
            toggle.check()
            assert page.evaluate('a.preservesPitch') is True
            page.evaluate('() => {a.preservesPitch=false;}')
            assert page.evaluate('a.preservesPitch') is True
            page.locator('.close-settings').click()
            page.locator('#rate-number').fill('0.75'); page.locator('#rate-number').press('Enter')
            assert page.evaluate('a.playbackRate')==.75 and page.evaluate('a.preservesPitch')
            expect(page.locator('#rate-number')).to_have_attribute('title', 'Exact tempo · double-click to reset')
            page.reload()
            page.locator('.settings-button').click();page.locator('.advanced-audio summary').click()
            expect(toggle).to_be_checked()
            page.evaluate('() => {window.a=new Audio();a.muted=true;a.play().catch(()=>{});a.pause();document.body.append(a);}')
            toggle.uncheck(); assert page.evaluate('a.preservesPitch') is False
            page.evaluate('() => {window.oldSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error("blocked")};}')
            toggle.click();expect(toggle).not_to_be_checked()
            expect(page.locator('.settings-status')).to_contain_text('Could not save')
            page.evaluate('() => {Storage.prototype.setItem=oldSet;}')
            for width,theme in [(1050,'dark'),(768,'dark'),(1050,'light')]:
                page.set_viewport_size({'width':width,'height':700})
                page.evaluate('(theme)=>{document.body.classList.toggle("light",theme==="light");dispatchEvent(new Event("resize"));}',theme)
                box=page.locator('#tempo-settings').bounding_box()
                assert abs(box['x']+box['width']/2-width/2)<1
                assert abs(box['y']+box['height']/2-350)<1
                page.screenshot(path=str(ROOT/f'test-results/pitch-mode-{width}-{theme}.png'))
            assert not errors,errors
            browser.close()
            print(json.dumps({'preserve_key_switch_guard_reload_failure_centering':'passed','silent':True}))
    finally:
        server.shutdown()


if __name__=='__main__':main()
