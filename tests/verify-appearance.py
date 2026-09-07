import hashlib
import importlib.util
import json
import os

from playwright.sync_api import expect, sync_playwright

from userscript_fixture import ROOT, browser_options, userscript_source

ATTRIBUTE = 'data-tempo-appearance'
KEY = 'soundcloud.tempo.appearance'
TRACK = 'https://soundcloud.com/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'


def theme(page, mode):
    page.locator(f'[name=appearance][value={mode}]').check()
    if mode == 'native':
        expect(page.locator(f'html[{ATTRIBUTE}]')).to_have_count(0)
    else:
        expect(page.locator('html')).to_have_attribute(ATTRIBUTE, mode)


def fixture(browser):
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script(userscript_source())
    context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT / 'tests/fixtures/inline-fixture.html')))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto('https://soundcloud.com/test-artist/first-track')
        expect(page.locator('#rate-slider')).to_be_visible()
        original = page.locator('body').evaluate('el => getComputedStyle(el).backgroundColor')
        page.locator('.settings-button').click()
        page.locator('.appearance-settings summary').click()
        theme(page, 'charcoal')
        expect(page.locator('body')).to_have_css('background-color', 'rgb(17, 17, 17)')
        expect(page.locator('#tempo-settings')).to_have_css('background-color', 'rgb(32, 32, 32)')
        page.evaluate('''() => {
            const frame = document.createElement('iframe');
            frame.id = 'appearance-frame';
            frame.src = 'https://soundcloud.com/n/test-artist/first-track';
            document.querySelector('main').append(frame);
        }''')
        embedded = page.frame_locator('#appearance-frame')
        expect(embedded.locator('html')).to_have_attribute(ATTRIBUTE, 'charcoal')
        expect(embedded.locator('body')).to_have_css('background-color', 'rgb(17, 17, 17)')
        page.locator('[value=charcoal][name=appearance]').press('ArrowRight')
        expect(page.locator('html')).to_have_attribute(ATTRIBUTE, 'oled')
        expect(page.locator('body')).to_have_css('background-color', 'rgb(0, 0, 0)')
        expect(page.locator('#tempo-settings')).to_have_css('background-color', 'rgb(11, 11, 11)')
        expect(embedded.locator('html')).to_have_attribute(ATTRIBUTE, 'oled')
        expect(embedded.locator('body')).to_have_css('background-color', 'rgb(0, 0, 0)')
        page.evaluate('''() => {
            const frame = document.querySelector('#appearance-frame');
            window.detachedAppearanceDocument = frame.contentDocument;
            frame.remove();
        }''')
        page.wait_for_function('!detachedAppearanceDocument.documentElement.hasAttribute("data-tempo-appearance")')
        assert page.evaluate('(key) => localStorage.getItem(key)', KEY) == 'oled'
        page.reload()
        expect(page.locator('html')).to_have_attribute(ATTRIBUTE, 'oled')
        second = context.new_page()
        second.goto('https://soundcloud.com/test-artist/second-track')
        second.locator('.settings-button').click()
        second.locator('.appearance-settings summary').click()
        theme(second, 'charcoal')
        expect(page.locator('html')).to_have_attribute(ATTRIBUTE, 'charcoal')
        theme(second, 'native')
        expect(page.locator(f'html[{ATTRIBUTE}]')).to_have_count(0)
        expect(page.locator('body')).to_have_css('background-color', original)
        second.close()
        page.locator('.settings-button').click()
        page.locator('.appearance-settings summary').click()
        for host_theme in ['dark', 'light']:
            page.locator('body').evaluate('(el, light) => el.classList.toggle("light", light)', host_theme == 'light')
            native = page.locator('body').evaluate('el => getComputedStyle(el).backgroundColor')
            for mode in ['charcoal', 'oled']:
                theme(page, mode)
                for width in [1440, 390]:
                    page.set_viewport_size({'width': width, 'height': 1000})
                    panel = page.locator('#tempo-settings')
                    assert panel.evaluate('el => el.scrollWidth <= el.clientWidth + 1')
                    panel.screenshot(path=str(ROOT / f'test-results/appearance-{host_theme}-{mode}-{width}.png'))
                page.emulate_media(forced_colors='active')
                assert page.locator('body').evaluate('el => getComputedStyle(el).backgroundImage') == 'none'
                page.emulate_media(forced_colors='none')
                theme(page, 'native')
                expect(page.locator('body')).to_have_css('background-color', native)
        assert not errors, errors
        assert page.locator('audio').count() == 0
        return {'fixture': 'passed', 'modes': 3, 'hostThemes': 2, 'widths': [1440, 390], 'crossTab': True, 'reload': True, 'embeddedLifecycle': True, 'audioLoaded': False}
    finally:
        context.close()


def live(browser):
    source = (ROOT / 'src/tempo-appearance.js').read_bytes()
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    context.add_init_script('''
        window.appearanceMedia = new Set();
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function(...args) {
            this.muted = true;
            appearanceMedia.add(this);
            return originalPlay.apply(this, args);
        };
    ''')
    page = context.new_page()
    try:
        page.goto(TRACK, wait_until='domcontentloaded', timeout=45000)
        page.wait_for_function('''() => document.querySelector('.soundTitle__playButtonHero') ||
            [...document.querySelectorAll('iframe')].some(frame => {
                try { return frame.contentDocument?.querySelector('section[aria-label="Track header"]'); }
                catch { return false; }
            })''', timeout=25000)
        helper_spec = importlib.util.spec_from_file_location('player', ROOT / 'tests/verify-buffered-player.py')
        helper = importlib.util.module_from_spec(helper_spec)
        helper_spec.loader.exec_module(helper)
        helper.dismiss_overlays(page, consent_wait=4000)
        expect(page.locator('.auth-modal:visible')).to_have_count(0)
        page.evaluate('appearanceMedia.forEach(media => media.pause())')
        page.add_script_tag(content=source.decode() + '\nwindow.appearanceProbe = createTempoAppearance();')
        baseline = page.locator('body').evaluate('el => ({bg:getComputedStyle(el).backgroundColor, color:getComputedStyle(el).color})')
        native_footer = page.locator('.playControls__inner').evaluate('el => getComputedStyle(el).backgroundColor')
        reports = []
        for mode, background in [('charcoal', 'rgb(17, 17, 17)'), ('oled', 'rgb(0, 0, 0)')]:
            page.evaluate('(mode) => appearanceProbe.setMode(mode)', mode)
            expect(page.locator('body')).to_have_css('background-color', background)
            surface = 'rgb(32, 32, 32)' if mode == 'charcoal' else 'rgb(11, 11, 11)'
            expect(page.locator('.playControls__inner')).to_have_css('background-color', surface)
            expect(page.locator('.playControls__prev')).to_have_css('background-color', surface)
            page.evaluate('''() => {
                window.appearanceReleases = [...document.querySelectorAll('iframe')].flatMap(frame => {
                    try {
                        if (frame.hasAttribute('sandbox') || frame.contentWindow.location.origin !== location.origin ||
                            !frame.contentWindow.location.pathname.startsWith('/n/')) return [];
                        return [appearanceProbe.attachDocument(frame.contentDocument)];
                    } catch { return []; }
                });
            }''')
            for width in [1440, 390]:
                page.set_viewport_size({'width': width, 'height': 1000})
                expect(page.locator('.auth-modal:visible, .onetrust-pc-dark-filter:visible')).to_have_count(0)
                page.screenshot(path=str(ROOT / f'test-results/appearance-live-{mode}-{width}.png'), full_page=False)
            reports.append(page.evaluate('''() => ({
                mode:appearanceProbe.mode(), body:document.body.className,
                background:getComputedStyle(document.body).backgroundColor,
                frames:appearanceReleases.length,
                header:getComputedStyle(document.querySelector('.header__inner')).backgroundColor,
                footer:getComputedStyle(document.querySelector('.playControls__inner')).backgroundColor,
                media:[...appearanceMedia].map(el=>({paused:el.paused,muted:el.muted,loaded:Boolean(el.currentSrc)}))
            })'''))
            page.evaluate('appearanceReleases.forEach(release => release())')
        page.evaluate('appearanceProbe.dispose()')
        restored = page.locator('body').evaluate('el => ({bg:getComputedStyle(el).backgroundColor, color:getComputedStyle(el).color})')
        assert restored == baseline, (restored, baseline)
        expect(page.locator('.playControls__inner')).to_have_css('background-color', native_footer)
        assert all(item['muted'] for report in reports for item in report['media']), reports
        return {'live': 'passed', 'scope': 'Appearance module only, fresh signed-out browser. SoundCloud may autostart after its sign-in prompt closes; all observed media stays muted and is stopped at teardown. No audio-quality or installed-profile claims.', 'moduleSha256': hashlib.sha256(source).hexdigest(), 'reports': reports, 'restored': True}
    finally:
        try:
            page.evaluate('appearanceMedia.forEach(media => { media.muted = true; media.pause(); })')
        except Exception:
            pass
        context.close()


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    result = {'status': 'INCOMPLETE'}
    try:
        if os.environ.get('TEST_APPEARANCE_LIVE_ONLY') != '1':
            result.update(fixture(browser))
        if os.environ.get('TEST_LIVE_APPEARANCE') == '1':
            result['publicRoute'] = live(browser)
        result['status'] = 'PASS'
        print(json.dumps(result))
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        browser.close()
        (ROOT / 'test-results/appearance-verification.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
