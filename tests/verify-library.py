import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

from userscript_fixture import userscript_source, browser_options

ROOT = Path(__file__).resolve().parent.parent
TRACK = '/test-artist/first-track'
FIXED = 'soundcloud.tempo.track.%2Ftest-artist%2Ffirst-track'
TIMELINE = 'soundcloud.tempo.timeline.%2Ftest-artist%2Ffirst-track'


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
            context = browser.new_context(viewport={'width': 1050, 'height': 820}, accept_downloads=True)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script(script=userscript_source())
            url = f'http://127.0.0.1:{server.server_port}/tests/fixtures/inline-fixture.html'
            page.goto(url)
            page.evaluate('''() => {
                window.testAudio = new Audio(); testAudio.muted = true;
                Object.defineProperty(testAudio, 'duration', {get: () => 200});
                document.body.append(testAudio);
            }''')
            page.locator('.settings-button').click()
            page.locator('.open-editor').click()
            page.locator('.point-rate').fill('0.8')
            page.locator('.point-rate').press('Tab')
            page.locator('.editor-save').click()
            page.locator('.editor-close').click()
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            expect(page.locator('.saved-count')).to_have_text('1 saved track')
            toggle = page.get_by_role('checkbox', name=f'Use saved timeline for {TRACK}', exact=True)
            expect(toggle).to_be_checked()
            toggle.uncheck()
            expect(page.locator('#rate-number')).to_have_value('1')
            assert page.evaluate('(key) => JSON.parse(localStorage.getItem(key)).enabled', TIMELINE) is False
            toggle.check()
            expect(page.locator('#rate-number')).to_have_value('0.8')
            page.get_by_role('button', name=f'Edit timeline for {TRACK}', exact=True).click()
            expect(page.locator('.point-rate')).to_have_value('0.8')
            page.locator('.editor-close').click()
            page.locator('#rate-number').fill('0.75')
            page.locator('#rate-number').press('Enter')
            page.locator('.memory').click()
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            expect(page.locator('.saved-setting')).to_have_count(2)
            speed = page.get_by_role('checkbox', name=f'Use saved speed for {TRACK}', exact=True)
            speed.uncheck()
            assert page.evaluate('(key) => JSON.parse(localStorage.getItem(key)).enabled', FIXED) is False
            expect(page.locator('#rate-number')).to_have_value('0.75')
            page.locator('.library-backup summary').click()
            with page.expect_download() as download_info:
                page.locator('.backup-export').click()
            exported = json.loads(Path(download_info.value.path()).read_text(encoding='utf-8'))
            assert exported['tracks'][0]['speed'] == {'rate': 0.75, 'enabled': False}
            assert exported['tracks'][0]['timeline']['data']['points'][0]['r'] == 0.8
            exported['tracks'][0]['speed'] = {'rate': 0.65, 'enabled': True}
            exported['tracks'][0]['timeline']['enabled'] = False
            exported['preferences']['outputDb'] = -9

            def upload(value):
                text = value if isinstance(value, str) else json.dumps(value)
                page.locator('.backup-file').set_input_files({'name': 'backup.json', 'mimeType': 'application/json', 'buffer': text.encode()})

            before = page.evaluate('JSON.stringify({...localStorage})')
            upload(exported)
            expect(page.locator('.backup-preview')).to_be_visible()
            expect(page.locator('.backup-confirm')).to_be_focused()
            assert page.evaluate('JSON.stringify({...localStorage})') == before
            page.locator('.backup-cancel').click()
            assert page.evaluate('JSON.stringify({...localStorage})') == before
            upload(exported)
            page.locator('.backup-confirm').click()
            expect(page.locator('.settings-status')).to_have_text('Backup imported.')
            expect(page.locator('.saved-row input[type=number]')).to_have_value('0.65')
            expect(speed).to_be_checked()
            assert page.evaluate('localStorage.getItem("soundcloud.tempo.outputDb")') == '-9'
            expect(page.locator('#output-level')).to_have_value('-9')
            imported = page.evaluate('JSON.stringify({...localStorage})')
            for invalid in ['{invalid', {**exported, 'preferences': {'outputDb': 12}}, {**exported, 'tracks': [{ 'track': 'https://evil.test/a/b', 'speed': {'rate': 1, 'enabled': True}}]}]:
                upload(invalid)
                expect(page.locator('.backup-preview')).to_be_hidden()
                expect(page.locator('.settings-status')).not_to_be_empty()
                assert page.evaluate('JSON.stringify({...localStorage})') == imported
            upload(exported)
            page.evaluate('(key) => localStorage.setItem(key, "0.95")', FIXED)
            page.locator('.backup-confirm').click()
            expect(page.locator('.settings-status')).to_contain_text('changed')
            assert page.evaluate('(key) => localStorage.getItem(key)', FIXED) == '0.95'
            page.locator('.backup-cancel').click()
            page.get_by_role('button', name=f'Remove saved timeline for {TRACK}', exact=True).click()
            expect(page.locator('.saved-setting[data-type=timeline]')).to_have_count(0)
            assert page.evaluate('(key) => localStorage.getItem(key)', TIMELINE) is None
            expect(page.locator('.saved-row')).to_have_count(1)
            page.reload()
            expect(page.locator('#rate-number')).to_have_value('0.95')
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            page.get_by_role('button', name=f'Remove saved speed for {TRACK}', exact=True).click()
            expect(page.locator('.saved-row')).to_have_count(0)
            expect(page.locator('#saved-filter')).to_be_focused()
            page.locator('.saved-undo').click()
            expect(page.locator('.saved-row')).to_have_count(1)
            expect(page.locator('.saved-row input[type=number]')).to_have_value('0.95')
            other = '/other/saved-song'
            other_profile = {**exported['tracks'][0]['timeline']['data'], 'track': other}
            data = {**exported, 'tracks': [{'track': other, 'timeline': {'data': other_profile, 'enabled': False}}], 'preferences': {}}
            page.locator('.library-backup summary').click()
            upload(data)
            page.locator('.backup-confirm').click()
            page.get_by_role('button', name=f'Edit timeline for {other}', exact=True).click()
            expect(page.locator('.editor-track')).to_have_text(other)
            expect(page.locator('.editor-apply-once')).to_be_disabled()
            page.locator('.point-rate').fill('0.7')
            page.locator('.point-rate').press('Tab')
            page.locator('.editor-close').click()
            page.locator('.settings-button').click()
            upload(exported)
            page.locator('.backup-confirm').click()
            page.get_by_role('button', name=f'Edit timeline for {TRACK}', exact=True).click()
            expect(page.locator('.settings-status')).to_contain_text('unsaved timeline')
            page.locator('.open-editor').click()
            expect(page.locator('.editor-track')).to_have_text(other)
            expect(page.locator('.point-rate')).to_have_value('0.7')
            page.locator('.editor-revert').click()
            expect(page.locator('.editor-track')).to_have_text(other)
            expect(page.locator('.point-rate')).to_have_value('0.8')
            page.locator('.editor-close').click()
            page.locator('.settings-button').click()
            page.evaluate('''() => {
                window.getStorage = Storage.prototype.getItem;
                Storage.prototype.getItem = function(key) {
                    if (key.startsWith('soundcloud.tempo.track.')) throw new Error('Blocked');
                    return getStorage.call(this, key);
                };
            }''')
            speed.click()
            expect(speed).to_be_checked()
            expect(page.locator('.settings-status')).to_contain_text('Could not read')
            page.evaluate('() => { Storage.prototype.getItem = getStorage; }')
            second = context.new_page()
            second.goto(url)
            second.evaluate('(key) => localStorage.setItem(key, "0.85")', FIXED)
            expect(page.locator('.saved-row input[type=number]')).to_have_value('0.85')
            second.close()
            for width in [1050, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 820})
                panel = page.locator('#tempo-settings')
                assert panel.evaluate('element => element.scrollWidth <= element.clientWidth'), width
                box = panel.bounding_box()
                assert box['x'] >= 0 and box['x'] + box['width'] <= width, box
                panel.screenshot(path=str(ROOT/f'test-results/library-{width}.png'))
            page.emulate_media(forced_colors='active')
            expect(page.get_by_role('checkbox', name=f'Use saved speed for {TRACK}', exact=True)).to_be_visible()
            assert page.locator('#tempo-settings').evaluate('element => element.scrollWidth <= element.clientWidth')
            page.emulate_media(forced_colors='none')
            page.set_viewport_size({'width': 1050, 'height': 820})
            page.locator('.close-settings').click()
            page.evaluate('''() => {
                for (let index = 0; index < 1000; index++) {
                    localStorage.setItem('soundcloud.tempo.track.' + encodeURIComponent('/bulk/track-' + index), '0.9');
                }
            }''')
            page.locator('.settings-button').click()
            expect(page.locator('.saved-row')).to_have_count(100)
            page.locator('.saved-more').click()
            expect(page.locator('.saved-row')).to_have_count(200)
            page.locator('#saved-filter').fill('bulk/track-999')
            expect(page.locator('.saved-row')).to_have_count(1)
            expect(page.locator('.saved-more')).to_be_hidden()
            assert not errors, errors
            browser.close()
            print(json.dumps({'saved_timeline_and_speed_library': 'passed', 'backup_preview_validation_roundtrip_conflicts': 'passed', 'silent': True, 'errors': errors}))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
