import base64
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
TRACK = '/test-artist/first-track'
KEY = 'soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track'


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width':1050,'height':820})
        context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        context.add_init_script(script='navigator.clipboard.writeText=async text=>{window.copied=text};\n'+userscript_source())
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('https://soundcloud.com'+TRACK)
        page.locator('#rate-number').fill('0.9')
        page.locator('#rate-number').press('Enter')
        page.locator('.settings-button').click()
        page.locator('.open-editor').click()
        expect(page.locator('.point-rate')).to_have_value('0.9')
        page.locator('.tempo-editor summary').click()
        page.locator('.editor-link').click()
        link = page.evaluate('copied')
        assert link.startswith('https://soundcloud.com'+TRACK+'#sct=SCT1.'), link
        payload = link.split('SCT1.')[1]
        data = json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        assert data['points'][0]['r'] == .9
        page.goto(link)
        page.reload()
        expect(page.locator('.tempo-editor')).to_be_visible()
        expect(page.locator('.point-rate')).to_have_value('0.9')
        assert page.evaluate('(key)=>localStorage.getItem(key)', KEY) is None
        expect(page.locator('#rate-number')).to_have_value('1')
        page.locator('.editor-save').click()
        assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).data.points[0].r', KEY) == .9
        page.locator('.tempo-editor summary').click()
        page.locator('.editor-code').fill(link.replace(TRACK, '/wrong/song', 1))
        page.locator('.editor-preview').click()
        expect(page.locator('.editor-status')).to_contain_text('different tracks')
        expect(page.locator('.editor-import')).to_be_disabled()
        page.locator('.editor-code').fill(link)
        page.locator('.editor-preview').click()
        expect(page.locator('.editor-import')).to_be_enabled()
        page.screenshot(path=str(ROOT/'test-results/share-links.png'))
        assert not errors, errors
        print(json.dumps({'link_roundtrip_preview_confirmation_path_validation':'passed','network':'SoundCloud requests fulfilled from local fixture','audio':'muted; none played'}))
        browser.close()


if __name__ == '__main__':
    main()
