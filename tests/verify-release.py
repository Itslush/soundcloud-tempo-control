import base64
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright
from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
TRACK = '/test-artist/first-track'
URL = 'https://soundcloud.com' + TRACK
KEY = 'soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track'


def decode(text):
    encoded = text.split('SCT1.')[1]
    return json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))


def audio(page):
    page.evaluate('''() => {
        window.audio = new Audio(); audio.muted = true;
        audio.play().catch(() => {}); audio.pause();
        Object.defineProperty(audio, 'duration', {value: 200});
        document.body.append(audio);
    }''')


def open_editor(page):
    page.locator('.settings-button').click()
    page.locator('.open-editor').click()


def speed(page, rate):
    page.locator('.point-rate').fill(str(rate))
    page.locator('.point-rate').press('Tab')


def playback(page, rate, preserve):
    expect(page.locator('#rate-number')).to_have_value(str(rate))
    assert page.evaluate('audio.playbackRate') == rate
    assert page.evaluate('audio.preservesPitch') == preserve


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width': 1050, 'height': 900})
        context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        context.add_init_script('if(navigator.clipboard)navigator.clipboard.writeText=async text=>{window.copied=text};\n' + userscript_source())
        errors = []
        context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
        page = context.new_page()
        page.goto(URL)
        audio(page)
        open_editor(page)
        expect(page.locator('.editor-enable')).to_be_hidden()
        expect(page.locator('.editor-revert')).to_be_hidden()
        expect(page.locator('.zoom-focus')).to_be_hidden()
        expect(page.locator('.editor-link')).to_be_visible()
        expect(page.locator('.editor-copy')).to_be_hidden()
        speed(page, .75)
        page.locator('.editor-pitch').select_option('preserve')
        page.locator('.editor-apply-once').click()
        playback(page, .75, True)
        expect(page.locator('.editor-apply-once')).to_have_text('Stop timeline')
        expect(page.locator('.playback-state')).to_have_text('Session timeline · Preserve key')
        assert page.evaluate('(key)=>localStorage.getItem(key)', KEY) is None
        assert page.evaluate("localStorage.getItem('soundcloud.tempo.preserveKey')") is None
        page.locator('.editor-apply-once').click()
        playback(page, 1, False)
        expect(page.locator('.editor-apply-once')).to_have_text('Apply once')

        speed(page, .6)
        page.locator('.editor-save').click()
        playback(page, .6, True)
        expect(page.locator('.editor-enabled')).to_be_checked()
        expect(page.locator('.editor-revert')).to_be_hidden()
        assert page.evaluate('(key)=>JSON.parse(localStorage.getItem(key)).data.pitch', KEY) == 'preserve'
        page.reload()
        audio(page)
        playback(page, .6, True)
        page.locator('.playbackSoundBadge__titleLink').evaluate("el=>el.href='https://soundcloud.com/other/song'")
        playback(page, 1, False)
        page.locator('.playbackSoundBadge__titleLink').evaluate('(el,url)=>el.href=url', URL)
        playback(page, .6, True)
        open_editor(page)

        other = context.new_page()
        other.goto(URL)
        audio(other)
        playback(other, .6, True)
        page.locator('.editor-enabled').uncheck()
        playback(page, 1, False)
        playback(other, 1, False)
        page.locator('.editor-enabled').check()
        playback(other, .6, True)
        other.locator('#rate-number').fill('0.9')
        other.locator('#rate-number').press('Enter')
        page.locator('.editor-enabled').uncheck()
        playback(other, .9, False)
        page.locator('.editor-enabled').check()
        playback(other, .6, True)
        page.evaluate('(key)=>localStorage.removeItem(key)', KEY)
        playback(other, 1, False)
        other.close()

        page.reload()
        audio(page)
        open_editor(page)
        speed(page, .5)
        page.locator('.editor-pitch').select_option('preserve')
        page.locator('.editor-link').click()
        shared = decode(page.evaluate('copied'))
        assert shared['points'][0]['r'] == .5 and shared['pitch'] == 'preserve'
        page.locator('.editor-sharing summary').click()
        expect(page.locator('.editor-preview')).to_be_disabled()
        page.locator('.editor-copy').click()
        assert decode(page.evaluate('copied'))['points'][0]['r'] == .5
        speed(page, .8)
        page.locator('.editor-pitch').select_option('natural')
        page.locator('.editor-copy').click()
        copied = page.evaluate('copied')
        shared = decode(copied)
        assert shared['points'][0]['r'] == .8 and shared['pitch'] == 'natural'
        page.locator('.editor-code').fill(copied)
        page.locator('.editor-preview').click()
        expect(page.locator('.editor-import')).to_be_visible()
        page.locator('.editor-import').click()
        expect(page.locator('.editor-pitch')).to_have_value('natural')
        expect(page.locator('.editor-import')).to_be_hidden()
        page.locator('.editor-pitch').select_option('preserve')
        page.evaluate('()=>{navigator.clipboard.writeText=async()=>{throw new Error("Clipboard denied")}}')
        page.locator('.editor-link').click()
        expect(page.locator('.share-output')).to_be_focused()
        assert decode(page.locator('.share-output').input_value())['pitch'] == 'preserve'
        assert page.locator('.editor-code').input_value() == copied
        page.locator('.editor-code').fill('SCT1.invalid')
        page.locator('.editor-preview').click()
        expect(page.locator('.editor-import')).to_be_hidden()
        expect(page.locator('.editor-status')).to_contain_text('Cannot import')
        page.locator('.editor-code').fill('')
        expect(page.locator('.editor-preview')).to_be_disabled()

        page.evaluate('''() => {
            window.originalSet=Storage.prototype.setItem;
            Storage.prototype.setItem=()=>{throw new Error('Storage blocked')};
        }''')
        page.locator('.editor-save').click()
        expect(page.locator('.editor-status')).to_contain_text('Not saved')
        expect(page.locator('.editor-revert')).to_be_visible()
        page.evaluate('()=>{Storage.prototype.setItem=originalSet}')
        page.locator('.editor-apply-once').click()
        playback(page, .8, True)
        other = context.new_page()
        other.goto(URL)
        other.evaluate('(key)=>localStorage.removeItem(key)', KEY)
        other.evaluate('''([key,track])=>localStorage.setItem(key,JSON.stringify({enabled:true,data:{v:1,track,duration:200,points:[{t:0,r:.5,d:0,c:'instant'}],pitch:'natural'}}))''', [KEY, TRACK])
        page.wait_for_timeout(100)
        playback(page, .8, True)
        other.close()
        page.locator('.editor-apply-once').click()
        playback(page, 1, False)

        page.locator('.editor-sharing').evaluate('el=>el.open=false')
        for width, theme in [(1050, 'dark'), (1050, 'light'), (440, 'dark'), (360, 'light')]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.evaluate('(theme)=>{document.body.classList.toggle("light",theme==="light");dispatchEvent(new Event("resize"))}', theme)
            panel = page.locator('.tempo-editor')
            panel.evaluate('el=>el.scrollTop=0')
            assert panel.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
            dot = page.locator('.point').first.bounding_box()
            assert abs(dot['width']-dot['height']) < 1
            assert page.locator('.editor-graph text').first.evaluate('el=>getComputedStyle(el).fontSize') == '11px'
            panel.screenshot(path=str(ROOT/f'test-results/release-editor-{width}-{theme}.png'))
            page.locator('.editor-close').press('Escape')
            expect(page.locator('.settings-button')).to_be_focused()
            for selector in ['#soundcloud-tempo-control', '.playControls__soundBadge', '.playControls__timeline']:
                box = page.locator(selector).bounding_box()
                assert box['x'] >= 0 and box['x']+box['width'] <= width+1, (width, selector, box)
            page.locator('.playControls').screenshot(path=str(ROOT/f'test-results/release-footer-{width}-{theme}.png'))
            open_editor(page)
        for id in ['number-help', 'slider-help']:
            assert len(page.locator('#'+id).text_content()) < 70
        assert not errors, errors
        browser.close()
        print(json.dumps({'release_regressions': 'session stop, saved pitch, track changes, cross-tab disable/removal, manual override, current-draft sharing, import isolation, clipboard/storage failures, responsive graph/footer and short accessible help passed', 'audio': 'muted local fixture; no media played'}))


if __name__ == '__main__':
    main()
