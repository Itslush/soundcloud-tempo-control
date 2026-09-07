import os
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('input[type=number]')).to_have_count(4)
    expect(page.locator('[data-number-field]')).to_have_count(4)
    page.locator('#preview-fixed').click()
    page.locator('.demo-details').first.locator('summary').click()
    for field in page.locator('input[type=number]').all():
        assert field.evaluate('(input) => getComputedStyle(input).appearance') == 'textfield'
        expect(field).to_have_accessible_name(field.get_attribute('id') and page.locator(f'label[for="{field.get_attribute("id")}"]').inner_text())
    assert page.evaluate('''() => Array.from(document.styleSheets).some(sheet =>
        Array.from(sheet.cssRules).some(rule =>
            rule.selectorText?.includes('::-webkit-inner-spin-button') &&
            rule.style.getPropertyValue('-webkit-appearance') === 'none'))''')
    page.locator('#preview-timeline').click()
    page.locator('.demo-details').first.locator('summary').click()

    rate = page.locator('#demo-point-rate')
    plus = page.get_by_role('button', name='Increase target speed', exact=True)
    minus = page.get_by_role('button', name='Decrease target speed', exact=True)
    plus.click()
    expect(rate).to_have_value('0.925')
    minus.click()
    expect(rate).to_have_value('0.9')
    rate.press('ArrowUp')
    expect(rate).to_have_value('0.925')
    rate.press('ArrowDown')
    rate.fill('1.075')
    rate.press('Enter')
    plus.click()
    expect(rate).to_have_value('1.1')
    rate.fill('')
    rate.press('Enter')
    expect(rate).to_have_value('1.1')
    rate.fill('99')
    rate.press('Enter')
    expect(rate).to_have_value('2')
    expect(plus).to_be_disabled()
    rate.fill('-1')
    rate.press('Enter')
    expect(rate).to_have_value('0.25')
    expect(minus).to_be_disabled()

    page.locator('.demo-details').first.locator('summary').click()
    time = page.locator('#demo-point-time')
    fade = page.locator('#demo-point-fade')
    page.get_by_role('button', name='Increase point time', exact=True).click()
    expect(time).to_have_value('18.1')
    page.get_by_role('button', name='Increase fade duration', exact=True).click()
    expect(fade).to_have_value('8.1')
    time.fill('0')
    time.press('Enter')
    expect(time).to_have_value('8.1')
    expect(fade).to_have_value('0.1')
    expect(page.get_by_role('button', name='Decrease point time', exact=True)).to_be_disabled()
    expect(page.get_by_role('button', name='Increase fade duration', exact=True)).to_be_disabled()
    page.locator('#demo-nodes .node').first.focus()
    for field in [time, fade]:
        expect(field).to_be_disabled()
        for button in field.locator('xpath=../..').get_by_role('button').all():
            expect(button).to_be_disabled()
    page.locator('#demo-nodes .node').last.focus()
    expect(time).to_be_enabled()

    exact = page.locator('#demo-speed-number')
    page.locator('#preview-fixed').click()
    page.get_by_role('button', name='Increase fixed playback speed', exact=True).click()
    expect(exact).to_have_value('1.025')
    expect(page.locator('#preview-follow')).not_to_be_checked()
    exact.fill('4')
    exact.press('Enter')
    expect(page.get_by_role('button', name='Increase fixed playback speed', exact=True)).to_be_disabled()
    page.get_by_role('button', name='Decrease fixed playback speed', exact=True).click()
    expect(exact).to_have_value('3.975')
    expect(page.locator('#demo-speed')).to_have_value('2')
    exact.press('ArrowDown')
    expect(exact).to_have_value('3.95')

    page.locator('#preview-reset').click()
    rate.fill('1.075')
    rate.press('Enter')
    page.locator('#preview-fixed').click()
    for width in [320, 360, 600, 768, 1001, 1024, 1440]:
        page.set_viewport_size({'width': width, 'height': 1100})
        assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), width
        for button in page.locator('.number-step').all():
            box = button.bounding_box()
            assert box['width'] >= 44 and box['height'] >= 44, (width, box)
        assert page.locator('[data-number-field]').evaluate_all('''fields => fields.every(field => {
            const input = field.querySelector('input');
            const style = getComputedStyle(input);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = style.font;
            const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return context.measureText(input.value).width <= available + 1;
        })'''), width
        if width in [360, 1440]:
            page.locator('.demo-surface').screenshot(path=str(ROOT/'test-results'/f'number-fields-{width}.png'))
            page.locator('#preview-fixed-controls').screenshot(path=str(ROOT/'test-results'/f'number-speed-{width}.png'))

    page.keyboard.press('Tab')
    plus.focus()
    assert plus.evaluate('(button) => getComputedStyle(button).outlineStyle') != 'none'
    plus.press('Space')
    expect(rate).to_have_value('1.1')
    page.locator('.select-trigger').focus()
    expect(page.locator('.select-trigger')).to_be_focused()
    page.emulate_media(forced_colors='active', reduced_motion='reduce')
    minus.focus()
    assert minus.evaluate('(button) => getComputedStyle(button).outlineStyle') != 'none'
    assert errors == [], errors
    browser.close()
print('Four custom number fields: buttons, typing, keyboard, bounds, disabled sync, precision, 44px targets, six widths and forced-colour focus passed.')
