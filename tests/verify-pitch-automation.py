import base64
import json
import mimetypes
from pathlib import Path
from urllib.parse import urlparse, unquote
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import userscript_source, browser_options, text_contrast, choose_option

ROOT = Path(__file__).resolve().parent.parent

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        page = browser.new_page(viewport={'width': 1100, 'height': 950})
        page.route('https://soundcloud.com/**', lambda r: r.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        page.add_init_script(script=userscript_source())
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('https://soundcloud.com/test-artist/first-track')
        page.evaluate("()=>{window.audio=new Audio();audio.muted=true;Object.defineProperty(audio,'duration',{value:200});document.body.append(audio);}")
        quick = page.locator('#quick-key-shift')
        expect(quick).to_be_visible()
        quick.fill('0.25')
        quick.press('Tab')
        page.locator('.quick-key .tempo-number-arrows button').first.click()
        expect(quick).to_have_value('0.75')
        page.locator('.settings-button').click()
        page.locator('.appearance-settings summary').click()
        page.locator('#tempo-increment').fill('0.1')
        page.locator('#tempo-increment').press('Tab')
        page.locator('.open-editor').click()
        expect(page.locator('.speed-min')).to_have_value('0.75')
        expect(page.locator('.speed-max')).to_have_value('1.5')
        page.locator('[data-lane=pitch]').click()
        graph = page.locator('.editor-graph')
        b = graph.bounding_box()
        page.mouse.dblclick(b['x']+44+(b['width']-56)*.5, b['y']+60/220*b['height'])
        assert page.locator('.point').count() == 2
        assert float(page.locator('.point-rate').input_value()) >= -12
        node = page.locator('.point.selected').bounding_box()
        page.mouse.move(node['x']+7, node['y']+7)
        page.mouse.down()
        page.mouse.move(node['x']+12, node['y']+18, steps=4)
        page.mouse.up()
        assert -12 <= float(page.locator('.point-rate').input_value()) <= 12
        page.locator('.point-rate').fill('2.35')
        page.locator('.point-rate').press('Tab')
        page.locator('.point-time').fill('20')
        page.locator('.point-time').press('Tab')
        page.locator('.point-duration').fill('10')
        page.locator('.point-duration').press('Tab')
        page.locator('.editor-save').click()
        saved = page.evaluate("JSON.parse(localStorage.getItem('soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track')).data")
        assert saved['pitchPoints'][1]['k'] == 2.35, saved
        assert saved['points'][0]['r'] == 1
        assert text_contrast(page.locator('[data-lane=pitch]')) >= 4.5
        page.evaluate("()=>{audio.currentTime=15;audio.dispatchEvent(new Event('seeking'));}")
        expect(quick).to_have_value('1.55')
        page.locator('.pitch-step').fill('0.25')
        page.locator('.pitch-step').press('Tab')
        expect(quick).to_have_attribute('step', '0.25')
        # A manual override must not crash when a later pitch point is selected.
        quick.evaluate("el=>{el.value='-1.25';el.dispatchEvent(new Event('change',{bubbles:true}));}")
        expect(page.locator('.point-rate')).to_have_value('-1.25')
        assert page.locator('.point').count() == 1
        for width in [1100, 390]:
            page.set_viewport_size({'width': width, 'height': 950})
            assert page.locator('.tempo-editor').evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            page.locator('.tempo-editor').screenshot(path=str(ROOT/f'test-results/pitch-editor-{width}.png'))
        page.locator('.pitch-clear').click()
        expect(page.locator('[data-lane=tempo]')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('.point-rate')).to_have_value('1')
        page.locator('.point-rate').press('ArrowUp')
        expect(page.locator('.point-rate')).to_have_value('1.1')
        page.locator('.point-rate').press('ArrowDown')
        expect(page.locator('.point-rate')).to_have_value('1')
        page.locator('.editor-close').click()
        page.set_viewport_size({'width':1100,'height':950})
        page.locator('.settings-button').click()
        page.locator('.advanced-audio > summary').click()
        page.locator('.pitch-customization summary').click()
        for field, value in [('#pitch-min', '-6'), ('#pitch-max', '6'), ('#pitch-step', '0.125')]:
            page.locator(field).fill(value)
            page.locator(field).press('Tab')
        expect(quick).to_have_attribute('min', '-6')
        expect(quick).to_have_attribute('max', '6')
        expect(quick).to_have_attribute('step', '0.125')
        expect(page.locator('#pitch-source, #pitch-notes, .key-note-control')).to_have_count(0)
        assert not errors, errors
        site = browser.new_page(viewport={'width':1100,'height':1000})
        site_errors = []
        site.on('pageerror', lambda e: site_errors.append(str(e)))
        def asset(route):
            raw = urlparse(route.request.url).path.removeprefix('/soundcloud-tempo-control/')
            target = (ROOT/'dist/site'/unquote(raw)).resolve()
            assert target.is_relative_to((ROOT/'dist/site').resolve())
            if target.is_dir(): target = target/'index.html'
            if not target.is_file(): return route.fulfill(status=404, body='not found')
            route.fulfill(path=str(target), content_type=mimetypes.guess_type(str(target))[0] or 'application/octet-stream')
        site.route('http://127.0.0.1:4323/**', asset)
        site.goto('http://127.0.0.1:4323/soundcloud-tempo-control/')
        expect(site.locator('.tempo-editor-inline')).to_be_visible()
        site.locator('[data-lane=pitch]').click()
        graph = site.locator('.editor-graph')
        b = graph.bounding_box()
        site.mouse.dblclick(b['x']+44+(b['width']-56)*.6,b['y']+60/220*b['height'])
        assert site.locator('.point').count() == 2
        site.locator('.editor-advanced summary').click()
        site.locator('.point-rate').fill('1.5')
        site.locator('.point-rate').press('Tab')
        site.locator('.editor-save').click()
        stored = site.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('soundcloud.tempo.timeline.')).map(k=>JSON.parse(localStorage.getItem(k)))")
        assert stored[0]['data']['pitchPoints'][1]['k'] == 1.5, stored
        for width in [1100,390]:
            site.set_viewport_size({'width':width,'height':1000})
            assert site.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            site.locator('.tempo-editor-inline').screenshot(path=str(ROOT/f'test-results/site-pitch-{width}.png'))
        expect(site.locator('#site-stars, #site-star-speed, .star-settings')).to_have_count(0)
        site.emulate_media(reduced_motion='reduce')
        expect(site.locator('.space-accent')).not_to_have_attribute('data-visible', '')
        code = 'SCT1.' + base64.urlsafe_b64encode(json.dumps(saved).encode()).decode().rstrip('=')
        site.goto('http://127.0.0.1:4323/soundcloud-tempo-control/share/#sct=' + code)
        expect(site.locator('#share-summary')).to_contain_text('Pitch timeline')
        expect(site.locator('#share-actions')).to_be_visible()
        assert site.locator('#share-adjusted').get_attribute('href').startswith('https://soundcloud.com/test-artist/first-track?sct=SCT1.')
        site.goto('http://127.0.0.1:4323/soundcloud-tempo-control/share/#sct=invalid')
        site.reload()
        expect(site.locator('#share-actions')).to_be_hidden()
        expect(site.locator('#share-summary')).to_contain_text('missing or invalid')
        assert not site_errors, site_errors
        browser.close()
    print(json.dumps({'pitch_graph': 'pass', 'fractional_arrows': 'pass', 'manual_override': 'pass', 'saved_points': 'pass', 'tempo_increment': 'pass', 'musical_keys_removed': 'pass', 'shared_demo': 'pass', 'mobile_overflow': 'pass', 'star_controls': 'pass'}))

if __name__ == '__main__':
    main()
