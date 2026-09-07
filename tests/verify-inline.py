import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options, text_contrast

ROOT = Path(__file__).resolve().parent.parent
PREFIX = 'soundcloud.tempo.track.'
TRACK = '.playbackSoundBadge__titleLink'

def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            context = browser.new_context(viewport={'width': 1440, 'height': 540})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.add_init_script(script=userscript_source())
            url = f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html'
            page.goto(url)
            number = page.locator('#rate-number')
            slider = page.locator('#rate-slider')
            memory = page.locator('.memory')
            indicator = page.locator('#soundcloud-tempo-artwork-indicator')
            expect(number).to_have_value('1')
            expect(indicator).to_be_hidden()
            assert page.locator('.panel,.trigger').count() == 0
            page.evaluate('''() => { window.audio = new Audio(); audio.muted = true; audio.dispatchEvent(new Event('loadedmetadata')); audio.play().catch(() => {}); audio.pause(); }''')

            def set_rate(value):
                number.fill(str(value)); number.press('Enter')

            def select_track(path):
                page.locator(TRACK).evaluate('(el, href) => el.setAttribute("href", href)', path)

            def saved():
                return page.evaluate('prefix => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => [decodeURIComponent(k.slice(prefix.length)),localStorage.getItem(k)]))', PREFIX)

            set_rate(.85)
            expect(indicator).to_be_visible()
            expect(indicator).to_have_attribute('title', '0.85× · -2.81 st')
            expect(indicator).to_have_attribute('role', 'img')
            expect(indicator).to_have_attribute('aria-label', indicator.get_attribute('title'))
            assert page.locator('.playbackSoundBadge__avatar').get_attribute('href') == 'https://soundcloud.com/test-artist/first-track'
            page.locator('.playbackSoundBadge__avatar').evaluate('''el => {
                window.artworkClicks = 0;
                el.addEventListener('click', e => {e.preventDefault(); artworkClicks++;});
            }''')
            indicator.click()
            assert page.evaluate('artworkClicks') == 1
            assert page.evaluate('audio.playbackRate') == .85
            assert page.evaluate('audio.preservesPitch') is False
            assert saved() == {}
            memory.click()
            expect(memory).to_have_attribute('data-state', 'saved')
            assert saved() == {'/test-artist/first-track': '0.85'}
            select_track('/other-artist/first-track')
            expect(number).to_have_value('1')
            expect(indicator).to_be_hidden()
            assert page.evaluate('audio.playbackRate') == 1
            set_rate(.6); memory.click()
            select_track('https://m.soundcloud.com/test-artist/first-track/?in=test&secret_token=s-hidden#t=5')
            expect(number).to_have_value('0.85')
            assert page.evaluate('audio.playbackRate') == .85
            page.evaluate('history.pushState({}, "", "/other-artist/unrelated-page")')
            expect(number).to_have_value('0.85')
            set_rate(.75)
            expect(memory).to_have_attribute('data-state', 'modified')
            assert saved()['/test-artist/first-track'] == '0.85'
            memory.click()
            assert saved()['/test-artist/first-track'] == '0.75'
            select_track('/other-artist/first-track')
            expect(number).to_have_value('0.6')
            select_track('/test-artist/first-track/s-private-key')
            expect(number).to_have_value('0.75')
            assert len(saved()) == 2
            page.goto(url)
            expect(number).to_have_value('0.75')
            expect(indicator).to_be_visible()
            memory.click()
            assert '/test-artist/first-track' not in saved()
            expect(number).to_have_value('0.75')
            select_track('/other-artist/first-track'); expect(number).to_have_value('0.6')
            select_track('/test-artist/first-track'); expect(number).to_have_value('1')
            set_rate(.85); memory.click()
            slider.dblclick()
            expect(number).to_have_value('1')
            expect(indicator).to_be_hidden()
            assert saved()['/test-artist/first-track'] == '0.85'
            memory.click(modifiers=['Shift'])
            assert '/test-artist/first-track' not in saved()
            number.fill(''); number.press('Enter'); expect(number).to_have_value('1')
            set_rate(99); expect(number).to_have_value('4')
            set_rate(.01); expect(number).to_have_value('0.025')
            number.press('Alt+Shift+ArrowDown'); expect(number).to_have_value('1')
            slider.focus(); slider.press('ArrowLeft'); expect(number).to_have_value('0.975')
            slider.press('Alt+Shift+ArrowLeft'); expect(number).to_have_value('0.925')
            page.locator('#other-input').focus(); page.keyboard.press('Alt+Shift+ArrowLeft')
            expect(number).to_have_value('0.925')
            up = page.locator('.step-up')
            down = page.locator('.step-down')
            set_rate(.9)
            up.click(); expect(number).to_have_value('0.925')
            down.click(); expect(number).to_have_value('0.9')
            down.click(modifiers=['Shift']); expect(number).to_have_value('0.89')
            up.click(modifiers=['Shift']); expect(number).to_have_value('0.9')
            expect(slider).to_have_value('0.9')
            page.wait_for_timeout(1600); expect(number).to_have_value('0.9')
            set_rate(4); expect(up).to_be_disabled()
            set_rate(.025); expect(down).to_be_disabled()
            up.click(modifiers=['Shift']); expect(number).to_have_value('0.035')
            number.fill('0.8'); up.click(); expect(number).to_have_value('0.825')
            assert number.evaluate('el => getComputedStyle(el).textAlign') == 'right'
            expect(slider).to_have_attribute('step', '0.025')
            set_rate(.875); memory.click()
            assert saved()['/test-artist/first-track'] == '0.875'
            expect(indicator).to_have_attribute('title', '0.875× · -2.31 st')
            memory.click(modifiers=['Shift'])
            set_rate(.8)
            page.locator(TRACK).evaluate('(el) => el.replaceWith(el.cloneNode(true))')
            expect(number).to_have_value('0.8')
            number.fill('0.4')
            select_track('/other-artist/first-track')
            expect(number).to_have_value('0.6')
            number.press('Enter'); expect(number).to_have_value('0.6')
            page.locator('.playControls__elements').evaluate('(el) => el.replaceWith(el.cloneNode(true))')
            expect(number).to_have_count(1)
            expect(number).to_have_value('0.6')
            assert page.locator('#soundcloud-tempo-footer-style').count() == 1
            assert page.locator('#soundcloud-tempo-control').count() == 1
            expect(indicator).to_have_count(1)
            expect(indicator).to_be_visible()
            indicator.evaluate('el => el.remove()')
            expect(indicator).to_be_visible()
            page.locator('.playbackSoundBadge__avatar').evaluate('''el => {
                window.artworkCopy = el.cloneNode(true);
                el.remove();
            }''')
            expect(indicator).to_have_count(0)
            page.locator('.playbackSoundBadge').evaluate('el => el.prepend(window.artworkCopy)')
            expect(indicator).to_have_count(1)
            expect(indicator).to_be_visible()
            for href in ['', '/artist', '/artist/sets/playlist', 'https://example.com/a/b', '/artist/tracks']:
                select_track(href); expect(memory).to_be_enabled()
                expect(memory).to_have_attribute('aria-label', 'Settings')
                expect(indicator).to_be_hidden()
            select_track('/test-artist/first-track'); expect(number).to_have_value('1')
            page.evaluate('''() => {window.setItemBefore=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError')};}''')
            set_rate(.9); memory.click()
            expect(memory).to_have_attribute('data-state', 'error')
            assert '/test-artist/first-track' not in saved()
            page.evaluate('() => {Storage.prototype.setItem=window.setItemBefore;}')
            memory.click(); expect(memory).to_have_attribute('data-state', 'saved')
            second = context.new_page(); second.goto(url)
            second.evaluate('localStorage.setItem("soundcloud.tempo.track.%2Fthird-artist%2Ftrack", "0.7")')
            assert len(saved()) == 3
            second.evaluate('localStorage.removeItem("soundcloud.tempo.track.%2Ftest-artist%2Ffirst-track")')
            expect(memory).to_have_attribute('aria-pressed', 'false')
            expect(number).to_have_value('0.9')
            second.close()
            page.evaluate('localStorage.setItem("soundcloud.tempo.track.%2Fbad%2Ftrack", "Infinity")')
            select_track('/bad/track'); expect(number).to_have_value('1')
            select_track('/test-artist/first-track')
            expect(slider).to_have_attribute('max', '2')
            expect(number).to_have_attribute('max', '4')
            set_rate(3.25); memory.click()
            expect(indicator).to_have_attribute('title', '3.25× · +20.41 st')
            expect(slider).to_have_value('2')
            expect(number).to_have_value('3.25')
            assert slider.get_attribute('aria-valuetext').startswith('Slider limit 2.00×; current speed 3.25×')
            assert slider.evaluate('el => getComputedStyle(el).getPropertyValue("--range-fill")') == '100%'
            select_track('/other-artist/first-track'); expect(number).to_have_value('0.6')
            select_track('/test-artist/first-track'); expect(number).to_have_value('3.25')
            page.goto(url); expect(number).to_have_value('3.25')
            page.wait_for_timeout(1600)
            expect(number).to_have_value('3.25')
            slider.press('End'); expect(number).to_have_value('2')
            set_rate(3.25)
            box = slider.bounding_box()
            page.mouse.click(box['x'] + box['width'] - 6, box['y'] + box['height']/2)
            expect(number).to_have_value('2')
            slider.press('Home'); expect(number).to_have_value('0.025')
            slider.evaluate('''el => {
                window.rangeWrites = 0;
                const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                Object.defineProperty(el, 'value', {get(){return d.get.call(this)},set(v){rangeWrites++;d.set.call(this,v)},configurable:true});
            }''')
            box = slider.bounding_box()
            page.mouse.move(box['x'] + 6, box['y'] + box['height']/2)
            page.mouse.down()
            drag_rates = []
            for step in range(1, 13):
                page.mouse.move(box['x'] + 6 + (box['width'] - 12)*step/12, box['y'] + box['height']/2)
                drag_rates.append(float(number.input_value()))
                if step == 6:
                    page.wait_for_timeout(1600)
                    assert float(number.input_value()) == drag_rates[-1]
            page.mouse.up()
            expect(number).to_have_value('2')
            assert all(a <= b for a,b in zip(drag_rates, drag_rates[1:])), drag_rates
            assert len(set(drag_rates)) >= 10, drag_rates
            assert page.evaluate('rangeWrites') == 0
            slider.evaluate('el => {delete el.value;}')
            select_track('/test-artist/first-track'); set_rate(.85); memory.click()
            page.locator('#other-input').focus()
            sizes = []
            for width, theme in [(1440, 'dark'), (1050, 'dark'), (768, 'dark'), (1050, 'light')]:
                page.set_viewport_size({'width': width, 'height': 540})
                page.evaluate('(theme) => {document.body.classList.toggle("light", theme==="light");window.dispatchEvent(new Event("resize"));}', theme)
                metrics = page.locator('.playControls__elements').evaluate('''el => {
                    const nodes=[...el.children].filter(n=>n.getBoundingClientRect().width>0);
                    const bounds=nodes.map(n=>({name:n.id||n.className,x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width}));
                    const title=el.querySelector('.playbackSoundBadge__titleContextContainer');
                    return {bounds,clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,titleWidth:title.getBoundingClientRect().width};
                }''')
                assert metrics['scrollWidth'] <= metrics['clientWidth'], (width, metrics)
                for left,right in zip(metrics['bounds'],metrics['bounds'][1:]):
                    assert left['right'] <= right['x'] + 1, (width,left,right)
                assert metrics['titleWidth'] >= 24, (width, metrics)
                assert text_contrast(number) >= 4.5, (width, theme)
                number.hover()
                assert text_contrast(number) >= 4.5, (width, theme, 'hover')
                assert number.evaluate('el => getComputedStyle(el).color') == page.locator('.volume__button').evaluate('el => getComputedStyle(el).color')
                assert page.locator('.field').evaluate('el => getComputedStyle(el).backgroundColor') == 'rgba(0, 0, 0, 0)'
                assert page.locator('.unit').evaluate('el => getComputedStyle(el).color') == number.evaluate('el => getComputedStyle(el).color')
                page.locator('#other-input').hover()
                slider_box = slider.bounding_box()
                gear_box = page.locator('.settings-button').bounding_box()
                timeline_box = page.locator('.playbackTimeline__progressBackground').bounding_box()
                assert abs(slider_box['y'] + slider_box['height']/2 - (gear_box['y'] + gear_box['height']/2)) < .6
                assert abs(slider_box['y'] + slider_box['height']/2 - (timeline_box['y'] + timeline_box['height']/2)) < 1
                assert slider_box['width'] >= (68 if width <= 850 else 140)
                artwork_box = page.locator('.playbackSoundBadge__avatar').bounding_box()
                badge_box = indicator.bounding_box()
                assert badge_box['width'] == 18 and badge_box['height'] == 18
                assert artwork_box['x'] <= badge_box['x'] < badge_box['x'] + 18 <= artwork_box['x'] + artwork_box['width']
                assert artwork_box['y'] <= badge_box['y'] < badge_box['y'] + 18 <= artwork_box['y'] + artwork_box['height']
                path = ROOT/('test-results/tempo-controls.png' if width==1050 and theme=='dark' else f'test-results/inline-{width}-{theme}.png')
                page.locator('.playControls').screenshot(path=str(path))
                sizes.append({'width':width,'theme':theme,'title_width':round(metrics['titleWidth'],1)})
            assert not errors, errors
            print(json.dumps({'memory_keyboard_reload_errors_remount': 'passed', 'silent': True, 'layouts': sizes, 'errors':errors}, indent=2))
            browser.close()
    finally:
        server.shutdown()

if __name__ == '__main__':
    main()
