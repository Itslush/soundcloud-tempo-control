import argparse
import base64
import hashlib
import importlib.util
import json
from datetime import datetime, timezone

from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source, userscript_bytes

spec = importlib.util.spec_from_file_location('embedded_fixture', ROOT / 'tests/verify-embedded-track.py')
embedded = importlib.util.module_from_spec(spec)
spec.loader.exec_module(embedded)
NESTED = '<div class="playbackTimeline__duration sc-text-primary sc-text-h5"><span class="sc-visuallyhidden">Duration: 8 minutes 16 seconds</span><span aria-hidden="true">8:16</span></div>'


def shared(link, duration):
    prefix = embedded.CANONICAL + '#sct=SCT1.'
    assert link.startswith(prefix), link
    encoded = link[len(prefix):]
    value = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
    assert value['track'] == embedded.TRACK, value
    assert value['duration'] == duration, value
    assert value['points'][0]['r'] == 0.85, value
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', default='display-duration-report.json')
    options = parser.parse_args()
    result = {'timestampUtc': datetime.now(timezone.utc).isoformat(),
              'userscriptSha256': hashlib.sha256(userscript_bytes()).hexdigest(),
              'topWindowOnlyInjection': True, 'audio': 'No audio loaded or playback; --mute-audio', 'cases': []}
    source = userscript_source()
    top = (ROOT / 'tests/fixtures/inline-fixture.html').read_text(encoding='utf-8').replace(
        '<span class="playbackTimeline__duration">3:21</span>', NESTED)
    assert NESTED in top
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        context = browser.new_context(viewport={'width': 1280, 'height': 900})
        def route(request):
            if request.request.resource_type == 'document':
                request.fulfill(status=200, content_type='text/html',
                                body=top if request.request.frame.parent_frame is None else embedded.CHILD)
            else:
                request.fulfill(status=204, body='')
        context.route('**/*', route)
        context.add_init_script('if(window===window.top){\nnavigator.clipboard.writeText=async text=>{window.durationTopCopy=text;};\n' + source + '\n}')
        page = context.new_page()
        page.set_default_timeout(5000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        def check(name, action):
            try:
                evidence = action()
                result['cases'].append({'name': name, 'status': 'PASS', 'evidence': evidence})
            except Exception as error:
                result['cases'].append({'name': name, 'status': 'FAIL', 'error': str(error)})
        try:
            page.goto(embedded.CANONICAL, wait_until='domcontentloaded')
            page.locator('#rate-number').fill('0.85')
            page.locator('#rate-number').press('Enter')
            page.locator('.settings-button').click()
            page.locator('#copy-tempo-links').check()
            page.locator('.close-settings').click()
            expect(page.locator('audio')).to_have_count(0)
            frame = embedded.attach(page)
            expect(frame.locator(embedded.BADGE)).to_be_visible()
            for name, action in [
                ('nested accessible duration canonical clipboard', lambda: embedded.copy_text(frame, embedded.CANONICAL)),
                ('nested accessible duration context-menu href', lambda: embedded.context_link(frame)),
                ('nested accessible duration trusted native header copy', lambda: native_copy(frame)),
            ]:
                check(name, lambda action=action: shared(action(), 496))
            def clock(markup):
                page.locator('.playbackTimeline__duration').evaluate('(element,markup)=>element.innerHTML=markup', markup)
            def all_paths(duration):
                shared(embedded.copy_text(frame, embedded.CANONICAL), duration)
                shared(embedded.context_link(frame), duration)
                shared(native_copy(frame), duration)
            def editor_copy(duration):
                page.locator('.settings-button').click()
                page.locator('.open-editor').click()
                expect(page.locator('.tempo-editor')).to_be_visible()
                page.evaluate('window.durationTopCopy=undefined')
                page.locator('.editor-link').click()
                page.wait_for_function('typeof durationTopCopy === "string"')
                value = shared(page.evaluate('durationTopCopy'), duration)
                page.locator('.editor-close').click()
                return value
            check('nested accessible duration opens editor with same 496-second draft', lambda: editor_copy(496))
            def accepted_clocks():
                cases = [('8:16', 496), ('1:02:03', 3723), ('8:16.5', 496.5),
                         ('1:02:03.125', 3723.125), (' 0:01 ', 1), ('24:00:00', 86400)]
                for text, duration in cases:
                    clock(text)
                    all_paths(duration)
                    editor_copy(duration)
                return [{'clock': text, 'seconds': duration} for text, duration in cases]
            check('strict plain minute hour fractional and boundary clocks', accepted_clocks)
            def rejects_clocks():
                values = ['', 'Duration: 8 minutes 16 seconds', '8:60', '1:60:00',
                          '8:16junk', '-1:20', 'Infinity', '1e2:03', '1:2', '8',
                          '0:00', '0:00.5', '24:00:00.1', '8:16 8:16',
                          '999999999999999999999999999999999:59',
                          '<span class="sc-visuallyhidden">8:16</span><span aria-hidden="true">invalid</span>']
                for text in values:
                    clock(text)
                    assert embedded.copy_text(frame, embedded.CANONICAL) == embedded.CANONICAL, text
                    assert embedded.context_link(frame) == embedded.CANONICAL, text
                    assert native_copy(frame) in [embedded.CANONICAL, embedded.SHORT], text
                    page.locator('.settings-button').click()
                    page.locator('.open-editor').click()
                    expect(page.locator('.tempo-editor')).to_be_hidden()
                    page.locator('.close-settings').click()
                return values
            check('malformed unavailable and out-of-profile-range clocks never fabricate duration', rejects_clocks)
            def absent_clock():
                page.locator('.playbackTimeline__duration').evaluate('element=>element.remove()')
                assert embedded.copy_text(frame, embedded.CANONICAL) == embedded.CANONICAL
                assert embedded.context_link(frame) == embedded.CANONICAL
                assert native_copy(frame) in [embedded.CANONICAL, embedded.SHORT]
                page.locator('.settings-button').click()
                page.locator('.open-editor').click()
                expect(page.locator('.tempo-editor')).to_be_hidden()
                page.locator('.close-settings').click()
                page.locator('.playbackTimeline').evaluate('(element,html)=>element.insertAdjacentHTML("beforeend",html)', NESTED)
            check('missing duration element cannot create a tempo profile', absent_clock)
            def media_preference():
                page.evaluate('''() => {
                    window.durationFixtureValue=123.456;
                    const audio=document.createElement('audio');audio.muted=true;
                    Object.defineProperty(audio,'duration',{get:()=>window.durationFixtureValue});
                    document.body.append(audio);audio.dispatchEvent(new Event('loadedmetadata',{bubbles:true}));
                }''')
                expect(page.locator('audio')).to_have_js_property('paused', True)
                assert not page.locator('audio').get_attribute('src')
                all_paths(123.456)
                editor_copy(123.456)
                for value in ['NaN', 'Infinity', '0']:
                    page.evaluate('durationFixtureValue=' + value)
                    all_paths(496)
                    editor_copy(496)
                return {'finiteMedia': 123.456, 'displayedFallbackForUnavailableMedia': 496,
                        'audioSource': None, 'played': False}
            check('positive finite media duration wins and unavailable media falls back to visible clock', media_preference)
            result['pageErrors'] = errors
            assert not errors, errors
        finally:
            context.close()
            browser.close()
            result['contextsClosed'] = True
    result['status'] = 'PASS' if all(case['status'] == 'PASS' for case in result['cases']) else 'FAIL'
    (ROOT / 'test-results' / options.report).write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if result['status'] == 'PASS' else 1


def native_copy(frame):
    frame.locator("section[aria-label='Track header'] button").click()
    return frame.evaluate('fixtureWrites.at(-1)')


if __name__ == '__main__':
    raise SystemExit(main())
