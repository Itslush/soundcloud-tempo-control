import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        page = browser.new_page(viewport={'width':1050,'height':1000})
        page.route('https://soundcloud.com/**',lambda route:route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'),content_type='text/html'))
        page.add_init_script(script=userscript_source())
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.goto('https://soundcloud.com/test-artist/first-track')
        page.evaluate('''() => {
            window.audio=new Audio();audio.muted=true;
            Object.defineProperty(audio,'duration',{get:()=>200});
            Object.defineProperty(audio,'currentTime',{get:()=>37});
            document.body.append(audio);
        }''')
        page.locator('.settings-button').click()
        page.locator('.open-editor').click()
        expect(page.locator('.timeline-navigation')).to_be_hidden()
        for _ in range(8):
            page.locator('.zoom-in').click()
        slider=page.get_by_role('slider',name='Scroll timeline')
        expect(slider).to_be_visible()
        slider.focus()
        slider.press('Home')
        expect(page.locator('.view-window')).to_have_text('0:00–0:01')
        slider.focus()
        slider.press('ArrowRight')
        expect(page.locator('.view-window')).to_have_text('0:00.01–0:01.01')
        expect(slider).to_have_attribute('aria-valuetext','Viewing 0:00.01–0:01.01 of 3:20')
        box=slider.bounding_box()
        page.mouse.click(box['x']+box['width']*.6,box['y']+box['height']/2)
        assert 100<float(slider.input_value())<140
        assert page.evaluate('audio.currentTime')==37
        assert page.evaluate('audio.playbackRate')==1
        assert page.evaluate('audio.paused')
        for width,theme in [(1050,'dark'),(440,'dark'),(1050,'light')]:
            page.set_viewport_size({'width':width,'height':1000})
            page.evaluate('(light)=>{document.body.classList.toggle("light",light);window.dispatchEvent(new Event("resize"));}',theme=='light')
            slider.focus()
            slider.press('Home')
            panel=page.locator('.tempo-editor')
            assert panel.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            panel.screenshot(path=str(ROOT/f'test-results/timeline-pan-{width}-{theme}.png'))
        page.locator('.zoom-fit').click()
        expect(page.locator('.timeline-navigation')).to_be_hidden()
        expect(page.locator('.editor-pan')).to_be_disabled()
        assert not errors,errors
        browser.close()
        print(json.dumps({'timeline_pan':'label, mouse, keyboard, precise range, themes, narrow layout and unchanged playback passed','silent':True}))


if __name__=='__main__':
    main()
