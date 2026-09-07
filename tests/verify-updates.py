import json
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, userscript_source, browser_options

KEY = 'soundcloud.tempo.seenVersion'
VERSION = json.loads((ROOT/'package.json').read_text(encoding='utf-8'))['version']

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html')))
    context.add_init_script(userscript_source())
    page = context.new_page()
    page.goto('https://soundcloud.com/test-artist/first-track')
    expect(page.locator('#rate-number')).to_be_visible()
    expect(page.locator('.release-notice')).to_have_count(0)
    assert page.evaluate('key=>localStorage.getItem(key)', KEY) == VERSION
    page.evaluate('key=>localStorage.setItem(key,"0.9.0")', KEY)
    page.reload()
    expect(page.locator('.release-notice')).to_contain_text(f'v{VERSION}')
    expect(page.locator('.release-notice a')).to_have_count(0)
    page.locator('.release-notice button').click()
    expect(page.locator('.release-notice')).to_have_count(0)
    page.reload()
    expect(page.locator('.release-notice')).to_have_count(0)
    second = context.new_page()
    second.goto('https://soundcloud.com/test-artist/first-track')
    expect(second.locator('.release-notice')).to_have_count(0)
    blocked = browser.new_context()
    blocked.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html')))
    blocked.add_init_script('Storage.prototype.setItem=()=>{throw new Error("blocked")};\n'+userscript_source())
    third = blocked.new_page()
    third.goto('https://soundcloud.com/test-artist/first-track')
    expect(third.locator('#rate-number')).to_be_visible()
    expect(third.locator('.release-notice')).to_have_count(0)
    browser.close()
print('One-time update notice, first install, reload, second tab and blocked storage passed.')
