import argparse
import base64
import hashlib
import json
from datetime import datetime, timezone

from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source, userscript_bytes

TRACK = '/test-artist/first-track'
CANONICAL = 'https://soundcloud.com' + TRACK
EMBEDDED = 'https://soundcloud.com/n' + TRACK
SHORT = 'https://on.soundcloud.com/fixture-token'
BADGE = "section[aria-label='Track header'] .soundcloud-tempo-page-indicator"
CHILD = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Embedded track fixture</title>
<style>body{font:16px sans-serif}.artwork{width:160px;height:160px}img{width:160px;height:160px}</style>
<script>
window.fixtureWrites=[];
window.fixtureClipboard=async text=>{fixtureWrites.push(String(text));};
navigator.clipboard.writeText=fixtureClipboard;
window.fixtureNext='https://on.soundcloud.com/fixture-token';
window.fixtureCopy=()=>navigator.clipboard.writeText(fixtureNext);
</script></head><body>
<section aria-label="Track header"><h1>First track</h1>
<div class="artwork"><img src="https://i1.sndcdn.com/artworks-fixture-large.jpg" alt="Track artwork"></div>
<button aria-label="Copy link" onclick="fixtureCopy()">Copy link</button>
<a id="canonical" href="https://soundcloud.com/test-artist/first-track">Track link</a>
<input id="share-input" aria-label="Share link" value="https://soundcloud.com/test-artist/first-track">
</section><button id="unrelated">Unrelated action</button>
<button id="outside-copy" aria-label="Copy link" onclick="fixtureCopy()">Unrelated copy</button>
</body></html>'''


def payload(link):
    assert link.startswith(CANONICAL + '#sct=SCT1.'), link
    encoded = link.split('SCT1.', 1)[1]
    result = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
    assert result['track'] == TRACK and result['points'][0]['r'] == 0.85, result
    assert result['pitch'] == 'natural', result
    return result


def copy_text(frame, value):
    frame.evaluate('value => navigator.clipboard.writeText(value)', value)
    return frame.evaluate('fixtureWrites.at(-1)')


def select_copy(frame, value):
    return frame.evaluate('''value => {
        const input=document.querySelector('#share-input');
        input.value=value;input.select();
        const data=new DataTransfer();
        const event=new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true});
        input.dispatchEvent(event);
        return {text:data.getData('text/plain'),prevented:event.defaultPrevented};
    }''', value)


def context_link(frame, value=CANONICAL):
    return frame.evaluate('''value => {
        const anchor=document.querySelector('#canonical');anchor.setAttribute('href',value);
        anchor.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,composed:true}));
        return anchor.getAttribute('href');
    }''', value)


def remember_frame(page, name='embedded'):
    page.evaluate('''name => {
        const frame=document.querySelector('#'+name), win=frame.contentWindow;
        window.fixtureRetired={doc:win.document,nav:win.navigator,original:win.fixtureClipboard,
            Event:win.ClipboardEvent,Data:win.DataTransfer,Mouse:win.MouseEvent};
    }''', name)


def retired_state(page):
    return page.evaluate('''() => {
        const old=fixtureRetired,data=new old.Data();data.setData('text/plain','https://soundcloud.com/test-artist/first-track');
        const copy=new old.Event('copy',{clipboardData:data,bubbles:true,cancelable:true});
        old.doc.querySelector('#share-input').dispatchEvent(copy);
        const anchor=old.doc.querySelector('#canonical');
        anchor.dispatchEvent(new old.Mouse('contextmenu',{bubbles:true,cancelable:true}));
        return {clipboardRestored:old.nav.clipboard.writeText===old.original,
            copy:data.getData('text/plain'),prevented:copy.defaultPrevented,
            href:anchor.getAttribute('href'),badges:old.doc.querySelectorAll('.soundcloud-tempo-page-indicator').length,
            styles:old.doc.querySelectorAll('style').length,
            artworkClasses:old.doc.querySelector('.artwork').className};
    }''')


def cleaned(page, href=CANONICAL, clipboard_restored=True):
    page.wait_for_function('''expected => {
        const old=fixtureRetired;
        return (old.nav.clipboard.writeText===old.original)===expected &&
            old.doc.querySelectorAll('.soundcloud-tempo-page-indicator').length===0;
    }''', arg=clipboard_restored)
    result = retired_state(page)
    assert result == {'clipboardRestored': clipboard_restored, 'copy': CANONICAL,
                      'prevented': False, 'href': href, 'badges': 0, 'styles': 1,
                      'artworkClasses': 'artwork'}, result
    return result


def attach(page, url=EMBEDDED, sandbox=None, name='embedded'):
    with page.expect_event('frameattached') as attached:
        page.evaluate('''({url,sandbox,name}) => {
            const iframe=document.createElement('iframe');
            iframe.id=name;iframe.name=name;iframe.width=600;iframe.height=340;
            if(sandbox!==null)iframe.setAttribute('sandbox',sandbox);
            iframe.src=url;document.querySelector('main').append(iframe);
        }''', {'url': url, 'sandbox': sandbox, 'name': name})
    frame = attached.value
    frame.wait_for_url(url)
    frame.locator('#share-input').wait_for()
    return frame


def remove(page, name='embedded'):
    page.locator('#' + name).evaluate('frame => frame.remove()')


def no_controller(page):
    expect(page.locator('#soundcloud-tempo-control')).to_have_count(1)
    for frame in page.frames[1:]:
        expect(frame.locator('#soundcloud-tempo-control')).to_have_count(0)
        expect(frame.locator('audio')).to_have_count(0)


def unchanged_copy(frame, value):
    actual = copy_text(frame, value)
    assert actual == value, actual
    copied = select_copy(frame, value)
    assert copied == {'text': '', 'prevented': False}, copied
    actual = context_link(frame, value)
    assert actual == value, actual


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', default='embedded-track-report.json')
    options = parser.parse_args()
    result = {'timestampUtc': datetime.now(timezone.utc).isoformat(),
              'userscriptSha256': hashlib.sha256(userscript_bytes()).hexdigest(),
              'topWindowOnlyInjection': True, 'audio': 'No audio elements or playback; --mute-audio', 'cases': []}
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        requests = []
        errors = []
        top = (ROOT / 'tests/fixtures/inline-fixture.html').read_text(encoding='utf-8')
        def route(request):
            if request.request.resource_type == 'document':
                body = top if request.request.frame.parent_frame is None else CHILD
                request.fulfill(status=200, content_type='text/html', body=body)
            else:
                request.fulfill(status=204, body='')
        context.route('**/*', route)
        context.add_init_script('if(window===window.top){\n' + userscript_source() + '\n}')
        page = context.new_page()
        page.on('request', lambda request: requests.append(request.url))
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_default_timeout(5000)
        page.set_default_navigation_timeout(15000)
        def check(name, action):
            try:
                evidence = action()
                result['cases'].append({'name': name, 'status': 'PASS', 'evidence': evidence})
            except Exception as error:
                result['cases'].append({'name': name, 'status': 'FAIL', 'error': str(error)})
        try:
            page.goto(CANONICAL, wait_until='domcontentloaded')
            number = page.locator('#rate-number')
            number.fill('0.85')
            number.press('Enter')
            page.locator('.settings-button').click()
            page.locator('#copy-tempo-links').check()
            page.locator('.close-settings').click()
            frame = attach(page)
            check('embedded hero badge', lambda: expect(frame.locator(BADGE)).to_be_visible())
            check('child canonical clipboard', lambda: payload(copy_text(frame, CANONICAL)))
            def native_short():
                frame.locator("section[aria-label='Track header'] button").click()
                return payload(frame.evaluate('fixtureWrites.at(-1)'))
            check('native header shortlink clipboard', native_short)
            def child_selected():
                copied = select_copy(frame, CANONICAL)
                assert copied['prevented'], copied
                return payload(copied['text'])
            check('child selected-input copy', child_selected)
            def href_lifecycle():
                payload(context_link(frame))
                frame.locator('#unrelated').click()
                expect(frame.locator('#canonical')).to_have_attribute('href', CANONICAL)
                payload(context_link(frame))
                frame.evaluate("document.querySelector('#canonical').setAttribute('href','/another/new-track')")
                frame.locator('#unrelated').click()
                expect(frame.locator('#canonical')).to_have_attribute('href', '/another/new-track')
                frame.evaluate("document.querySelector('#canonical').setAttribute('href','https://soundcloud.com/test-artist/first-track')")
            check('context-menu enrichment and safe href restoration', href_lifecycle)
            def unrelated():
                for value in [SHORT, 'https://soundcloud.com/other-artist/other-track',
                              CANONICAL + '#existing', CANONICAL + '#sct=SCT1.existing',
                              'https://soundcloud.com/n' + TRACK,
                              'https://example.com/track', 'not a URL']:
                    unchanged_copy(frame, value)
                frame.evaluate('fixtureNext="https://on.soundcloud.com/fixture-token"')
                frame.locator('#outside-copy').click()
                assert frame.evaluate('fixtureWrites.at(-1)') == SHORT
                assert copy_text(frame, SHORT) == SHORT
            check('unrelated links, fragments, bare shortlinks and outside-header action unchanged', unrelated)
            def one_use_intent():
                frame.evaluate('fixtureNext="https://on.soundcloud.com/fixture-token"')
                frame.locator("section[aria-label='Track header'] button").click()
                payload(frame.evaluate('fixtureWrites.at(-1)'))
                assert copy_text(frame, SHORT) == SHORT
                frame.evaluate("document.querySelector('section button').onclick=null")
                frame.locator("section[aria-label='Track header'] button").click()
                frame.locator('#unrelated').click()
                assert copy_text(frame, SHORT) == SHORT
                frame.evaluate("document.querySelector('section button').onclick=fixtureCopy")
            check('shortlink intent consumed once and cleared by unrelated click', one_use_intent)
            def selected_short():
                frame.evaluate("document.querySelector('section button').onclick=null")
                frame.locator("section[aria-label='Track header'] button").click()
                copied = select_copy(frame, SHORT)
                assert copied['prevented'], copied
                payload(copied['text'])
                assert copy_text(frame, SHORT) == SHORT
                frame.evaluate("document.querySelector('section button').onclick=fixtureCopy")
            check('selected-input shortlink uses and consumes trusted header intent', selected_short)
            def expired_intent():
                frame.evaluate("document.querySelector('section button').onclick=null")
                frame.locator("section[aria-label='Track header'] button").click()
                frame.wait_for_timeout(5100)
                assert copy_text(frame, SHORT) == SHORT
                frame.evaluate("document.querySelector('section button').onclick=fixtureCopy")
            check('shortlink intent expires after five seconds', expired_intent)
            def untrusted_action():
                frame.evaluate('''() => {
                    fixtureNext='https://on.soundcloud.com/fixture-token';
                    document.querySelector('section button').dispatchEvent(new MouseEvent('click',{bubbles:true}));
                }''')
                actual = frame.evaluate('fixtureWrites.at(-1)')
                assert actual == SHORT, actual
            check('synthetic header click cannot authorize shortlink conversion', untrusted_action)
            def native_fragment():
                for value in [SHORT + '#existing', SHORT + '#sct=SCT1.existing',
                              CANONICAL + '#existing', 'https://soundcloud.com/other-artist/other-track']:
                    frame.evaluate('value=>fixtureNext=value', value)
                    frame.locator("section[aria-label='Track header'] button").click()
                    actual = frame.evaluate('fixtureWrites.at(-1)')
                    assert actual == value, actual
                frame.evaluate('value=>fixtureNext=value', SHORT)
            check('trusted native action preserves existing fragments and unrelated canonical track', native_fragment)
            def opt_out():
                frame.evaluate("document.querySelector('section button').onclick=null")
                frame.locator("section[aria-label='Track header'] button").click()
                page.locator('.settings-button').click()
                page.locator('#copy-tempo-links').uncheck()
                page.locator('.close-settings').click()
                unchanged_copy(frame, CANONICAL)
                frame.evaluate("document.querySelector('section button').onclick=fixtureCopy")
                frame.locator("section[aria-label='Track header'] button").click()
                assert frame.evaluate('fixtureWrites.at(-1)') == SHORT
                page.locator('.settings-button').click()
                page.locator('#copy-tempo-links').check()
                page.locator('.close-settings').click()
                assert copy_text(frame, SHORT) == SHORT
                payload(copy_text(frame, CANONICAL))
            check('opt-out and stale intent after opt-in', opt_out)
            check('one top controller and no frame audio/controller', lambda: no_controller(page))
            def removed():
                payload(context_link(frame))
                remember_frame(page)
                remove(page)
                return cleaned(page)
            check('removal restores clipboard/href and clears retired document effects', removed)
            if page.locator('#embedded').count():
                remove(page)
            frame = attach(page)
            check('dynamic replacement reattaches one badge', lambda: expect(frame.locator(BADGE)).to_have_count(1))
            def navigation():
                payload(context_link(frame))
                remember_frame(page)
                frame.goto('https://soundcloud.com/n/other-artist/other-track')
                frame.locator('#share-input').wait_for()
                evidence = cleaned(page)
                unchanged_copy(frame, 'https://soundcloud.com/other-artist/other-track')
                frame.locator("section[aria-label='Track header'] button").click()
                assert frame.evaluate('fixtureWrites.at(-1)') == SHORT
                frame.goto(EMBEDDED)
                expect(frame.locator(BADGE)).to_have_count(1)
                payload(copy_text(frame, CANONICAL))
                return evidence
            check('frame navigation cleans old document and revalidates loaded track', navigation)
            def changed_hook():
                remember_frame(page)
                frame.evaluate("navigator.clipboard.writeText=async text=>fixtureWrites.push('third-party:'+text)")
                payload(context_link(frame))
                frame.evaluate("document.querySelector('#canonical').setAttribute('href','/another/new-track')")
                remove(page)
                return cleaned(page, '/another/new-track', False)
            check('cleanup preserves later clipboard and href owners', changed_hook)
            if page.locator('#embedded').count():
                remove(page)
            def skip_frames():
                examples = [
                    ('ordinary', CANONICAL, None),
                    ('extra', EMBEDDED + '/extra', None),
                    ('trailing', EMBEDDED + '/', None),
                    ('incomplete', 'https://soundcloud.com/n/test-artist', None),
                    ('reserved', 'https://soundcloud.com/n/test-artist/sets', None),
                    ('foreign', 'https://foreign.example/n' + TRACK, None),
                    ('sandboxed', EMBEDDED, 'allow-scripts allow-same-origin'),
                ]
                for name, url, sandbox in examples:
                    skipped = attach(page, url, sandbox, name)
                    skipped.wait_for_timeout(100)
                    expect(skipped.locator(BADGE)).to_have_count(0)
                    assert skipped.evaluate('navigator.clipboard.writeText===fixtureClipboard')
                    unchanged_copy(skipped, CANONICAL)
                    skipped.locator("section[aria-label='Track header'] button").click()
                    assert skipped.evaluate('fixtureWrites.at(-1)') == SHORT
                    remove(page, name)
                return [example[0] for example in examples]
            check('unsupported paths, reserved route, foreign and sandboxed frames skipped', skip_frames)
            def nested_skip():
                outer = attach(page, name='outer')
                with page.expect_event('frameattached') as attached:
                    outer.evaluate('''url => {
                        const child=document.createElement('iframe');child.src=url;document.body.append(child);
                    }''', EMBEDDED)
                nested = attached.value
                nested.wait_for_url(EMBEDDED)
                nested.locator('#share-input').wait_for()
                nested.wait_for_timeout(100)
                expect(nested.locator(BADGE)).to_have_count(0)
                assert nested.evaluate('navigator.clipboard.writeText===fixtureClipboard')
                unchanged_copy(nested, CANONICAL)
                remove(page, 'outer')
            check('nested same-origin frame is not adopted', nested_skip)
            def source_invalidation():
                candidate = attach(page, name='candidate')
                expect(candidate.locator(BADGE)).to_have_count(1)
                payload(context_link(candidate))
                remember_frame(page, 'candidate')
                page.locator('#candidate').evaluate("frame=>frame.setAttribute('sandbox','allow-scripts allow-same-origin')")
                evidence = cleaned(page)
                remove(page, 'candidate')
                return evidence
            check('adding sandbox tears down an already adopted frame', source_invalidation)
            def credentialed_src():
                candidate = attach(page, name='credentialed')
                expect(candidate.locator(BADGE)).to_have_count(1)
                payload(context_link(candidate))
                remember_frame(page, 'credentialed')
                page.locator('#credentialed').evaluate("frame=>frame.src='https://fixture:unused@soundcloud.com/n/test-artist/first-track'")
                evidence = cleaned(page)
                remove(page, 'credentialed')
                return evidence
            check('credentialed frame source is not adopted and old hooks are removed', credentialed_src)
            def strict_track_parser():
                page.locator('.playbackSoundBadge__titleLink').evaluate("link=>link.href='https://soundcloud.com/n/test-artist/first-track'")
                expect(page.locator('.memory')).to_have_attribute('aria-label', 'Settings')
                page.locator('.playbackSoundBadge__titleLink').evaluate('link=>link.href=' + json.dumps(CANONICAL))
                number.fill('0.85')
                number.press('Enter')
                expect(number).to_have_value('0.85')
            check('embedded recognition does not broaden ordinary track parsing', strict_track_parser)
            def invalid_hero():
                invalid = attach(page, name='invalidhero')
                expect(invalid.locator(BADGE)).to_have_count(1)
                invalid.locator('section').evaluate("element=>element.setAttribute('aria-label','Other header')")
                expect(invalid.locator(BADGE)).to_have_count(0)
                expect(invalid.locator('.soundcloud-tempo-page-indicator')).to_have_count(0)
                invalid.locator('section').evaluate("element=>element.setAttribute('aria-label','Track header')")
                invalid.locator('img').evaluate("element=>element.src='https://example.com/artworks-untrusted.jpg'")
                expect(invalid.locator('.soundcloud-tempo-page-indicator')).to_have_count(0)
                remove(page, 'invalidhero')
            check('hero scope and artwork-host validation update dynamically', invalid_hero)
            def fallback_artwork():
                candidate = attach(page, name='fallback')
                expect(candidate.locator(BADGE)).to_have_count(1)
                candidate.evaluate('''() => {
                    const header=document.querySelector('section');
                    header.querySelector('.artwork').outerHTML=`
                        <div id="fallback-cover" class="artwork" style="width:336px;height:336px">
                          <img alt="First track" sizes="336px" style="display:block;width:100%;height:100%"
                            src="https://i1.sndcdn.com/avatars-fixture-t500x500.jpg"><div></div>
                        </div>
                        <div id="responsive-cover" hidden>
                          <div id="hidden-cover" style="width:200px;height:200px">
                            <img alt="First track" sizes="200px" style="display:block;width:100%;height:100%"
                              src="https://i1.sndcdn.com/avatars-fixture-t240x240.jpg"><div></div>
                          </div>
                        </div>
                        <div id="avatar-negatives">
                          <div style="width:24px;height:24px"><img alt="Commenter Avatar" sizes="24px" style="width:100%;height:100%" src="https://i1.sndcdn.com/avatars-comment.jpg"></div>
                          <div style="width:24px;height:24px"><img alt="First track" sizes="336px" style="width:100%;height:100%" src="https://i1.sndcdn.com/avatars-own.jpg"></div>
                          <div style="width:160px;height:160px"><img alt="Artist Avatar" sizes="160px" src="https://i1.sndcdn.com/avatars-artist.jpg"></div>
                          <a href="/test-artist"><div style="width:160px;height:160px"><img alt="First track" sizes="160px" src="https://i1.sndcdn.com/avatars-linked.jpg"></div></a>
                          <div style="width:160px;height:160px"><img alt="First track" sizes="160px" src="https://i1.sndcdn.com/avatars-button.jpg"><button>Follow</button></div>
                          <div style="width:160px;height:160px"><img alt="First track" sizes="160px" src="https://i1.sndcdn.com/avatars-caption.jpg"><span>Artist name</span></div>
                          <div style="width:160px;height:160px"><img alt="First track" sizes="160px" src="https://example.com/avatars-foreign.jpg"></div>
                          <div style="width:160px;height:80px"><img alt="First track" sizes="160px" style="width:100%;height:100%" src="https://i1.sndcdn.com/avatars-wide.jpg"></div>
                          <div hidden><img alt="First track" sizes="24px" src="https://i1.sndcdn.com/avatars-small-hidden.jpg"></div>
                          <div hidden><img alt="First track" sizes="(min-width:600px) 160px,24px" src="https://i1.sndcdn.com/avatars-unresolved-size.jpg"></div>
                          <div hidden><img alt="Artist Avatar" sizes="160px" src="https://i1.sndcdn.com/avatars-hidden-artist.jpg"></div>
                        </div>`;
                }''')
                visible = candidate.locator('#fallback-cover .soundcloud-tempo-page-indicator')
                hidden = candidate.locator('#hidden-cover .soundcloud-tempo-page-indicator')
                expect(visible).to_be_visible()
                expect(hidden).to_have_count(1)
                expect(hidden).to_be_hidden()
                expect(visible).to_have_attribute('data-small', 'false')
                expect(hidden).to_have_attribute('data-small', 'false')
                expect(candidate.locator('#avatar-negatives .soundcloud-tempo-page-indicator')).to_have_count(0)
                expect(candidate.locator(BADGE)).to_have_count(2)
                candidate.locator('#fallback-cover').evaluate('element=>element.hidden=true')
                candidate.locator('#responsive-cover').evaluate('element=>element.hidden=false')
                expect(hidden).to_be_visible()
                expect(visible).to_be_hidden()
                expect(hidden).to_have_attribute('data-small', 'false')
                candidate.locator('#fallback-cover').evaluate('element=>element.hidden=false')
                candidate.locator('#responsive-cover').evaluate('element=>element.hidden=true')
                candidate.locator('#hidden-cover img').evaluate("image=>image.sizes='24px'")
                expect(hidden).to_have_count(0)
                candidate.locator('#hidden-cover img').evaluate("image=>image.sizes='200px'")
                expect(hidden).to_have_count(1)
                candidate.locator('#fallback-cover img').evaluate("image=>image.alt='Commenter Avatar'")
                expect(visible).to_have_count(0)
                candidate.locator('#fallback-cover img').evaluate("image=>image.alt='First track'")
                expect(visible).to_be_visible()
                candidate.locator('h1').evaluate("heading=>heading.textContent='Different track'")
                expect(candidate.locator(BADGE)).to_have_count(0)
                candidate.locator('h1').evaluate("heading=>heading.textContent='First track'")
                expect(candidate.locator(BADGE)).to_have_count(2)
                remove(page, 'fallback')
                return {'visibleCoverPixels':336,'hiddenCoverDeclaredPixels':200,
                        'unrelatedAvatars':11,'responsiveSwap':True,'dynamicAltSizesAndTitle':True}
            check('fallback avatar cover follows title and cover structure without marking profile avatars', fallback_artwork)
            check('final single controller', lambda: no_controller(page))
            result['pageErrors'] = errors
            result['shortlinkNetworkRequests'] = [url for url in requests if url.startswith('https://on.soundcloud.com/')]
            assert not result['shortlinkNetworkRequests'], result['shortlinkNetworkRequests']
            assert not errors, errors
        finally:
            context.close()
            browser.close()
            result['contextsClosed'] = True
    result['status'] = 'PASS' if all(case['status'] == 'PASS' for case in result['cases']) else 'FAIL'
    (ROOT / 'test-results' / options.report).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
