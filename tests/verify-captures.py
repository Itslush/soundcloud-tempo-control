import hashlib
import json
import os
import subprocess
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
evidence = json.loads((ROOT / 'docs/screenshot-evidence.json').read_text(encoding='utf-8'))
assert evidence['deviceScaleFactor'] == 3
assert evidence['muted'] is True
assert evidence['status'] == 'CAPTURED'
assert evidence['track'] == 'https://soundcloud.com/sewerslvt/bring-me-the-horizon-drown-sewerslvt-remix'
artifact_verification = subprocess.run([os.environ.get('NODE', 'node'), str(ROOT / 'tests/capture-artifact.cjs')], check=True, capture_output=True, text=True, timeout=30)
print(artifact_verification.stdout.strip())
assert evidence['contextClosed'] and evidence['recipientContextClosed'] and evidence['browserClosed']
for playback in [evidence['audio'], evidence['recipientAudio']]:
    assert playback['media'] and playback['contexts']
    assert all(item['muted'] and item['volume'] == 0 and item['paused'] for item in playback['media'])
    assert all(item['sinkGain'] == 0 for item in playback['contexts'])
for contexts in [evidence['closedAudioContexts'], evidence['recipientClosedAudioContexts']]:
    assert contexts and all(item['state'] == 'closed' and item['sinkGain'] == 0 for item in contexts)
assert len(evidence['screenshots']) == 11
for capture in evidence['screenshots']:
    assert capture['url'].startswith(evidence['track'])
    image = (ROOT / 'site/public/screenshots' / capture['file']).read_bytes()
    assert hashlib.sha256(image).hexdigest() == capture['sha256'], capture['file']

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context(device_scale_factor=2)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    measurements = []
    for width in [360, 390, 600, 768, 1280, 1440, 1920]:
        page.set_viewport_size({'width': width, 'height': 950})
        page.goto(BASE, wait_until='networkidle')
        links = page.locator('a[data-capture]')
        expect(links).to_have_count(4)
        expect(page.locator('.product-capture figcaption')).to_have_count(0)
        expect(page.locator('#capture-description, .viewer-hint')).to_have_count(0)
        assert page.locator('.product-proof').bounding_box()['y'] < page.locator('#install').bounding_box()['y']
        for link in links.all():
            image = link.locator('img')
            image.scroll_into_view_if_needed()
            image.evaluate('image => image.decode()')
            source = image.evaluate('image => image.currentSrc')
            assert image.get_attribute('width') and image.get_attribute('height')
            assert image.get_attribute('alt')
            assert link.get_attribute('data-description') is None
            if width <= 600 and 'player-controls' not in source:
                assert 'mobile.png' in source or 'timeline-detail.png' in source, source
            link.click()
            expect(page.locator('.capture-viewer')).to_be_visible()
            expect(page.locator('.viewer-image')).to_be_visible()
            expect(page.locator('.viewer-image')).to_have_attribute('alt', image.get_attribute('alt'))
            expect(page.locator('.viewer-stage')).to_have_accessible_name('Full screenshot. Scroll to inspect when zoomed in. Escape closes the viewer.')
            expect(page.locator('.viewer-zoom')).to_have_text('100%')
            focal = [link.get_attribute('data-focus-x'), link.get_attribute('data-focus-y')]
            if all(focal):
                assert page.locator('.viewer-stage').evaluate('''(stage, focal) => {
                  const frame = stage.getBoundingClientRect();
                  const image = stage.querySelector('img').getBoundingClientRect();
                  const x = image.x + Number(focal[0]);
                  const y = image.y + Number(focal[1]);
                  return x >= frame.left && x <= frame.right && y >= frame.top && y <= frame.bottom;
                }''', focal), (width, focal)
            page.locator('.viewer-in').click()
            expect(page.locator('.viewer-zoom')).to_have_text('125%')
            page.locator('.viewer-fit').click()
            assert page.locator('.viewer-stage').evaluate('stage => { const image = stage.querySelector("img").getBoundingClientRect(); return image.width <= stage.clientWidth && image.height <= stage.clientHeight; }'), width
            page.locator('.viewer-actual').click()
            expect(page.locator('.viewer-zoom')).to_have_text('100%')
            page.locator('.viewer-stage').focus()
            page.keyboard.press('Escape')
            expect(page.locator('.capture-viewer')).not_to_be_visible()
            expect(link).to_be_focused()
            assert page.evaluate('document.documentElement.style.overflow') == ''
        assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), width
        measurements.append({'width': width, 'images': page.locator('.product-capture img').evaluate_all('images => images.map(image => ({source: image.currentSrc.split("/").pop(), width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height}))')})
    page.goto(BASE)
    page.route('**/shared-preview.png', lambda route: route.abort())
    page.locator('a[data-capture]').last.click()
    expect(page.locator('.viewer-error')).to_be_visible()
    expect(page.locator('.viewer-fit')).to_be_disabled()
    expect(page.locator('.viewer-in')).to_be_disabled()
    expect(page.locator('.viewer-original')).to_have_attribute('href', BASE + 'screenshots/shared-preview.png')
    page.unroute('**/shared-preview.png')
    page.locator('.viewer-retry').click()
    expect(page.locator('.viewer-image')).to_be_visible()
    page.locator('.viewer-close').click()
    expect(page.locator('a[data-capture]').last).to_be_focused()
    no_js = browser.new_context(java_script_enabled=False)
    fallback = no_js.new_page()
    fallback.goto(BASE)
    expect(fallback.locator('a[data-capture]')).to_have_count(4)
    for link in fallback.locator('a[data-capture]').all():
        assert no_js.request.get(link.get_attribute('href') if link.get_attribute('href').startswith('http') else BASE.rstrip('/') + link.get_attribute('href')).ok
    assert not errors, errors
    browser.close()
    (ROOT / 'test-results/capture-verification.json').write_text(json.dumps(measurements, indent=2) + '\n', encoding='utf-8')
    print('Passed: 4 genuine capture views at 7 widths, responsive sources at DPR 2, focal subject visibility, focus restoration, Escape, zoom, loading failure/retry, no-JS originals and muted provenance.')
