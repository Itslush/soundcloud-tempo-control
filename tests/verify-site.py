import base64
import os
import json
import io
import wave
from urllib.parse import urljoin, urlparse
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, choose_option, serve_site, text_contrast

server, default_base = serve_site()
BASE = os.environ.get('SITE_URL', default_base)
WALLETS = {
    'BTC': ('Bitcoin', 'bc1qlxmq3afg9vl9n6nkjmn74ngumt3kv962hdapyc'),
    'LTC': ('Litecoin', 'LP3n9wQFgBRYceNrvBkA4rH6E3nN68gSW7'),
    'USDT': ('Ethereum mainnet · ERC-20', '0x24702696C68E1F14bBeBbB7359500aF732CBAe11'),
    'ETH': ('Ethereum mainnet', '0x24702696C68E1F14bBeBbB7359500aF732CBAe11'),
    'SOL': ('Solana', '8pC6F4bWDyj333nCFcQti2CpC1jkSZJ89iJDMJ3MrkYk'),
}
with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    context.add_init_script('if(navigator.clipboard)navigator.clipboard.writeText=async value=>{window.lastCopy=value}')
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    for width in [320, 360, 390, 768, 1440]:
        page.set_viewport_size({'width':width, 'height':1000})
        for route in ['', 'updates/', 'guide/', 'privacy/']:
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
            if not route:
                donation = page.get_by_role('region', name='Donations')
                assert donation.locator('details').get_attribute('open') is None
                donation.locator('summary').focus()
                donation.locator('summary').press('Enter')
                expect(donation.locator('li')).to_have_count(5)
                for coin, (network, address) in WALLETS.items():
                    row = donation.locator(f'li[data-coin="{coin}"]')
                    expect(row.locator('code')).to_have_text(address)
                    expect(row.locator('.wallet-network')).to_have_text(network)
                    button = row.get_by_role('button', name=f'Copy {coin} address')
                    button.focus()
                    assert button.evaluate('el=>getComputedStyle(el).outlineStyle') != 'none'
                    button.press('Enter')
                    expect(row.get_by_role('status')).to_have_text(f'{coin} address copied.')
                    assert page.evaluate('lastCopy') == address
                    bounds = button.bounding_box()
                    assert bounds['width'] >= 44 and bounds['height'] >= 44
                    for text in [row.locator('code'), row.locator('.wallet-network'), button, row.get_by_role('status')]:
                        assert text_contrast(text) >= 4.5
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), width
                donation.locator('.copy-status').evaluate_all('(nodes)=>nodes.forEach(node=>node.textContent="")')
                if width in [320, 390, 1440]:
                    (ROOT / 'test-results').mkdir(exist_ok=True)
                    page.set_viewport_size({'width': width, 'height': 1600})
                    donation.evaluate('el=>window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 160))')
                    donation.screenshot(path=str(ROOT / f'test-results/donations-{width}.png'))
                    page.set_viewport_size({'width': width, 'height': 1000})
    page.goto(BASE, wait_until='networkidle')
    donation = page.get_by_role('region', name='Donations')
    donation.locator('summary').click()
    btc = donation.locator('li[data-coin="BTC"]')
    page.evaluate('()=>{navigator.clipboard.writeText=()=>Promise.reject(new Error("denied"))}')
    btc.get_by_role('button').click()
    expect(btc.get_by_role('status')).to_have_text("Couldn't copy. Select the address and copy it manually.")
    expect(btc.locator('code')).to_be_visible()
    expect(btc.get_by_role('button')).to_be_enabled()
    page.evaluate('()=>{navigator.clipboard.writeText=async value=>{window.lastCopy=value}}')
    btc.get_by_role('button').click()
    expect(btc.get_by_role('status')).to_have_text('BTC address copied.')
    assert page.evaluate('lastCopy') == WALLETS['BTC'][1]
    page.evaluate('()=>{navigator.clipboard.writeText=()=>new Promise(resolve=>{window.finishCopy=resolve})}')
    btc.get_by_role('button').click()
    expect(btc.get_by_role('status')).to_have_text('Copying…')
    expect(btc.get_by_role('button')).to_be_disabled()
    page.evaluate('finishCopy()')
    expect(btc.get_by_role('button')).to_be_enabled()
    page.evaluate('()=>{navigator.clipboard.writeText=async value=>{window.lastCopy=value}}')
    donation.locator('summary').click()
    expect(page.locator('#demo-copy')).to_be_disabled()
    audio_data = io.BytesIO()
    with wave.open(audio_data, 'wb') as audio:
        audio.setparams((1, 2, 24000, 24000 * 24, 'NONE', 'not compressed'))
        audio.writeframes(bytes(48000 * 24))
    context.route('**/preview-fixture.wav', lambda route: route.fulfill(body=audio_data.getvalue(), content_type='audio/wav'))
    context.route('**/api/resolve?*', lambda route: route.fulfill(json={
        'title': 'Example audio', 'artist': 'Test fixture', 'duration': 24,
        'permalink': 'https://soundcloud.com/example/audio',
        'stream': BASE + 'preview-fixture.wav', 'format': 'audio', 'preview': False,
    }))
    page.locator('#preview-loader summary').click()
    page.locator('#preview-url').fill('https://soundcloud.com/example/audio')
    page.locator('#preview-link-form button').click()
    expect(page.locator('#demo-copy')).to_be_enabled()
    page.wait_for_function('document.querySelector("audio").readyState >= 1')
    page.locator('#preview-loader summary').click()
    page.locator('.point-rate').fill('0.85')
    page.locator('.point-rate').press('Tab')
    choose_option(page.locator('.editor-pitch'), 'preserve')
    page.locator('#demo-copy').click()
    assert '/share/#sct=SCT1.' in page.evaluate('lastCopy')
    code = page.evaluate('lastCopy').split('SCT1.')[1]
    data = json.loads(base64.urlsafe_b64decode(code+'='*(-len(code)%4)))
    assert data['track'] == '/example/audio'
    assert data['pitch'] == 'preserve'
    assert data['points'][0]['r'] == .85
    page.locator('.editor-key-shift').fill('-3')
    page.locator('.editor-key-shift').press('Tab')
    page.locator('#demo-copy').click()
    code = page.evaluate('lastCopy').split('SCT1.')[1]
    assert json.loads(base64.urlsafe_b64decode(code+'='*(-len(code)%4)))['keyShift'] == -3
    page.locator('.zoom-in').click()
    expect(page.locator('.zoom-label')).to_have_text('Time zoom 2×')
    page.locator('.editor-pan').fill('0')
    page.locator('.zoom-out').click()
    expect(page.locator('.editor-pan')).to_be_disabled()
    node = page.locator('.point').first
    node.focus()
    node.press('ArrowDown')
    expect(page.locator('.point-rate')).to_have_value('0.825')
    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('3')
    page.locator('#demo-speed-number').press('Tab')
    expect(page.locator('#demo-speed')).to_have_value('2')
    page.locator('#demo-speed').dblclick()
    expect(page.locator('#demo-speed-number')).to_have_value('1')
    page.evaluate('()=>{navigator.clipboard.writeText=()=>Promise.reject(new Error("denied"))}')
    page.locator('#demo-copy').click()
    expect(page.locator('#demo-copy-fallback')).to_be_visible()
    assert context.request.get(BASE+'support/').status == 404
    page.goto(BASE+'privacy/')
    expect(page.get_by_text('Optional support', exact=True)).to_have_count(0)
    assert page.locator('a[href*="paypal"]').count() == 0
    no_js = browser.new_context(java_script_enabled=False)
    offline = no_js.new_page()
    offline.goto(BASE)
    expect(offline.get_by_role('link', name='Install userscript', exact=True).first).to_be_visible()
    offline.locator('.donations summary').click()
    for coin, (_, address) in WALLETS.items():
        row = offline.locator(f'.donations li[data-coin="{coin}"]')
        expect(row.locator('code')).to_have_text(address)
        expect(row.locator('code')).to_be_visible()
        expect(row.locator('button')).to_be_hidden()
    script = context.request.get(BASE+'downloads/soundcloud-tempo-control.user.js')
    assert script.body() == (ROOT/'dist/soundcloud-tempo-control.user.js').read_bytes()
    assert errors == [], errors
    browser.close()
server.shutdown()
print('Website: 4 content routes at 5 widths, local links, screenshot assets, exact download, keyboard/rate/zoom/share controls, donation addresses/networks/copy/retry, clipboard failure, no-JS download and addresses passed.')
