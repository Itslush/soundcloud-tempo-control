import json

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, choose_option, text_contrast, userscript_source


def assert_fill(input):
    value, expected = input.evaluate('''el => [
        parseFloat(el.style.getPropertyValue('--range-fill')),
        100 * (el.valueAsNumber - Number(el.min)) / (Number(el.max) - Number(el.min))
    ]''')
    assert abs(value - expected) < .001, (value, expected)


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    context.route('https://soundcloud.com/**', lambda route: route.fulfill(
        path=str(ROOT / 'tests/fixtures/inline-fixture.html'), content_type='text/html'))
    context.add_init_script(userscript_source())
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    for theme in ['oled', 'charcoal', 'light']:
        for width in [1440, 390, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto('https://soundcloud.com/test-artist/first-track')
            if theme == 'light':
                page.locator('body').evaluate('el => el.classList.add("light")')
            page.locator('.settings-button').click()
            page.locator('.appearance-settings summary').click()
            page.locator(f'input[name=appearance][value={"native" if theme == "light" else theme}]').check()
            choice = page.locator('#control-style').locator('..').locator('.tempo-choice-trigger')
            increment = page.locator('#tempo-increment')
            increment.fill('0.1')
            increment.press('Tab')
            expect(choice).to_have_css('border-top-width', '1px')
            expect(choice.locator('svg')).to_be_visible()
            assert choice.bounding_box()['height'] >= 36
            assert text_contrast(choice) >= 4.5
            choice.focus()
            choice.press('Enter')
            expect(choice).to_have_attribute('aria-expanded', 'true')
            page.keyboard.press('End')
            page.keyboard.press('Enter')
            expect(page.locator('#control-style')).to_have_value('vertical')
            expect(choice).to_be_focused()
            choice.press('Enter')
            page.keyboard.press('Escape')
            expect(choice).to_have_attribute('aria-expanded', 'false')
            page.locator('#star-motion').check()
            stars = page.locator('#star-speed')
            stars.fill('2.75')
            stars.press('Tab')
            page.mouse.move(0, 0)
            expect(stars).to_have_css('--range-thumb-opacity', '1')
            assert_fill(stars)
            assert page.locator('.settings').evaluate('el => el.scrollWidth <= el.clientWidth + 1')
            page.locator('.appearance-settings').screenshot(path=str(ROOT / f'test-results/affordance-settings-{theme}-{width}.png'))
            page.locator('#apply-saved').press('Escape')
            number_input = page.locator('#rate-number')
            number_input.fill('1')
            number_input.press('Tab')
            page.locator('.step-up').click()
            expect(number_input).to_have_value('1.1')
            number_input.press('ArrowDown')
            expect(number_input).to_have_value('1')
            key = page.locator('#quick-key-shift')
            key.fill('-2')
            key.press('Tab')
            unit = page.locator('.key-unit').bounding_box()
            number = key.bounding_box()
            arrows = page.locator('.quick-key .tempo-number-arrows').bounding_box()
            assert 2 <= unit['x'] - number['x'] - number['width'] <= 6
            assert 2 <= arrows['x'] - unit['x'] - unit['width'] <= 6
            assert abs(number['y'] + number['height']/2 - arrows['y'] - arrows['height']/2) <= .5
            page.get_by_role('button', name='Increase Key shift in semitones', exact=True).click()
            expect(key).to_have_value('-1.5')
            page.locator('#other-input').click()
            page.locator('#soundcloud-tempo-control').screenshot(path=str(ROOT / f'test-results/affordance-footer-{theme}-{width}.png'))
            page.locator('#vertical-toggle').click()
            fader = page.locator('#tempo-fader')
            page.locator('#rate-slider').press('ArrowUp')
            expect(number_input).to_have_value('1.1')
            assert page.locator('.fader-ticks path').get_attribute('d').count('M') == 16
            assert page.locator('.dial-ticks').get_attribute('d').count('M') == 17
            for label in ['.fader-normal', '.fader-min', '.fader-max']:
                box = page.locator(label).bounding_box()
                rail = page.locator('#rate-slider').bounding_box()
                assert box['x'] + box['width'] < rail['x'] + rail['width']/2 - 6
            page.locator('#rate-slider').press('End')
            expect(page.locator('#rate-number')).to_have_value('4')
            page.locator('.fader-reset').click()
            expect(page.locator('#rate-number')).to_have_value('1')
            fader.screenshot(path=str(ROOT / f'test-results/affordance-fader-{theme}-{width}.png'))
            page.keyboard.press('Escape')
            assert page.locator('.playControls__elements').evaluate('el => el.scrollWidth <= el.clientWidth + 1')
            page.reload()
            page.locator('.settings-button').click()
            page.locator('.appearance-settings summary').click()
            expect(increment).to_have_value('0.1')
            increment.fill('0')
            increment.press('Tab')
            expect(increment).to_have_value('0.1')
            expect(page.locator('.settings-status')).to_contain_text('increment')
            choose_option(page.locator('#control-style'), 'dial')
            page.locator('#apply-saved').press('Escape')
            page.locator('#rate-dial').press('ArrowUp')
            expect(number_input).to_have_value('1.1')
            page.evaluate("localStorage.setItem('soundcloud.tempo.tempoIncrement','0.125'); window.dispatchEvent(new StorageEvent('storage',{key:'soundcloud.tempo.tempoIncrement'}))")
            page.locator('#rate-dial').press('ArrowUp')
            expect(number_input).to_have_value('1.225')
            page.locator('#other-input').click()
            page.locator('#soundcloud-tempo-control').screenshot(path=str(ROOT / f'test-results/affordance-dial-{theme}-{width}.png'))
            page.locator('.settings-button').click()
            page.locator('.advanced-audio > summary').click()
            page.locator('.pitch-customization summary').click()
            expect(page.locator('#pitch-notes, #pitch-source, #quick-key-note')).to_have_count(0)
            page.locator('.pitch-customization').screenshot(path=str(ROOT / f'test-results/affordance-pitch-settings-{theme}-{width}.png'))
            expect(stars).to_have_value('2.75')
            assert_fill(stars)
            page.locator('#star-motion').uncheck()
            expect(stars).to_be_disabled()
            page.locator('#star-motion').check()
            stars.press('ArrowRight')
            expect(stars).to_have_value('3')
            assert_fill(stars)
    assert not errors, errors
    browser.close()
    print(json.dumps({'control_affordances': 'passed', 'themes': 3, 'widths': [1440, 390, 320]}))
