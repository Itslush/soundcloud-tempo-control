import os

from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, tempo_tick_geometry, userscript_source, serve_site

server, default_base = serve_site()
BASE = os.environ.get('SITE_URL', default_base)


def check_sizes(page, ruler, slider, thumb_width, widths, intervals=35):
    for width in widths:
        page.set_viewport_size({'width': width, 'height': 1000})
        for zoom in [1, 1.25, 2, 3.5]:
            ruler.evaluate('(element, zoom) => element.parentElement.style.zoom = zoom', str(zoom))
            tempo_tick_geometry(ruler, slider, thumb_width, intervals)
        ruler.evaluate('element => element.parentElement.style.zoom = ""')
    slider.fill('1')
    slider.press('ArrowRight')
    expect(slider).to_have_value('1.025')
    slider.press('ArrowLeft')
    expect(slider).to_have_value('1')


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    try:
        for scale in [1, 1.25, 2]:
            context = browser.new_context(device_scale_factor=scale)
            errors = []
            native = context.new_page()
            native.on('pageerror', lambda error: errors.append(str(error)))
            native.add_init_script(userscript_source())
            native.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT / 'tests/fixtures/inline-fixture.html')))
            native.goto('https://soundcloud.com/test-artist/first-track')
            expect(native.locator('#rate-slider')).to_be_visible()
            check_sizes(native, native.locator('.ticks'), native.locator('#rate-slider'), 12, [1440, 850, 600], intervals=70)
            if scale == 2:
                native.set_viewport_size({'width': 1440, 'height': 1000})
                native.locator('.slider-wrap').screenshot(path=str(ROOT / 'test-results/slider-ticks-native.png'))
            site = context.new_page()
            site.on('pageerror', lambda error: errors.append(str(error)))
            site.goto(BASE, wait_until='networkidle')
            site.locator('#preview-fixed').click()
            for width in [1440, 768, 390]:
                site.set_viewport_size({'width': width, 'height': 1000})
                for control, step in [('#demo-speed', '1.025'), ('#demo-key-slider', '1.5')]:
                    slider = site.locator(control)
                    slider.fill('1')
                    slider.press('ArrowRight')
                    expect(slider).to_have_value(step)
                    expect(slider).to_have_css('--range-thumb-opacity', '1')
                    assert slider.evaluate('el=>getComputedStyle(el).backgroundImage') != 'none'
            if scale == 2:
                site.locator('#preview-fixed-controls').screenshot(path=str(ROOT / 'test-results/slider-ticks-site.png'))
            assert site.locator('audio').evaluate('audio => audio.paused && !audio.currentSrc')
            assert not errors, errors
            context.close()
        print('Userscript ruler: all 71 stops aligned across zoom and DPR. Website: both styled sliders remain visible and keyboard-adjustable at 3 widths and device scales. No audio loaded.')
    finally:
        browser.close()
        server.shutdown()
