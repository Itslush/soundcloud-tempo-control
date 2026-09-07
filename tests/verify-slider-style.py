import io
import json
import os

from PIL import Image, ImageDraw
from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')


def opacity(slider, value):
    expect(slider).to_have_css('--range-thumb-opacity', str(value))
    slider.evaluate('''async input => {
        await Promise.all(input.getAnimations({subtree: true}).map(animation => animation.finished));
    }''')


def away(page, slider):
    slider.evaluate('input => input.blur()')
    page.mouse.move(0, 0)


def fill_matches(slider):
    values = slider.evaluate('''input => ({
        min: Number(input.min), max: Number(input.max), value: input.valueAsNumber,
        fill: parseFloat(getComputedStyle(input).getPropertyValue('--range-fill'))
    })''')
    span = values['max'] - values['min']
    expected = max(0, min(1, (values['value'] - values['min']) / span)) * 100 if span > 0 else 0
    assert abs(values['fill'] - expected) < .000001, values


def thumb_rules(slider):
    return slider.evaluate('''input => {
        const result = {};
        const visit = rules => {
            for (const rule of rules) {
                if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue;
                if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
                if (rule.cssRules) visit(rule.cssRules);
                if (!rule.selectorText?.includes('::-webkit-slider-thumb')) continue;
                const selectors = rule.selectorText.split(',').map(value => value.trim());
                if (!selectors.some(value => value.endsWith('::-webkit-slider-thumb') &&
                    input.matches(value.replace('::-webkit-slider-thumb', '')))) continue;
                for (const property of ['width', 'height', 'box-sizing', 'border', 'border-top-width',
                    'border-radius', 'opacity', 'transition']) {
                    const value = rule.style.getPropertyValue(property);
                    if (value) result[property] = value;
                }
            }
        };
        const root = input.getRootNode();
        const sheets = root instanceof ShadowRoot
            ? [...root.querySelectorAll('style')].map(style => style.sheet)
            : [...document.styleSheets];
        for (const sheet of sheets) visit(sheet.cssRules);
        return result;
    }''')


def orange(pixel):
    red, green, blue = pixel[:3]
    return red > 85 and red - green > 30 and green - blue > 12


def ring_pixels(slider, screenshot):
    pixels = Image.open(io.BytesIO(screenshot)).convert('RGB')
    bounds = slider.bounding_box()
    scale = pixels.width / bounds['width']
    middle = pixels.height / 2
    marked = [(x, y) for y in range(pixels.height) if 2 * scale < abs(y + .5 - middle) < 7 * scale
              for x in range(pixels.width) if orange(pixels.getpixel((x, y)))]
    if not marked:
        pixels.save(ROOT / f'test-results/new-slider-failure-{slider.get_attribute("id")}.png')
        raise AssertionError(slider.evaluate('''input => ({id: input.id,
            rect: input.getBoundingClientRect().toJSON(),
            accent: getComputedStyle(input).getPropertyValue('--tempo-accent'),
            opacity: getComputedStyle(input).getPropertyValue('--range-thumb-opacity'),
            hover: input.matches(':hover'), background: getComputedStyle(input).background})'''))
    left, right = min(x for x, _ in marked), max(x for x, _ in marked)
    top, bottom = min(y for _, y in marked), max(y for _, y in marked)
    actual = (left + right + 1) / (2 * scale)
    position = slider.evaluate('input => (input.valueAsNumber - Number(input.min)) / (Number(input.max) - Number(input.min))')
    expected = 6 + (bounds['width'] - 12) * position
    assert abs(actual - expected) <= 1.1, {'id': slider.get_attribute('id'), 'actual': actual, 'expected': expected}
    assert 8 <= (right - left + 1) / scale <= 13.1, (left, right, scale)
    assert 10 <= (bottom - top + 1) / scale <= 13.1, (top, bottom, scale)
    assert not orange(pixels.getpixel((round(actual * scale), round(middle)))), 'Thumb must be outlined, not solid'


def idle_pixels(screenshot):
    pixels = Image.open(io.BytesIO(screenshot)).convert('RGB')
    middle = pixels.height / 2
    assert not any(orange(pixels.getpixel((x, y))) for y in range(pixels.height)
                   if 3 < abs(y + .5 - middle) < 7 for x in range(pixels.width))


def check_states(page, slider, captures, touch=False, disabled=False):
    expect(slider).to_be_visible()
    slider.scroll_into_view_if_needed()
    rules = thumb_rules(slider)
    assert rules['width'] == rules['height'] == '12px', rules
    assert rules['box-sizing'] == 'border-box', rules
    assert rules.get('border-top-width') == '1px' or rules.get('border', '').startswith('1px solid '), rules
    assert rules['border-radius'] == '50%' and rules['opacity'] == 'var(--range-thumb-opacity)', rules
    assert slider.bounding_box()['height'] >= 32
    assert slider.get_attribute('aria-label') or slider.evaluate('input => input.labels.length > 0')
    away(page, slider)
    opacity(slider, 1 if touch else 0)
    if not touch:
        idle = slider.screenshot(animations='disabled')
        idle_pixels(idle)
        captures.append((slider.get_attribute('id') + ' idle', idle))
    if disabled:
        expect(slider).to_be_disabled()
        page.emulate_media(forced_colors='active')
        opacity(slider, 1)
        page.emulate_media(forced_colors='none')
        previous = slider.input_value()
        bounds = slider.bounding_box()
        page.mouse.click(bounds['x'] + bounds['width'] - 6, bounds['y'] + bounds['height'] / 2)
        expect(slider).to_have_value(previous)
        slider.evaluate('input => input.disabled = false')
    try:
        slider.hover()
        opacity(slider, 1)
        if not touch:
            page.wait_for_timeout(160)
        hovered = slider.screenshot(animations='disabled')
        ring_pixels(slider, hovered)
        captures.append((slider.get_attribute('id') + (' touch' if touch else ' hover'), hovered))
        away(page, slider)
        page.keyboard.press('Tab')
        slider.focus()
        assert slider.evaluate('input => input.matches(":focus-visible")')
        opacity(slider, 1)
        assert slider.evaluate('input => getComputedStyle(input).outlineStyle') != 'none'
        if not disabled:
            before = slider.input_value()
            slider.press('Home')
            expect(slider).to_have_value(slider.get_attribute('min'))
            slider.press('End')
            expect(slider).to_have_value(slider.get_attribute('max'))
            slider.fill(before)
        fill_matches(slider)
        slider.evaluate('input => input.blur()')
        bounds = slider.bounding_box()
        page.mouse.move(bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2)
        page.mouse.down()
        page.mouse.move(bounds['x'] + bounds['width'] / 2, max(1, bounds['y'] - 15))
        assert max(1, bounds['y'] - 15) < bounds['y']
        assert slider.evaluate('input => input.matches(":active")')
        opacity(slider, 1)
        page.mouse.up()
        away(page, slider)
        opacity(slider, 1 if touch else 0)
        page.emulate_media(forced_colors='active', reduced_motion='reduce')
        opacity(slider, 1)
        expect(slider).to_have_css('forced-color-adjust', 'none')
        assert thumb_rules(slider)['transition'] == 'none'
        page.emulate_media(forced_colors='none', reduced_motion='no-preference')
    finally:
        page.mouse.up()
        if disabled:
            slider.evaluate('input => input.disabled = true')


def montage(captures, name):
    images = [(label, Image.open(io.BytesIO(data)).convert('RGB')) for label, data in captures]
    canvas = Image.new('RGB', (max(image.width for _, image in images) + 24,
                               sum(image.height + 35 for _, image in images) + 12), '#161616')
    draw = ImageDraw.Draw(canvas)
    top = 12
    for label, picture in images:
        draw.text((12, top), label, fill='#eeeeee')
        canvas.paste(picture, (12, top + 18))
        top += picture.height + 35
    canvas.save(ROOT / f'test-results/new-slider-{name}.png')


def run_context(browser, touch):
    context = browser.new_context(viewport={'width': 600 if touch else 1440, 'height': 1000},
                                  has_touch=touch, device_scale_factor=1)
    captures, errors = [], []
    try:
        native = context.new_page()
        native.on('pageerror', lambda error: errors.append(str(error)))
        native.add_init_script(userscript_source())
        native.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT / 'tests/fixtures/inline-fixture.html')))
        native.goto('https://soundcloud.com/test-artist/first-track')
        footer = native.locator('#rate-slider')
        check_states(native, footer, captures, touch)
        native.locator('.settings-button').click()
        native.locator('.advanced-audio summary').click()
        output = native.locator('#output-level')
        check_states(native, output, captures, touch)
        native.evaluate('''() => {
            const key = 'soundcloud.tempo.outputDb';
            localStorage.setItem(key, '-12');
            window.dispatchEvent(new StorageEvent('storage', {key, newValue: '-12'}));
        }''')
        expect(output).to_have_value('-12')
        expect(native.locator('#output-value')).to_have_text('-12 dB')
        fill_matches(output)
        native.locator('.open-editor').click()
        expect(native.locator('#timeline-pan')).to_be_disabled()
        native.locator('.zoom-in').click()
        pan = native.locator('#timeline-pan')
        check_states(native, pan, captures, touch)
        native.locator('.zoom-fit').click()
        expect(pan).to_be_disabled()
        fill_matches(pan)
        site = context.new_page()
        site.set_viewport_size({'width': 390 if touch else 1440, 'height': 1000})
        site.on('pageerror', lambda error: errors.append(str(error)))
        site.goto(BASE, wait_until='networkidle')
        check_states(site, site.locator('#preview-volume'), captures, touch)
        check_states(site, site.locator('#preview-seek'), captures, touch, disabled=True)
        site.locator('#preview-fixed').click()
        check_states(site, site.locator('#demo-speed'), captures, touch)
        site.locator('#preview-timeline').click()
        site.locator('#zoom-in').click()
        check_states(site, site.locator('#demo-pan'), captures, touch)
        site.locator('#preview-reset').click()
        fill_matches(site.locator('#demo-speed'))
        fill_matches(site.locator('#demo-pan'))
        assert site.locator('audio').evaluate('audio => audio.paused && !audio.currentSrc')
        assert native.locator('audio').count() == 0
        assert not errors, errors
        montage(captures, 'touch' if touch else 'desktop')
        return {'touch': touch, 'controls': 7, 'silent': True,
                'disabledSeekStyling': 'Temporarily enabled without loading or playing audio'}
    finally:
        context.close()


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    try:
        results = [run_context(browser, touch) for touch in [False, True]]
        print(json.dumps({'sliderStyle': results, 'programmaticOutputReload': 'passed'}))
    finally:
        browser.close()
