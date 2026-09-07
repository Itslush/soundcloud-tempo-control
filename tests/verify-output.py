import hashlib
import sys

from playwright.sync_api import sync_playwright, expect
from userscript_fixture import ROOT, browser_options, userscript_source, tempo_tick_geometry

script = userscript_source()
source_mode = '--source' in sys.argv[1:]
if source_mode:
    opening = '  const outputLevel = (() => {'
    following = '  const wasmAudio = (() => {'
    assert script.count(opening) == 1 and script.count(following) == 1
    start, end = script.index(opening), script.index(following)
    assert end > start
    output_source = (ROOT/'src/tempo-output.js').read_text(encoding='utf-8')
    script = script[:start] + output_source + '\nwindow.outputLevelProbe = outputLevel;\n' + script[end:]

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    context = browser.new_context()
    context.add_init_script('''window.originalVolume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
      window.originalMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');''')
    context.add_init_script(script)
    context.route('https://soundcloud.com/**', lambda route: route.fulfill(path=str(ROOT/'tests/fixtures/inline-fixture.html'), content_type='text/html'))
    page = context.new_page()
    page.goto('https://soundcloud.com/test-artist/first-track')
    page.locator('.settings-button').click()
    page.locator('.advanced-audio summary').click()
    expect(page.locator('#output-level')).to_have_value('-6')
    result = page.evaluate('''() => {
      window.audio = new Audio(); audio.volume = 0.8; audio.playbackRate = 1;
      return [audio.volume, originalVolume.get.call(audio)];
    }''')
    assert result[0] == .8 and abs(result[1] - .8 * 10 ** (-6/20)) < .0001, result
    page.locator('#output-level').fill('-12')
    result = page.evaluate('[audio.volume, originalVolume.get.call(audio)]')
    assert result[0] == .8 and abs(result[1] - .8 * 10 ** (-12/20)) < .0001, result
    if source_mode:
        result = page.evaluate('''async () => {
          const api = outputLevelProbe;
          const values = [];
          const unsubscribe = api.subscribeLevel(audio, value => values.push(value));
          audio.muted = true;
          const synchronous = values.length === 2 && values[1].muted;
          await new Promise(resolve => setTimeout(resolve, 30));
          const deduplicated = values.length === 2;
          const errors = [];
          for (const value of [1n, Symbol(), NaN, Infinity, -1, 2]) {
            let nativeError, patchedError;
            try { originalVolume.set.call(audio, value); } catch (error) { nativeError = error.name; }
            try { audio.volume = value; } catch (error) { patchedError = error.name; }
            errors.push([nativeError, patchedError]);
          }
          const invalidUnchanged = values.length === 2 && audio.volume === .8;
          originalMuted.set.call(audio, false);
          await new Promise(resolve => setTimeout(resolve, 30));
          const nativeObserved = values.length === 3 && !values[2].muted;
          unsubscribe();
          audio.muted = true;
          await new Promise(resolve => setTimeout(resolve, 30));
          const unsubscribed = values.length === 3;
          audio.muted = false;
          return {synchronous, deduplicated, invalidUnchanged, nativeObserved, unsubscribed,
            errors, frozen: Object.isFrozen(api.readLevel(audio)), values};
        }''')
        assert all(result[key] for key in ['synchronous', 'deduplicated', 'invalidUnchanged', 'nativeObserved', 'unsubscribed', 'frozen']), result
        assert all(native and native == patched for native, patched in result['errors']), result
    page.evaluate('audio.volume = 0.4; audio.volume = audio.volume')
    assert abs(page.evaluate('originalVolume.get.call(audio)') - .4 * 10 ** (-12/20)) < .0001
    page.locator('#preserve-key').check()
    assert abs(page.evaluate('originalVolume.get.call(audio)') - .4 * 10 ** (-12/20)) < .0001
    page.locator('#output-level').fill('0')
    assert page.evaluate('originalVolume.get.call(audio)') == .4
    assert page.evaluate('''() => { const video = document.createElement('video'); video.volume = .8; return originalVolume.get.call(video); }''') == .8
    page.locator('#output-level').fill('-9')
    page.reload()
    page.locator('.settings-button').click()
    page.locator('.advanced-audio summary').click()
    expect(page.locator('#output-level')).to_have_value('-9')
    expect(page.locator('#use-wasm')).to_be_checked()
    page.locator('#use-wasm').uncheck()
    page.reload()
    page.locator('.settings-button').click()
    page.locator('.advanced-audio summary').click()
    expect(page.locator('#use-wasm')).not_to_be_checked()
    page.evaluate("localStorage.setItem('soundcloud.tempo.useWasm', 'true'); dispatchEvent(new StorageEvent('storage', {key: 'soundcloud.tempo.useWasm', newValue: 'true'}))")
    expect(page.locator('#use-wasm')).to_be_checked()
    tempo_tick_geometry(page.locator('.ticks'), page.locator('#rate-slider'), 12, intervals=79)
    alignment = page.evaluate('''() => {
      const progress = document.querySelector('.playbackTimeline__progressBar');
      const host = document.querySelector('#soundcloud-tempo-control');
      const slider = host.shadowRoot.querySelector('#rate-slider');
      const a = progress.getBoundingClientRect(), b = slider.getBoundingClientRect();
      return {delta: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
        accent: getComputedStyle(host).getPropertyValue('--tempo-accent').trim(),
        native: getComputedStyle(progress).backgroundColor};
    }''')
    assert alignment['delta'] <= .5 and alignment['accent'] == alignment['native'], alignment
    browser.close()
print('Global output level: persistence, native volume semantics, both pitch modes, no compounding, video isolation and ticks passed.')
if source_mode:
    print(f'Current output source SHA256: {hashlib.sha256((ROOT/"src/tempo-output.js").read_bytes()).hexdigest()}')
    print('Current output source: synchronous mute, native validation, queued event deduplication and unsubscribe passed.')
