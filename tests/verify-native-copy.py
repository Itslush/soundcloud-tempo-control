import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://soundcloud.com/test-artist/first-track'


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width':1050,'height':820})
        context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
        script = userscript_source()
        context.add_init_script('navigator.clipboard.writeText=async text=>{window.copied=text;};\n'+script)
        page = context.new_page()
        page.goto(URL)
        page.locator('#rate-number').fill('0.9')
        page.locator('#rate-number').press('Enter')
        page.evaluate('(url)=>navigator.clipboard.writeText(url)', URL)
        assert page.evaluate('copied') == URL
        page.locator('.settings-button').click()
        page.locator('#copy-tempo-links').check()
        page.evaluate('(url)=>navigator.clipboard.writeText(url)', URL+'?si=example')
        link = page.evaluate('copied')
        assert '?si=example#sct=SCT1.' in link
        payload = link.split('SCT1.')[1]
        data = json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        assert data['pitch']=='natural' and data['points'][0]['r']==.9
        for unrelated in ['https://example.com/a','https://soundcloud.com/another/track',URL+'#existing','not a URL']:
            page.evaluate('(url)=>navigator.clipboard.writeText(url)', unrelated)
            assert page.evaluate('copied') == unrelated
        event_link = page.evaluate('''url=>{
            const input=document.createElement('input');input.value=url;document.body.append(input);input.select();
            const data=new DataTransfer();const event=new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true});
            input.dispatchEvent(event);input.remove();return data.getData('text/plain');
        }''', URL)
        assert '#sct=SCT1.' in event_link
        context_link = page.evaluate('''()=>{
            const anchor=document.querySelector('.playbackSoundBadge__titleLink');
            window.originalHref=anchor.getAttribute('href');
            anchor.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,composed:true}));
            return anchor.href;
        }''')
        assert '#sct=SCT1.' in context_link
        page.evaluate("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))")
        assert page.evaluate("document.querySelector('.playbackSoundBadge__titleLink').getAttribute('href')===originalHref")
        page.evaluate('''()=>{
            const anchor=document.querySelector('.playbackSoundBadge__titleLink');
            anchor.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,composed:true}));
            anchor.setAttribute('href','/another/new-track');
            document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
        }''')
        assert page.evaluate("document.querySelector('.playbackSoundBadge__titleLink').getAttribute('href')") == '/another/new-track'
        page.goto(link)
        page.reload()
        expect(page.locator('.tempo-editor')).to_be_visible()
        page.evaluate('''()=>{window.audio=new Audio();audio.muted=true;Object.defineProperty(audio,'duration',{value:201});document.body.append(audio);}''')
        page.locator('.editor-apply-once').click()
        expect(page.locator('#rate-number')).to_have_value('0.9')
        assert page.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('soundcloud.tempo.timeline.')).length")==0
        assert page.evaluate("localStorage.getItem('soundcloud.tempo.preserveKey')") is None
        page.locator('.editor-close').click()
        page.locator('.settings-button').click()
        expect(page.locator('#copy-tempo-links')).to_be_checked()
        expect(page.locator('#rate-number')).to_have_attribute('title','Exact tempo · double-click to reset')
        page.screenshot(path=str(ROOT/'test-results/compact-copy-settings.png'))
        browser.close()
        print('Native clipboard, copy event, opt-in, unchanged unrelated URLs, pitch payload, session-only apply and concise tooltip: passed')


if __name__=='__main__': main()
