import json

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, userscript_source


def edit(page, name, value):
    field = page.locator('.point-' + name)
    field.fill(str(value))
    field.press('Tab')


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        page = browser.new_page(viewport={'width': 1050, 'height': 900}, device_scale_factor=2)
        page.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT / 'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        page.add_init_script(userscript_source())
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto('https://soundcloud.com/test-artist/first-track')
        page.evaluate('''() => {
          const audio = new Audio();
          audio.muted = true;
          audio.volume = 0;
          Object.defineProperty(audio, 'duration', {value: 394});
          Object.defineProperty(audio, 'currentTime', {value: 0, writable: true});
          window.testAudio = audio;
          document.body.append(audio);
        }''')
        page.locator('.settings-button').click()
        page.locator('.open-editor').click()
        for time, rate, fade in [(110, .75, 85), (270, .9, 120)]:
            page.evaluate('time => { testAudio.currentTime = time; }', time)
            page.locator('.point-add').click()
            edit(page, 'time', time)
            edit(page, 'rate', rate)
            page.locator('.point-curve').select_option('smooth')
            edit(page, 'duration', fade)
        page.locator('.speed-range').select_option('fine')
        handle = page.get_by_role('slider', name='Fade start', exact=True)
        expect(handle).to_be_visible()
        expect(handle).to_have_attribute('aria-valuenow', '150')
        expect(handle.locator('text')).to_have_text('Fade start')
        assert handle.evaluate('node => node.tagName') == 'g'
        label = handle.locator('.ramp-label').bounding_box()
        x, y = label['x'] + label['width'] / 2, label['y'] + label['height'] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x, y)
        expect(page.locator('.point-duration')).to_have_value('120')
        page.mouse.move(x + 40, y, steps=5)
        page.mouse.up()
        assert float(page.locator('.point-duration').input_value()) < 120
        expect(page.locator('.point-time')).to_have_value('270')
        expect(page.locator('.point-rate')).to_have_value('0.9')
        edit(page, 'duration', 120)
        handle.locator('.ramp-label').dblclick()
        expect(page.locator('.editor-point-picker option')).to_have_count(3)
        handle.focus()
        page.keyboard.press('ArrowLeft')
        expect(page.locator('.point-duration')).to_have_value('121')
        expect(handle).to_be_focused()
        page.keyboard.press('Shift+ArrowRight')
        expect(page.locator('.point-duration')).to_have_value('120.9')
        page.keyboard.press('Home')
        expect(handle).to_have_attribute('aria-valuenow', '110')
        expect(page.locator('.point-duration')).to_have_value('160')
        page.keyboard.press('End')
        expect(handle).to_have_attribute('aria-valuenow', '270')
        expect(page.locator('.point-duration')).to_have_value('0')
        page.keyboard.press('Enter')
        expect(page.locator('.point-duration')).to_be_focused()
        edit(page, 'duration', 120)
        page.locator('.zoom-focus').click()
        handle.focus()
        page.keyboard.press('Home')
        expect(handle).to_be_focused()
        expect(handle).to_be_visible()
        page.locator('.zoom-fit').click()
        edit(page, 'duration', 120)
        page.locator('.speed-range').select_option('fine')
        page.locator('.editor-save').click()
        for width in [1050, 390]:
            page.set_viewport_size({'width': width, 'height': 844})
            bounds = page.locator('.editor-graph').bounding_box()
            label = handle.locator('.ramp-label').bounding_box()
            assert label['x'] >= bounds['x']
            assert label['x'] + label['width'] <= bounds['x'] + bounds['width']
            page.locator('.tempo-editor').screenshot(path=str(ROOT / f'test-results/fade-start-{width}.png'))
        page.locator('.point-curve').select_option('instant')
        expect(handle).to_have_count(0)
        assert not errors, errors
        browser.close()
        print(json.dumps({'fade_start_label_drag_keyboard_bounds_and_layout': 'passed', 'silent': True}))


if __name__ == '__main__':
    main()
