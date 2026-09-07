import json
import os

from playwright.sync_api import expect, sync_playwright
from userscript_fixture import ROOT, browser_options


BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
REMOVED = [
    'Timeline active', 'Selected point 3', 'Drag points to change speed.',
    'Player controls at 0.90×.', 'Fade duration for the selected change.',
    'Track preferences in settings.', 'A shared timeline, ready to preview or save.',
]


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    page = context.new_page()
    errors = []
    resolves = []
    measurements = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: resolves.append(request.url) if '/api/resolve' in request.url else None)
    for width in [320, 390, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 900})
        for route in ['', 'guide/', 'support/', 'updates/', 'privacy/']:
            response = page.goto(BASE + route, wait_until='networkidle')
            assert response.ok
            header = page.locator('.site-header')
            bounds = header.bounding_box()
            assert bounds['x'] == 0 and abs(bounds['width'] - width) < 1, bounds
            assert page.evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth')
            for link in header.locator('a').all():
                box = link.bounding_box()
                assert box['height'] >= 44 and box['width'] >= 44, (route, width, box)
                assert box['x'] >= 0 and box['x'] + box['width'] <= width, box
                assert box['y'] >= 0 and box['y'] + box['height'] <= bounds['height'], box
            field = page.locator('.space-accent')
            expect(field).to_have_attribute('aria-hidden', 'true')
            expect(field).to_have_attribute('focusable', 'false')
            geometry = field.evaluate('''field => {
                const style = getComputedStyle(field);
                return {
                    height: field.getBoundingClientRect().height,
                    bodyHeight: document.body.getBoundingClientRect().height,
                    pointerEvents: style.pointerEvents,
                    filter: style.filter,
                    animation: style.animationName,
                    symbols: [...new Set([...field.querySelectorAll('use')].map(star => star.getAttribute('href')))],
                    gradients: field.querySelectorAll('filter, radialGradient, linearGradient').length,
                    period: Number(field.querySelector('pattern').getAttribute('height')),
                };
            }''')
            assert abs(geometry['height'] - geometry['bodyHeight']) < 1, geometry
            assert geometry['pointerEvents'] == 'none' and geometry['filter'] == 'none', geometry
            assert geometry['animation'] == 'none' and geometry['gradients'] == 0, geometry
            assert len(geometry['symbols']) >= 3 and geometry['period'] < geometry['height'], geometry
            page.evaluate('scrollTo(0, document.documentElement.scrollHeight)')
            assert abs(header.bounding_box()['y']) < 1, (width, route)
            if not route:
                body = page.locator('body').inner_text()
                assert all(text not in body for text in REMOVED), body
                expect(page.locator('#demo-timeline-state, #demo-selected, #demo-ready-hint, .demo-paused-label')).to_have_count(0)
                expect(page.locator('.product-capture figcaption, #capture-description, .viewer-hint')).to_have_count(0)
                page.locator('#install').evaluate('element => element.scrollIntoView()')
                assert page.locator('#install').bounding_box()['y'] >= header.bounding_box()['height'], width
                expect(page.get_by_label('Target speed', exact=True)).to_be_visible()
                page.locator('#demo-nodes .node').last.focus()
                page.keyboard.press('ArrowDown')
                expect(page.locator('#demo-point-rate')).to_have_value('0.875')
                page.locator('#preview-fixed').click()
                expect(page.locator('#preview-fixed')).to_have_attribute('aria-pressed', 'true')
                page.locator('#preview-timeline').click()
                expect(page.locator('#preview-timeline')).to_have_attribute('aria-pressed', 'true')
                expect(page.locator('#demo-status')).to_have_text('')
            measurements.append({'width': width, 'route': route or '/', 'headerHeight': bounds['height'], **geometry})
    page.emulate_media(forced_colors='active')
    expect(page.locator('.space-accent')).to_be_hidden()
    page.emulate_media(forced_colors='none', reduced_motion='reduce')
    assert page.locator('.space-accent').evaluate('element => getComputedStyle(element).animationName') == 'none'
    assert not resolves, resolves
    assert not errors, errors
    browser.close()
    (ROOT / 'test-results/site-presentation.json').write_text(json.dumps(measurements, indent=2) + '\n', encoding='utf-8')
    print('Passed: full-width sticky header, unobscured anchors, full-page varied stars without glow, no hint clutter, working mode/node controls, forced colours and no automatic track fetch at 4 widths on 5 routes.')
