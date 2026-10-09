import io
import math
import struct
import wave
from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, serve_site, choose_option

server, base = serve_site()
(ROOT / 'test-results').mkdir(exist_ok=True)
sample = io.BytesIO()
with wave.open(sample, 'wb') as audio:
    audio.setparams((1, 2, 48000, 48000 * 24, 'NONE', 'not compressed'))
    audio.writeframes(b''.join(struct.pack('<h', round(6000 * math.sin(i * 2 * math.pi * 440 / 48000))) for i in range(48000 * 24)))

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script('''(() => {
      const connect = AudioNode.prototype.connect;
      window.meters = [];
      AudioNode.prototype.connect = function(target, ...args) {
        if (target instanceof AudioDestinationNode) {
          const meter = this.context.createAnalyser(); meter.fftSize = 32768;
          const mute = this.context.createGain(); mute.gain.value = 0;
          connect.call(this, meter); connect.call(meter, mute); connect.call(mute, target);
          meters.push(meter); return target;
        }
        return connect.call(this, target, ...args);
      };
      window.frequency = () => {
        let peak = -Infinity, frequency = 0;
        for (const meter of meters) {
          const bins = new Float32Array(meter.frequencyBinCount); meter.getFloatFrequencyData(bins);
          for (let i = 1; i < bins.length; i++) if (bins[i] > peak) {
            peak = bins[i]; frequency = i * meter.context.sampleRate / meter.fftSize;
          }
        }
        return frequency;
      };
    })();''')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base, wait_until='networkidle')
    expect(page.locator('#site-stars, #site-star-speed, .star-settings')).to_have_count(0)
    advanced = page.locator('.editor-advanced')
    expect(advanced.locator('.editor-key-shift')).to_be_hidden()
    page.locator('.point').first.focus()
    page.locator('.point').first.press('Enter')
    expect(advanced.locator('.point-rate')).to_be_focused()
    advanced.locator('summary').click()
    advanced.locator('summary').focus()
    advanced.locator('summary').press('Enter')
    expect(advanced.locator('.editor-key-shift')).to_be_visible()
    volume = page.locator('#preview-volume')
    assert volume.evaluate('el=>getComputedStyle(el).backgroundImage') != 'none'
    expect(volume).to_have_css('--range-thumb-opacity', '1')
    assert volume.bounding_box()['height'] >= 44
    volume.fill('0.22')
    volume.dispatch_event('input')
    assert page.locator('audio').evaluate('el=>el.volume') == .22
    page.locator('#preview-loader summary').click()
    page.locator('#preview-file').set_input_files({'name': 'tone.wav', 'mimeType': 'audio/wav', 'buffer': sample.getvalue()})
    expect(page.locator('#preview-play')).to_have_text('Play')
    choose_option(page.locator('.editor-pitch'), 'preserve')
    page.locator('.editor-key-shift').fill('-3.5')
    page.locator('.editor-key-shift').press('Tab')
    page.locator('#preview-play').click()
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-3.5 / 12)) < 4', timeout=10000)
    page.locator('.editor-key-shift').fill('-6')
    page.locator('.editor-key-shift').press('Tab')
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-6 / 12)) < 4')
    page.locator('#preview-compare').click()
    page.wait_for_function('Math.abs(frequency() - 440) < 4')
    page.locator('#preview-compare').click()
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-6 / 12)) < 4')
    page.locator('#preview-fixed').click()
    expect(page.locator('#demo-shared-editor')).to_be_hidden()
    page.get_by_role('button', name='Increase tempo', exact=True).click()
    expect(page.locator('#demo-speed-number')).to_have_value('1.025')
    page.get_by_role('button', name='Decrease tempo', exact=True).click()
    expect(page.locator('#demo-speed-number')).to_have_value('1')
    page.locator('#demo-key-shift').fill('3')
    page.locator('#demo-key-shift').press('Tab')
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (3 / 12)) < 4')
    page.locator('#demo-key-slider').focus()
    page.locator('#demo-key-slider').press('ArrowRight')
    expect(page.locator('#demo-key-shift')).to_have_value('3.5')
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (3.5 / 12)) < 4')
    for width in [320, 390, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        rows = page.locator('.fixed-adjustment')
        sizes = rows.locator('.number-stepper').evaluate_all('els=>els.map(el=>({w:el.offsetWidth,h:el.offsetHeight}))')
        assert sizes[0] == sizes[1], sizes
        for slider in rows.locator('input[type=range]').all():
            assert slider.evaluate('el=>getComputedStyle(el).backgroundImage') != 'none'
            expect(slider).to_have_css('--range-thumb-opacity', '1')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('#preview-fixed-controls').scroll_into_view_if_needed()
        page.screenshot(path=str(ROOT / f'test-results/site-fixed-{width}.png'))
    page.locator('#preview-timeline').click()
    expect(page.locator('.editor-apply-once')).to_be_hidden()
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-6 / 12)) < 4')
    page.locator('[data-lane=pitch]').click()
    graph = page.locator('.editor-graph').bounding_box()
    page.mouse.dblclick(graph['x'] + graph['width'] * .65, graph['y'] + graph['height'] * .4)
    page.locator('.point-time').fill('4')
    page.locator('.point-time').press('Tab')
    page.locator('.point-rate').fill('2')
    page.locator('.point-rate').press('Tab')
    choose_option(page.locator('.point-curve'), 'instant')
    page.locator('#preview-seek').fill('1')
    page.locator('#preview-seek').dispatch_event('input')
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (-6 / 12)) < 4')
    page.locator('#preview-seek').fill('5')
    page.locator('#preview-seek').dispatch_event('input')
    page.wait_for_function('Math.abs(frequency() - 440 * 2 ** (2 / 12)) < 4')
    page.locator('#preview-play').click()
    page.locator('[data-lane=tempo]').click()
    page.locator('#preview-loader summary').click()
    advanced.locator('summary').click()
    for width in [320, 390, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('.editor-graph').scroll_into_view_if_needed()
        page.screenshot(path=str(ROOT / f'test-results/site-polish-{width}.png'))
    assert not errors, errors
    browser.close()
server.shutdown()
print('PASS: matching sliders, visible volume, keyboard Advanced disclosure, fractional pitch and automation audio, independent modes, original comparison and mobile layout. Audio was captured through a silent destination.')
