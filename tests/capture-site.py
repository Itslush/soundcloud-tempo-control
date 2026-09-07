import sys
import os
from playwright.sync_api import sync_playwright
from userscript_fixture import ROOT, browser_options

destination = ROOT/'test-results/site-review'
BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
destination.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width':1505, 'height':1045}, device_scale_factor=1)
    response = page.goto(BASE, wait_until='networkidle')
    assert response.ok
    page.locator('#hero-title').wait_for()
    page.screenshot(path=str(destination/'hero-repro.png'), animations='disabled')
    if '--full' in sys.argv:
        for width, name in [(1440, 'desktop'), (390, 'mobile')]:
            page.set_viewport_size({'width':width, 'height':844 if width < 600 else 1000})
            page.goto(BASE, wait_until='networkidle')
            for image in page.locator('img[src]').all():
                image.scroll_into_view_if_needed()
                image.evaluate('image=>image.decode()')
            page.evaluate('scrollTo(0,0)')
            page.screenshot(path=str(destination/f'{name}.png'), full_page=True, animations='disabled')
            page.locator('.product-proof').evaluate('element => element.scrollIntoView({block: "start"})')
            page.screenshot(path=str(destination/f'proof-{name}.png'), animations='disabled')
            for index, subject in [(1, 'timeline'), (3, 'sharing')]:
                page.locator('a[data-capture]').nth(index).click()
                page.locator('.viewer-image').wait_for(state='visible')
                page.screenshot(path=str(destination/f'viewer-{subject}-{name}.png'), animations='disabled')
                page.keyboard.press('Escape')
            page.goto(BASE + 'support/', wait_until='networkidle')
            page.screenshot(path=str(destination/f'support-{name}.png'), full_page=True, animations='disabled')
    browser.close()
