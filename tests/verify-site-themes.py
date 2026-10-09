import json
import os

from playwright.sync_api import expect, sync_playwright
from userscript_fixture import ROOT, browser_options, serve_site


def contrast(a, b):
    def luminance(rgb):
        channels = [value / 255 for value in rgb]
        return sum((v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4) * weight
                   for v, weight in zip(channels, [0.2126, 0.7152, 0.0722]))
    a, b = sorted([luminance(a), luminance(b)])
    return (b + 0.05) / (a + 0.05)


server, local = serve_site()
base = os.environ.get('SITE_URL', local)
backgrounds = {'light': 'rgb(247, 247, 245)', 'charcoal': 'rgb(17, 17, 17)', 'oled': 'rgb(0, 0, 0)'}
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**browser_options(), headless=True)
    context = browser.new_context(reduced_motion='reduce')
    page = context.new_page()
    errors, measurements = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base, wait_until='networkidle')
    expect(page.locator('html')).to_have_attribute('data-theme', 'charcoal')
    for width in [1440, 390, 320]:
        page.set_viewport_size({'width': width, 'height': 950})
        for theme in backgrounds:
            page.locator('.site-appearance summary').click()
            choice = page.locator(f'[data-site-theme="{theme}"]')
            choice.focus()
            page.keyboard.press('Space')
            expect(choice).to_have_attribute('aria-pressed', 'true')
            expect(choice).to_have_css('background-color', backgrounds[theme])
            expect(page.locator('.site-theme-options [aria-pressed="true"]')).to_have_count(1)
            assert choice.bounding_box()['height'] >= 44
            boxes = [button.bounding_box() for button in page.locator('[data-site-theme]').all()]
            assert max(box['y'] for box in boxes) - min(box['y'] for box in boxes) < 1, boxes
            assert page.evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth')
            if width == 390:
                page.screenshot(path=str(ROOT / f'test-results/theme-{theme}-settings.png'))
            page.reload(wait_until='networkidle')
            expect(page.locator('html')).to_have_attribute('data-theme', theme)
            expect(page.locator('.site-appearance')).not_to_have_attribute('open', '')
            expect(page.locator('html')).to_have_css('background-color', backgrounds[theme])
            tokens = page.evaluate('''() => {
                const root = getComputedStyle(document.documentElement);
                const names = ['ground','surface','raised','ink','muted','accent','on-accent','control','track','graph-label'];
                return Object.fromEntries(names.map(name => [name,root.getPropertyValue('--'+name).trim()]));
            }''')
            def rgb(token):
                value = tokens[token].lstrip('#')
                if len(value) == 3: value = ''.join(c * 2 for c in value)
                return tuple(int(value[i:i+2], 16) for i in [0, 2, 4])
            for fg in ['ink', 'muted', 'graph-label']:
                for bg in ['ground', 'surface', 'raised']:
                    assert contrast(rgb(fg), rgb(bg)) >= 4.5, (theme, fg, bg)
            for bg in ['ground', 'surface']:
                assert contrast(rgb('accent'), rgb(bg)) >= 4.5, (theme, 'accent', bg)
                assert contrast(rgb('control'), rgb(bg)) >= 3, (theme, 'control', bg)
            assert contrast(rgb('on-accent'), rgb('accent')) >= 4.5, theme
            page.locator('.editor-advanced summary').click()
            expect(page.get_by_label('Target speed', exact=True)).to_be_visible()
            expect(page.locator('.editor-advanced')).to_have_css('color', page.locator('html').evaluate('el => getComputedStyle(el).color'))
            page.locator('#preview-fixed').click()
            page.locator('#demo-speed').focus()
            page.keyboard.press('ArrowRight')
            expect(page.locator('#demo-speed')).not_to_have_value('1')
            page.locator('#preview-timeline').click()
            page.locator('.editor-advanced summary').click()
            if width in [1440, 390]:
                page.screenshot(path=str(ROOT / f'test-results/theme-{theme}-{width}.png'))
            page.locator('a[data-capture]').first.click()
            expect(page.locator('.capture-viewer')).to_be_visible()
            expect(page.locator('.capture-viewer')).to_have_css('background-color', f'rgb({", ".join(map(str, rgb("surface")))})')
            page.keyboard.press('Escape')
            expect(page.locator('.capture-viewer')).not_to_be_visible()
            measurements.append({'theme': theme, 'width': width, 'tokens': tokens})
    for theme in backgrounds:
        page.locator('.site-appearance summary').click()
        page.locator(f'[data-site-theme="{theme}"]').click()
        for route in ['guide/', 'updates/', 'privacy/', 'share/']:
            page.goto(base + route, wait_until='networkidle')
            expect(page.locator('html')).to_have_attribute('data-theme', theme)
            assert page.evaluate('document.documentElement.scrollWidth === document.documentElement.clientWidth')
        page.emulate_media(forced_colors='active')
        expect(page.locator('.space-accent')).to_be_hidden()
        assert page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ground').trim()") == 'Canvas'
        page.emulate_media(forced_colors='none')
    other = context.new_page()
    other.goto(base, wait_until='networkidle')
    other.locator('.site-appearance summary').click()
    other.locator('[data-site-theme="light"]').click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    other.evaluate("localStorage.removeItem('soundcloud.tempo.siteTheme')")
    expect(page.locator('html')).to_have_attribute('data-theme', 'charcoal')
    other.evaluate("localStorage.setItem('soundcloud.tempo.siteTheme', 'invalid')")
    expect(page.locator('html')).to_have_attribute('data-theme', 'charcoal')
    first_paint = browser.new_context()
    first_paint.add_init_script("localStorage.setItem('soundcloud.tempo.siteTheme', 'light')")
    early = first_paint.new_page()
    early.route('**/_astro/*.js', lambda route: route.abort())
    early.goto(base, wait_until='networkidle')
    expect(early.locator('html')).to_have_css('background-color', backgrounds['light'])
    first_paint.close()
    blocked = browser.new_context()
    blocked.add_init_script("Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }")
    failed = blocked.new_page()
    failed.goto(base, wait_until='networkidle')
    failed.locator('.site-appearance summary').click()
    failed.locator('[data-site-theme="light"]').click()
    expect(failed.locator('html')).to_have_attribute('data-theme', 'light')
    expect(failed.locator('#site-theme-status')).to_contain_text('could not save')
    blocked.close()
    assert not errors, errors
    browser.close()
server.shutdown()
(ROOT / 'test-results/site-themes.json').write_text(json.dumps(measurements, indent=2) + '\n')
print('Passed: three website themes, contrast, keyboard, controls/dialogs, three widths, route/reload/cross-tab persistence, pre-module theme, forced colours, invalid settings and blocked storage.')
