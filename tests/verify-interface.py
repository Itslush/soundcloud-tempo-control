import os
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    for route, label in [('', 'Download'), ('guide/', 'Help'), ('updates/', 'Updates'), ('privacy/', None), ('support/', None)]:
        page.goto(BASE + route, wait_until='networkidle')
        active = page.locator('.site-header [aria-current=page]')
        expect(active).to_have_count(1 if label else 0)
        if label:
            expect(active).to_have_text(label)
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('audio')).to_have_js_property('paused', True)
    assert not page.locator('audio').get_attribute('src')
    page.add_style_tag(content='html { overflow-y: scroll; scrollbar-gutter: stable; }')
    for width in [320, 360, 390, 600, 768, 1001, 1440, 1920]:
        page.set_viewport_size({'width': width, 'height': 1000})
        for text in ['Bring Me The Horizon - Drown (Sewerslvt Remix)', '夜空 🎵 ' * 40, 'اختبار الصوت ' * 35]:
            page.locator('#preview-title').evaluate('(element, text) => element.textContent = text', text)
            assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), (width, text)
        for node in page.locator('#demo-nodes .node-hit').all():
            bounds = node.bounding_box()
            assert bounds['width'] >= 43.5 and bounds['height'] >= 43.5, (width, bounds)
        assert page.locator('#demo-graph').evaluate('(element) => getComputedStyle(element).touchAction') == 'pan-y'
        for disclosure in page.locator('.demo-details').all():
            disclosure.locator('summary').click()
            expect(disclosure).to_have_attribute('open', '')
            assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), width
            disclosure.locator('summary').click()
    page.set_viewport_size({'width': 1280, 'height': 960})
    page.locator('body').evaluate('(element) => element.style.zoom = "2"')
    assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')
    page.locator('body').evaluate('(element) => element.style.zoom = ""')
    trigger = page.locator('.select-trigger')
    for _ in range(4):
        trigger.click()
        expect(trigger).to_have_attribute('aria-expanded', 'true')
        page.get_by_role('option', name='Natural', exact=True).press('Escape')
        expect(trigger).to_be_focused()
        expect(trigger).to_have_attribute('aria-expanded', 'false')
        expect(page.locator('[role=listbox]')).to_have_js_property('inert', True)
    trigger.click()
    expect(page.locator('[role=listbox]')).to_have_js_property('inert', False)
    page.get_by_role('option', name='Natural', exact=True).press('End')
    expect(page.get_by_role('option', name='Preserve key', exact=True)).to_be_focused()
    page.keyboard.press('Enter')
    expect(trigger).to_contain_text('Preserve key')
    trigger.click()
    page.keyboard.press('Home')
    page.keyboard.press('Enter')
    expect(trigger).to_contain_text('Natural')
    capture = page.locator('a[data-capture]').first
    capture.click()
    expect(page.locator('.viewer-image')).to_be_visible()
    page.keyboard.press('Escape')
    expect(page.locator('.capture-viewer')).to_be_hidden()
    expect(capture).to_be_focused()
    capture.click()
    expect(page.locator('.viewer-image')).to_be_visible()
    page.locator('.viewer-close').click()
    expect(capture).to_be_focused()
    page.emulate_media(reduced_motion='reduce', forced_colors='active')
    assert page.locator('.space-accent').evaluate('(element) => getComputedStyle(element).display') == 'none'
    trigger.click()
    assert page.locator('[role=listbox]').evaluate('(element) => getComputedStyle(element).transitionDuration') == '0s'
    page.keyboard.press('Escape')
    capture.click()
    assert page.locator('.capture-viewer').evaluate('(element) => getComputedStyle(element).transitionDuration') == '0s'
    page.keyboard.press('Escape')
    assert page.locator('audio').evaluate('(audio) => audio.paused && !audio.currentSrc')
    assert not errors, errors
    browser.close()
print('Route states, 8 widths with reserved scrollbars, long Unicode titles, 2x CSS zoom, graph hit regions, disclosure interruption, menu focus and reduced-motion/high-contrast paths passed. No audio was loaded.')
