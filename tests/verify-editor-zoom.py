import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent


def main():
    with sync_playwright() as p:
        browser=p.chromium.launch(**browser_options(),headless=True,args=['--mute-audio'])
        page=browser.new_page(viewport={'width':1050,'height':900})
        page.route('https://soundcloud.com/**',lambda route:route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'),content_type='text/html'))
        page.add_init_script(script=userscript_source())
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('https://soundcloud.com/test-artist/first-track')
        page.evaluate("()=>{window.audio=new Audio();audio.muted=true;Object.defineProperty(audio,'duration',{value:200});document.body.append(audio);}")
        page.locator('.settings-button').click();page.locator('.open-editor').click()
        expect(page.locator('.speed-range')).to_have_value('2')
        expect(page.locator('.zoom-out')).to_be_disabled()
        page.locator('.zoom-in').click()
        expect(page.locator('.zoom-label')).to_have_text('Time zoom 2×')
        graph=page.locator('.editor-graph');b=graph.bounding_box()
        page.mouse.dblclick(b['x']+44+(b['width']-56)/2,b['y']+100/220*b['height'])
        assert abs(float(page.locator('.point-time').input_value())-100)<0.2
        expect(page.locator('.point-rate')).to_have_value('1.025')
        page.locator('.point-rate').fill('0.75');page.locator('.point-rate').press('Tab')
        page.locator('.speed-range').select_option('4')
        expect(page.locator('.point-rate')).to_have_value('0.75')
        page.locator('.zoom-fit').click()
        expect(page.locator('.speed-range')).to_have_value('2')
        expect(page.locator('.editor-pan')).to_be_disabled()
        for _ in range(8):page.locator('.zoom-in').click()
        expect(page.locator('.zoom-in')).to_be_disabled()
        expect(page.locator('.zoom-label')).to_have_text('Time zoom 200×')
        page.locator('.editor-pan').evaluate("el=>el.value='190'")
        page.locator('.editor-pan').dispatch_event('input')
        page.locator('.editor-point-picker').select_option('0')
        assert float(page.locator('.editor-pan').input_value())==0
        page.locator('.zoom-fit').click()
        page.locator('.editor-point-picker').select_option('1')
        page.locator('.zoom-focus').click()
        assert 30<float(page.locator('.zoom-label').inner_text().split()[2][:-1])<35
        expect(page.locator('.ramp')).to_be_visible()
        page.locator('.speed-range').select_option('close')
        expect(page.locator('.point-rate')).to_have_value('0.75')
        labels=page.locator('.editor-graph text').all_text_contents()
        assert '0.65×' in labels and '0.85×' in labels,labels
        assert not any(label in labels for label in ['0.675×', '0.837×', '0.713×']), labels
        point=page.locator('.point.selected').bounding_box()
        x=point['x']+point['width']/2
        y=point['y']+point['height']/2
        page.mouse.move(x+9,y)
        page.mouse.down()
        page.mouse.move(x,y-22,steps=4)
        page.mouse.up()
        expect(page.locator('.point-rate')).to_have_value('0.775')
        page.locator('.point-rate').fill('0.9'); page.locator('.point-rate').press('Tab')
        page.locator('.speed-range').select_option('fine')
        rates = [label for label in page.locator('.editor-graph text').all_text_contents() if label.endswith('×')]
        assert rates == ['0.6×', '0.7×', '0.8×', '0.9×', '1×', '1.1×', '1.2×'], rates
        for value in ['0.025', '0.05', '0.1', '0.25', '0.837', '4']:
            page.locator('.point-rate').fill(value); page.locator('.point-rate').press('Tab')
            rates = [float(label[:-1]) for label in page.locator('.editor-graph text').all_text_contents() if label.endswith('×')]
            assert all(rate == .025 or abs(rate * 10 - round(rate * 10)) < .0001 for rate in rates), rates
            expect(page.locator('.point-rate')).to_have_value(value)
        for width in [1050,768,440]:
            page.set_viewport_size({'width':width,'height':900})
            panel=page.locator('.tempo-editor')
            assert panel.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            page.screenshot(path=str(ROOT/f'test-results/editor-zoom-{width}.png'))
            page.locator('.point-rate').fill('0.025'); page.locator('.point-rate').press('Tab')
            for mode in ['2', '4', 'fine', 'close']:
                page.locator('.speed-range').select_option(mode)
                labels = page.locator('.editor-graph text').evaluate_all('''items => items
                    .filter(item => item.textContent.endsWith('×'))
                    .map(item => ({text: item.textContent, top: item.getBoundingClientRect().top,
                        bottom: item.getBoundingClientRect().bottom}))
                    .sort((a, b) => a.top - b.top)''')
                assert labels[-1]['text'] == '0.025×', labels
                assert all(a['bottom'] <= b['top'] for a, b in zip(labels, labels[1:])), labels
                expect(page.locator('.point-rate')).to_have_value('0.025')
                graph.screenshot(path=str(ROOT/f'test-results/editor-low-{width}-{mode}.png'))
            page.locator('.point-rate').fill('0.05'); page.locator('.point-rate').press('Tab')
            expect(page.locator('.point-rate')).to_have_value('0.05')
        assert not errors,errors
        page.reload()
        page.locator('.playbackTimeline__duration').evaluate('''el => {
            el.innerHTML = '<span class="sc-visuallyhidden">Duration: 3 minutes 22 seconds</span><span aria-hidden="true">3:22</span>';
        }''')
        page.locator('.settings-button').click(); page.locator('.open-editor').click()
        expect(page.locator('.tempo-editor')).to_be_visible()
        expect(page.locator('.timeline-end')).to_have_text('3:22')
        for _ in range(8):page.locator('.zoom-in').click()
        expect(page.locator('.zoom-label')).to_have_text('Time zoom 202×')
        expect(page.locator('.editor-pan')).to_have_attribute('max', '201')
        browser.close()
        print(json.dumps({'default_2x_zoom_pan_point_coordinates_fit_and_layout':'passed','silent':True}))


if __name__=='__main__':main()
