import base64
import os
import json
import io
import wave
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    context.add_init_script('if(navigator.clipboard)navigator.clipboard.writeText=async value=>{window.lastCopy=value}')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    for width in [320, 360, 390, 768, 1440]:
        page.set_viewport_size({'width':width, 'height':1000})
        for route in ['', 'support/', 'updates/', 'guide/', 'privacy/']:
            response = page.goto(BASE+route, wait_until='networkidle')
            assert response.ok
            assert page.locator('h1').count() == 1
            assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), (width, route)
            for href in page.locator('a[href]').evaluate_all('(links)=>links.map(a=>a.href)'):
                if not href.startswith(BASE):
                    continue
                target = href.split('#')[0]
                assert context.request.get(target).ok, target
            for image in page.locator('img[src]').all():
                image.scroll_into_view_if_needed()
                expect(image).to_be_visible()
                image.evaluate('image=>image.decode()')
    page.goto(BASE, wait_until='networkidle')
    expect(page.locator('#demo-copy')).to_be_disabled()
    audio_data = io.BytesIO()
    with wave.open(audio_data, 'wb') as audio:
        audio.setparams((1, 2, 24000, 24000, 'NONE', 'not compressed'))
        audio.writeframes(bytes(48000))
    context.route('**/preview-fixture.wav', lambda route: route.fulfill(body=audio_data.getvalue(), content_type='audio/wav'))
    context.route('**/api/resolve?*', lambda route: route.fulfill(json={
        'title': 'Example audio', 'artist': 'Test fixture', 'duration': 1,
        'permalink': 'https://soundcloud.com/example/audio',
        'stream': BASE + 'preview-fixture.wav', 'format': 'audio', 'preview': False,
    }))
    page.locator('#preview-loader summary').click()
    page.locator('#preview-url').fill('https://soundcloud.com/example/audio')
    page.locator('#preview-link-form button').click()
    expect(page.locator('#demo-copy')).to_be_enabled()
    page.wait_for_function('document.querySelector("audio").readyState >= 1')
    page.locator('#preview-loader summary').click()
    page.locator('#demo-point-rate').fill('0.85')
    page.locator('#demo-point-rate').press('Tab')
    page.locator('.select-trigger').click()
    page.get_by_role('option', name='Preserve key', exact=True).click()
    page.locator('#demo-copy').click()
    code = page.evaluate('lastCopy').split('SCT1.')[1]
    data = json.loads(base64.urlsafe_b64decode(code+'='*(-len(code)%4)))
    assert data['track'] == '/example/audio'
    assert data['pitch'] == 'preserve'
    assert data['points'][-1]['r'] == .85
    page.locator('#zoom-in').click()
    expect(page.locator('#demo-zoom')).to_have_text('Time zoom 2×')
    page.locator('#demo-pan').fill('0')
    page.locator('#zoom-out').click()
    expect(page.locator('.demo-pan')).to_be_hidden()
    node = page.locator('#demo-nodes .node').first
    node.focus()
    node.press('ArrowDown')
    expect(page.locator('#demo-point-rate')).to_have_value('0.975')
    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('3')
    page.locator('#demo-speed-number').press('Tab')
    expect(page.locator('#demo-speed')).to_have_value('2')
    page.locator('#demo-speed').dblclick()
    expect(page.locator('#demo-speed-number')).to_have_value('1')
    page.evaluate('()=>{navigator.clipboard.writeText=()=>Promise.reject(new Error("denied"))}')
    page.locator('#demo-copy').click()
    expect(page.locator('#demo-copy-fallback')).to_be_visible()
    page.goto(BASE+'support/')
    expect(page.get_by_text('Donations aren’t enabled yet.')).to_be_visible()
    assert page.locator('a[href*="paypal"]').count() == 0
    no_js = browser.new_context(java_script_enabled=False)
    offline = no_js.new_page()
    offline.goto(BASE)
    expect(offline.get_by_role('link', name='Install userscript', exact=True).first).to_be_visible()
    script = context.request.get(BASE+'downloads/soundcloud-tempo-control.user.js')
    assert script.body() == (ROOT/'dist/soundcloud-tempo-control.user.js').read_bytes()
    assert errors == [], errors
    browser.close()
print('Website: 5 routes at 5 widths, local links, screenshot assets, exact download, keyboard/rate/zoom/share controls, clipboard failure, no-JS download and unconfigured donations passed.')
