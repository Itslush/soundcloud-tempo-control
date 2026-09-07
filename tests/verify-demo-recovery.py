import io
import os
import wave
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
TRACK = 'https://soundcloud.com/example/tempo-test'


def wav(seconds):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        count = round(8000 * seconds)
        audio.setparams((1, 2, 8000, count, 'NONE', 'not compressed'))
        audio.writeframes(bytes(count * 2))
    return output.getvalue()


def metadata(stream='delayed.wav', preview=False):
    return {'title': 'Tempo test', 'artist': 'Example', 'permalink': TRACK,
            'duration': 180, 'stream': BASE + stream, 'format': 'audio', 'preview': preview}


def audio_response(route):
    content = wav(180)
    headers = {'Accept-Ranges': 'bytes', 'Content-Type': 'audio/wav'}
    requested = route.request.headers.get('range')
    if not requested:
        route.fulfill(body=content, headers=headers)
        return
    first, last = requested.removeprefix('bytes=').split('-')
    first, last = int(first or 0), int(last) if last else len(content) - 1
    last = min(last, len(content) - 1)
    headers['Content-Range'] = f'bytes {first}-{last}/{len(content)}'
    route.fulfill(status=206, body=content[first:last + 1], headers=headers)


def open_loader(page):
    page.locator('#preview-loader').evaluate('(element) => element.open = true')


def copied(page):
    page.locator('#demo-copy').click()
    page.wait_for_function('window.tempoLink !== undefined')
    return page.evaluate('JSON.parse(atob(window.tempoLink.split("SCT1.")[1].replaceAll("-", "+").replaceAll("_", "/")))')


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('Object.defineProperty(navigator, "clipboard", {value: {writeText: async value => {window.tempoLink = value}}})')
    pending = []
    page.route('**/api/resolve?*', lambda route: route.fulfill(json=metadata()))
    page.route('**/delayed.wav', lambda route: pending.append(route))
    page.goto(BASE, wait_until='networkidle')
    open_loader(page)
    page.locator('#preview-url').fill(TRACK)
    page.locator('#preview-link-form button').click()
    expect(page.locator('#preview-play')).to_be_disabled()
    expect(page.locator('#demo-copy')).to_be_disabled()
    page.wait_for_timeout(300)
    assert pending
    assert page.locator('#demo-point-time').input_value() == '18'
    audio_response(pending.pop())
    page.unroute('**/delayed.wav')
    page.route('**/delayed.wav', audio_response)
    expect(page.locator('#demo-copy')).to_be_enabled()
    payload = copied(page)
    assert payload['duration'] == 180
    assert [point['t'] for point in payload['points']] == [0, 60, 135]
    assert page.locator('audio').evaluate('(audio) => audio.paused')
    page.locator('audio').evaluate('(audio) => audio.dispatchEvent(new Event("loadedmetadata"))')
    assert copied(page) == payload

    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('0.7')
    page.locator('#demo-speed-number').press('Enter')
    expect(page.locator('.timeline-demo')).to_have_attribute('data-mode', 'fixed')
    expect(page.locator('#preview-fixed')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#preview-timeline')).to_have_attribute('aria-pressed', 'false')
    assert page.locator('audio').evaluate('(audio) => audio.playbackRate') == 0.7
    page.locator('#preview-seek').fill('40')
    page.wait_for_function('Math.abs(document.querySelector("audio").currentTime - 40) < 0.01')
    page.locator('#preview-compare').click()
    assert page.locator('audio').evaluate('(audio) => audio.playbackRate === 1 && audio.currentTime === 40 && audio.volume === 0.15')
    expect(page.locator('#preview-compare')).to_have_attribute('aria-pressed', 'true')
    page.locator('#preview-compare').click()
    assert page.locator('audio').evaluate('(audio) => audio.playbackRate === 0.7 && audio.currentTime === 40')
    page.locator('#demo-point-rate').fill('0.8')
    page.locator('#demo-point-rate').press('Enter')
    expect(page.locator('.timeline-demo')).to_have_attribute('data-mode', 'fixed')
    assert copied(page)['points'] == [{'t': 0, 'r': 0.7, 'd': 0, 'c': 'instant'}]
    page.locator('#preview-timeline').click()
    expect(page.locator('#preview-fixed-controls')).to_be_hidden()
    expect(page.locator('.timeline-demo')).to_have_attribute('data-mode', 'timeline')
    expect(page.locator('#preview-timeline')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#preview-fixed')).to_have_attribute('aria-pressed', 'false')
    page.locator('#demo-undo').click()
    expect(page.locator('#demo-point-rate')).to_have_value('0.9')
    page.locator('#demo-redo').click()
    expect(page.locator('#demo-point-rate')).to_have_value('0.8')
    page.locator('#preview-reset').click()
    node = page.locator('#demo-nodes .node').nth(2)
    box = node.bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.down()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] - 25, steps=6)
    page.mouse.up()
    assert float(page.locator('#demo-point-rate').input_value()) > 0.9
    page.locator('#demo-undo').click()
    expect(page.locator('#demo-point-rate')).to_have_value('0.9')
    node.focus()
    node.press('Control+Shift+Z')
    assert float(page.locator('#demo-point-rate').input_value()) > 0.9

    page.evaluate('window.headLine = document.querySelector("#demo-playhead line")')
    page.locator('#preview-play').click()
    page.wait_for_function('document.querySelector("audio").currentTime > 0.3')
    page.locator('#preview-play').click()
    assert page.evaluate('window.headLine === document.querySelector("#demo-playhead line")')
    assert page.locator('#demo-playhead > *').count() == 2

    page.unroute('**/api/resolve?*')
    attempts = []
    def failing_then_ready(route):
        attempts.append(route.request.url)
        route.fulfill(json=metadata('missing.wav' if len(attempts) == 1 else 'ready.wav'))
    page.route('**/api/resolve?*', failing_then_ready)
    page.route('**/missing.wav', lambda route: route.fulfill(status=404, body='missing'))
    page.route('**/ready.wav', audio_response)
    open_loader(page)
    page.locator('#preview-link-form button').click()
    expect(page.locator('#preview-play')).to_have_text('Retry')
    expect(page.locator('#demo-copy')).to_be_disabled()
    expect(page.locator('#preview-sample')).to_be_visible()
    expect(page.locator('#preview-loader')).to_have_attribute('open', '')
    expect(page.locator('#preview-url')).to_have_value(TRACK)
    page.locator('#preview-play').click()
    page.wait_for_function('!document.querySelector("audio").paused')
    assert len(attempts) == 2
    expect(page.locator('#demo-copy')).to_be_enabled()
    page.locator('#preview-play').click()

    page.unroute('**/api/resolve?*')
    page.route('**/api/resolve?*', lambda route: route.fulfill(status=502, content_type='text/html', body='<html>Gateway</html>'))
    page.locator('#preview-link-form button').click()
    expect(page.locator('#demo-status')).to_have_text('Track could not be loaded. Retry in a moment.')
    assert 'JSON' not in page.locator('#demo-status').inner_text()
    page.unroute('**/api/resolve?*')
    page.route('**/api/resolve?*', lambda route: route.fulfill(json=metadata('ready.wav', preview=True)))
    page.locator('#preview-link-form button').click()
    expect(page.locator('#preview-play')).to_have_text('Play')
    expect(page.locator('#demo-copy')).to_be_disabled()
    expect(page.locator('#demo-status')).to_contain_text('Full track needed for sharing.')

    page.locator('#preview-file').set_input_files({'name': 'short.wav', 'mimeType': 'audio/wav', 'buffer': wav(0.12)})
    expect(page.locator('#preview-play')).to_be_enabled()
    page.wait_for_function('document.querySelector("#preview-seek").max === "0.12"')
    page.locator('.demo-details').first.evaluate('(element) => element.open = true')
    for index in [1, 2]:
        page.locator('#demo-nodes .node').nth(index).focus()
        assert page.locator('#demo-point-time').evaluate('(input) => Number(input.min) <= input.valueAsNumber && input.valueAsNumber <= Number(input.max)')
        before = float(page.locator('#demo-point-time').input_value())
        page.locator('#demo-point-time').press('ArrowUp')
        assert float(page.locator('#demo-point-time').input_value()) > before
    page.locator('#preview-file').set_input_files({'name': 'zoom.wav', 'mimeType': 'audio/wav', 'buffer': wav(24)})
    page.wait_for_function('document.querySelector("#preview-seek").max === "24"')
    for _ in range(5): page.locator('#zoom-in').click()
    labels = page.locator('#demo-grid text').all_text_contents()[6:]
    assert len(labels) == len(set(labels)), labels
    assert ':' in labels[0] and '.' in labels[0]
    assert float(page.locator('#demo-pan').get_attribute('step')) < 0.02
    assert errors == [], errors
    browser.close()
print('Delayed metadata, stable sharing, stream retry, gateway errors, mode clarity, A/B position, grouped undo, persistent playhead, short timing and zoom precision passed.')
