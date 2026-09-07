import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
TRACK = '.playbackSoundBadge__titleLink'


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            context = browser.new_context(viewport={'width': 1050, 'height': 540})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script('''window.randomDraws=0; window.randomWord=0;
                Crypto.prototype.getRandomValues=function(a){randomDraws++;a[0]=randomWord;return a;};''')
            page.add_init_script(script=userscript_source())
            url = f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html'
            page.goto(url)
            number = page.locator('#rate-number')
            slider = page.locator('#rate-slider')
            memory = page.locator('.memory')
            menu = page.locator('#tempo-settings')
            toggle = page.locator('#random-saved')
            up = page.locator('.step-up')
            up.click()
            expect(page.locator('.status')).to_have_text('Playback speed 1.025×.')
            slider.press('Home')
            expect(page.locator('.status')).to_have_text('Playback speed 0.025×.')
            slider.dblclick()
            expect(page.locator('.status')).to_have_text('Playback speed 1.00×.')

            def rate(value):
                number.fill(str(value))
                number.press('Enter')

            def track(path):
                page.locator(TRACK).evaluate('(el, path) => el.setAttribute("href", path)', path)

            def draws():
                return page.evaluate('randomDraws')

            expect(menu).to_be_hidden()
            gear = page.locator('.settings-button')
            gear.click()
            expect(menu).to_be_visible()
            toggle.press('Escape')
            expect(gear).to_be_focused()
            memory.click(button='right')
            expect(menu).to_be_visible()
            expect(toggle).not_to_be_checked()
            expect(toggle).to_be_focused()
            toggle.press('Escape')
            expect(menu).to_be_hidden()
            expect(memory).to_be_focused()
            memory.press('Shift+F10')
            expect(menu).to_be_visible()
            page.locator('#other-input').click()
            expect(menu).to_be_hidden()
            rate(.85)
            memory.click()
            expect(memory).to_have_attribute('data-feedback', 'saved')
            page.wait_for_timeout(1100)
            assert memory.get_attribute('data-feedback') is None
            memory.click(button='right')
            toggle.check()
            expect(number).to_have_value('0.85')
            assert draws() == 0
            toggle.press('Escape')
            track('/other/unsaved'); expect(number).to_have_value('1')
            assert draws() == 0
            track('/test-artist/first-track'); expect(number).to_have_value('0.85')
            assert draws() == 1
            page.wait_for_timeout(1700)
            track(''); track('/test-artist/first-track')
            page.wait_for_timeout(100)
            assert draws() == 1
            track('/other/unsaved'); expect(number).to_have_value('1')
            page.evaluate('randomWord=4294967295')
            track('/test-artist/first-track'); expect(number).to_have_value('1')
            assert draws() == 2
            assert page.evaluate('localStorage.getItem("soundcloud.tempo.track.%2Ftest-artist%2Ffirst-track")') == '0.85'
            rate(.93)
            page.wait_for_timeout(1700)
            expect(number).to_have_value('0.93')
            assert draws() == 2
            memory.click(button='right')
            toggle.uncheck()
            expect(number).to_have_value('0.93')
            toggle.press('Escape')
            track('/other/unsaved'); expect(number).to_have_value('1')
            track('/test-artist/first-track'); expect(number).to_have_value('0.85')
            assert draws() == 2

            memory.click(button='right')
            saved = page.locator('.saved-row input[type=number]')
            saved.fill('0.72'); saved.press('Enter')
            expect(number).to_have_value('0.85')
            expect(page.locator('.settings-status')).to_contain_text('updated')
            page.locator('#saved-filter').fill('nomatch')
            expect(page.locator('.saved-row')).to_have_count(0)
            page.locator('#saved-filter').fill('test-artist')
            expect(page.locator('.saved-row')).to_have_count(1)
            toggle.check()
            page.goto(url)
            expect(number).to_have_value('0.72')
            memory.click(button='right')
            expect(toggle).to_be_checked()
            page.locator('.saved-row button').click()
            expect(number).to_have_value('0.72')
            expect(page.locator('.saved-row')).to_have_count(0)
            expect(page.locator('#saved-filter')).to_be_focused()
            toggle.uncheck()
            page.evaluate('() => {window.originalSet=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new Error("blocked")};}')
            toggle.click()
            expect(toggle).not_to_be_checked()
            expect(page.locator('.settings-status')).to_contain_text('Could not save')
            page.evaluate('() => {Storage.prototype.setItem=originalSet;}')
            second = context.new_page()
            second.goto(url)
            second.evaluate('localStorage.setItem("soundcloud.tempo.randomSaved", "true")')
            expect(toggle).to_be_checked()
            expect(number).to_have_value('0.72')
            second.evaluate('localStorage.removeItem("soundcloud.tempo.randomSaved")')
            expect(toggle).not_to_be_checked()
            second.close()
            toggle.press('Escape')

            rate(.5)
            box = up.bounding_box()
            page.mouse.move(box['x']+12, box['y']+8)
            page.mouse.down()
            page.wait_for_timeout(650)
            page.mouse.up()
            held = float(number.input_value())
            assert .55 <= held <= .65, held
            page.wait_for_timeout(300)
            expect(number).to_have_value(str(held))
            rate(.5)
            page.mouse.down()
            page.wait_for_timeout(100)
            track('/other/next'); expect(number).to_have_value('1')
            page.wait_for_timeout(600)
            page.mouse.up()
            expect(number).to_have_value('1')
            rate(.9)
            number.dblclick()
            expect(number).to_have_value('1')
            rate(.5)
            box = slider.bounding_box()
            page.keyboard.down('Shift')
            page.mouse.move(box['x']+6+(box['width']-12)/7, box['y']+16)
            page.mouse.down()
            expect(slider).to_have_attribute('step', '0.025')
            target = .825
            fraction = (target - float(slider.get_attribute('min'))) / (float(slider.get_attribute('max')) - float(slider.get_attribute('min')))
            page.mouse.move(box['x']+6+(box['width']-12)*fraction, box['y']+16)
            precise = float(number.input_value())
            assert precise == target, precise
            page.mouse.up()
            page.keyboard.up('Shift')
            expect(slider).to_have_attribute('step', '0.025')
            assert float(number.input_value()) == precise
            page.wait_for_timeout(1600)
            assert float(number.input_value()) == precise
            expect(page.locator('.ticks path')).to_have_count(2)

            page.locator('main').evaluate('''el => {
                const grid = document.createElement('div');
                grid.id='test-covers';
                grid.style.cssText='display:flex;gap:16px;margin-top:24px';
                grid.innerHTML = `<a href="/demo/slow-track"><span class="image" style="display:block;width:120px;height:120px;background:#575b68"></span></a>
                  <a href="/demo/faster-track"><span class="image" style="display:block;width:120px;height:120px;background:#626757"></span></a>
                  <a href="/demo/slow-track"><span class="image" style="display:block;width:120px;height:120px;background:#575b68"></span></a>
                  <a href="/demo/sets/playlist"><span class="image" style="display:block;width:120px;height:120px;background:#666"></span></a>`;
                el.append(grid);
            }''')

            for path, value in [('/demo/slow-track', .75), ('/demo/faster-track', 1.25), ('/demo/fine-tempo', .93)]:
                track(path)
                rate(value)
                memory.click()
            badges = page.locator('#test-covers .soundcloud-tempo-page-indicator')
            expect(badges).to_have_count(3)
            expect(badges.nth(0)).to_have_attribute('data-active', 'false')
            track('/demo/slow-track'); expect(number).to_have_value('0.75')
            expect(badges.nth(0)).to_have_attribute('data-active', 'true')
            expect(badges.nth(2)).to_have_attribute('data-active', 'true')
            rate(1)
            expect(badges.nth(0)).to_have_attribute('data-active', 'false')
            expect(badges.nth(0)).to_have_attribute('title', 'Saved tempo 0.75×')
            memory.click(modifiers=['Shift'])
            expect(badges.nth(0)).to_be_hidden()
            expect(badges.nth(2)).to_be_hidden()
            rate(.9)
            expect(badges.nth(0)).to_be_visible()
            expect(badges.nth(0)).to_have_attribute('data-active', 'true')
            memory.click()
            page.locator('#test-covers').evaluate('el => el.append(el.firstElementChild.cloneNode(true))')
            expect(badges).to_have_count(4)
            expect(badges.nth(3)).to_have_attribute('data-active', 'true')
            page.locator('#test-covers > a').last.evaluate('el => el.href="/demo/unknown"')
            expect(badges).to_have_count(3)
            page.locator('#test-covers > a').first.evaluate('''el => {
                window.coverClicks=0;
                el.addEventListener('click',e=>{e.preventDefault();coverClicks++});
            }''')
            badges.nth(0).click()
            assert page.evaluate('coverClicks') == 1
            page.locator('main').evaluate('''el => {
                const queue=document.createElement('div');
                queue.className='queueItemView';
                queue.innerHTML='<div class="queueItemView__artwork"><div class="image" style="width:32px;height:32px;background:#666"></div></div><a class="queueItemView__title" href="/demo/slow-track">Queue item</a>';
                el.append(queue);
            }''')
            queue_badge = page.locator('.queueItemView .soundcloud-tempo-page-indicator')
            expect(queue_badge).to_be_visible()
            expect(queue_badge).to_have_attribute('data-small', 'true')
            for width, theme in [(1050, 'dark'), (768, 'dark'), (1050, 'light')]:
                page.set_viewport_size({'width': width, 'height': 540})
                page.evaluate('(light) => {document.body.classList.toggle("light", light); window.dispatchEvent(new Event("resize"));}', theme=='light')
                page.locator('.playControls').evaluate('el => {el.style.transform="translateY(0)";el.style.overflow="hidden";}')
                memory.click(button='right')
                assert menu.evaluate('el => el.matches(":popover-open")')
                bounds = menu.bounding_box()
                assert bounds['x'] >= 0 and bounds['x']+bounds['width'] <= width
                assert bounds['y'] >= 0 and bounds['y']+bounds['height'] <= 540
                page.screenshot(path=str(ROOT/f'test-results/settings-{width}-{theme}.png'))
                toggle.press('Escape')
            page.screenshot(path=str(ROOT/'test-results/page-artwork.png'))
            assert not errors, errors
            print(json.dumps({'settings_random_branches_saved_management_repeat_fine_drag': 'passed', 'silent': True, 'errors': errors}))
            browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
