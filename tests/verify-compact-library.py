import io
import json

from PIL import Image
from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, tempo_tick_geometry, userscript_source


def seed_tracks(page):
    page.evaluate('''() => {
        for (let index = 1; index <= 30; index++) {
            const track = '/artist-' + String(index).padStart(2, '0') + '/a-long-track-name-' + index;
            if (index % 5 !== 0 || index === 10) {
                localStorage.setItem('soundcloud.tempo.track.' + encodeURIComponent(track),
                    JSON.stringify({rate: index % 2 ? 0.875 : 1.025, enabled: index % 3 !== 0}));
            }
            if (index % 5 === 0) {
                localStorage.setItem('soundcloud.tempo.timeline.' + encodeURIComponent(track),
                    JSON.stringify({enabled: true, data: {v: 1, track, duration: 200,
                        points: [{t: 0, r: 0.85, d: 0, c: 'instant'}], pitch: 'natural'}}));
            }
        }
    }''')


def library_layout(page, width, height):
    page.set_viewport_size({'width': width, 'height': height})
    panel = page.locator('#tempo-settings')
    metrics = panel.evaluate('''panel => {
        const list = panel.querySelector('.saved-list');
        const bounds = list.getBoundingClientRect();
        const rows = [...list.children].map(row => row.getBoundingClientRect());
        return {
            width: panel.clientWidth, height: panel.clientHeight,
            horizontalOverflow: panel.scrollWidth > panel.clientWidth,
            outerScroll: panel.scrollHeight - panel.clientHeight,
            innerScroll: list.scrollHeight > list.clientHeight,
            visibleRows: rows.filter(row => row.top >= bounds.top && row.bottom <= bounds.bottom).length,
            rowHeight: rows[0].height,
        };
    }''')
    panel.screenshot(path=str(ROOT / f'test-results/compact-library-{width}.png'))
    assert not metrics['horizontalOverflow'], metrics
    assert metrics['outerScroll'] == 0, metrics
    assert metrics['innerScroll'], metrics
    assert metrics['rowHeight'] <= 44, metrics
    assert metrics['visibleRows'] >= (9 if height >= 820 else 6), metrics
    bounds = panel.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width, bounds
    assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= height, bounds
    print(json.dumps({'viewport': [width, height], **metrics}), flush=True)
    search_y = page.locator('#saved-filter').bounding_box()['y']
    page.locator('.saved-list').evaluate('list => list.scrollTop = list.scrollHeight')
    expect(page.locator('.saved-row').last).to_be_in_viewport()
    assert page.locator('#saved-filter').bounding_box()['y'] == search_y
    page.locator('.saved-list').evaluate('list => list.scrollTop = 0')
    return metrics


def ring_alignment(page, scale, width):
    page.set_viewport_size({'width': width, 'height': 900})
    slider = page.locator('#rate-slider')
    ruler = page.locator('.ticks')
    geometry = tempo_tick_geometry(ruler, slider, 12, intervals=79)
    wrap = page.locator('.slider-wrap')
    page.keyboard.press('Tab')
    slider.focus()
    offsets = []
    for rate in [0.025, 0.05, 0.1, 0.25, 0.275, 0.85, 0.875, 1, 1.975, 2]:
        slider.fill(str(rate))
        expect(slider).to_have_value(str(rate))
        pixels = Image.open(io.BytesIO(wrap.screenshot())).convert('RGB')
        orange = []
        for y in range(round(9 * scale), min(pixels.height, round(23 * scale))):
            if abs(y + .5 - 16 * scale) <= 2 * scale:
                continue
            for x in range(pixels.width):
                red, green, blue = pixels.getpixel((x, y))
                if red > 85 and red - green > 30 and green - blue > 12:
                    orange.append((x, y))
        assert orange, {'rate': rate, 'scale': scale, 'width': width}
        left = min(x for x, _ in orange)
        right = max(x for x, _ in orange)
        actual = (left + right + 1) / (2 * scale)
        assert 8 <= (right - left + 1) / scale <= 13.1
        center = pixels.getpixel((round(actual * scale), round(16 * scale)))
        assert not (center[0] > 180 and 30 < center[1] < 160 and center[2] < 80), center
        start, end = geometry['endpoints']
        expected = start + (rate - .025) / 1.975 * (end - start) - wrap.bounding_box()['x']
        error = abs(actual - expected)
        assert error <= 1.1, {'rate': rate, 'scale': scale, 'width': width, 'actual': actual, 'expected': expected}
        offsets.append(round(error, 3))
    slider.fill('0.875')
    wrap.screenshot(path=str(ROOT / f'test-results/new-slider-ring-{width}-{scale}.png'))
    return {'scale': scale, 'width': width, 'maxCenterErrorPx': max(offsets)}


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    try:
        layouts = []
        alignment = []
        for scale in [1, 1.25, 2]:
            context = browser.new_context(device_scale_factor=scale, viewport={'width': 1440, 'height': 1000})
            context.add_init_script(userscript_source())
            context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT / 'tests/fixtures/inline-fixture.html')))
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('https://soundcloud.com/test-artist/first-track')
            expect(page.locator('#rate-slider')).to_be_visible()
            if scale == 1:
                seed_tracks(page)
                page.locator('.settings-button').click()
                expect(page.locator('.saved-row')).to_have_count(30)
                for width, height in [(1440, 1000), (1050, 820), (390, 820), (320, 640)]:
                    layouts.append({'viewport': [width, height], **library_layout(page, width, height)})
                page.locator('#saved-filter').fill('artist-10/')
                expect(page.locator('.saved-row')).to_have_count(1)
                expect(page.locator('.saved-setting')).to_have_count(2)
                page.locator('.saved-setting[data-type=speed] input[type=checkbox]').uncheck()
                expect(page.locator('.saved-setting[data-type=timeline] input[type=checkbox]')).to_be_checked()
                page.locator('.saved-setting[data-type=speed] input[type=number]').fill('0.925')
                page.locator('.saved-setting[data-type=speed] input[type=number]').press('Enter')
                page.locator('.saved-setting[data-type=speed] .saved-remove').click()
                expect(page.locator('.saved-setting')).to_have_count(1)
                page.locator('.saved-undo').click()
                expect(page.locator('.saved-setting[data-type=speed] input[type=number]')).to_have_value('0.925')
                page.locator('#saved-filter').fill('')
                page.locator('.advanced-audio summary').click()
                expect(page.locator('#output-level')).to_be_in_viewport()
                page.locator('#tempo-settings').screenshot(path=str(ROOT / 'test-results/compact-library-expanded.png'))
                page.locator('.close-settings').click()
            for width in [1440, 850, 600]:
                alignment.append(ring_alignment(page, scale, width))
            if scale == 1:
                page.set_viewport_size({'width': 1440, 'height': 900})
                page.emulate_media(forced_colors='active')
                wrap = page.locator('.slider-wrap')
                assert 'linear-gradient' in page.locator('#rate-slider').evaluate('element => getComputedStyle(element).backgroundImage')
                pixels = Image.open(io.BytesIO(wrap.screenshot(path=str(ROOT / 'test-results/new-slider-forced-colors.png')))).convert('RGB')
                background = pixels.getpixel((0, 0))
                assert sum(pixels.getpixel((x, y)) != background for y in range(10, 22) for x in range(pixels.width)) >= 50
                page.emulate_media(forced_colors='none')
            assert not errors, errors
            context.close()
        print(json.dumps({'compactLibrary': layouts, 'ringAlignment': alignment, 'silent': True}))
    finally:
        browser.close()
