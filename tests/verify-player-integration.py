import importlib.util
import json
from playwright.sync_api import sync_playwright
from userscript_fixture import ROOT, browser_options, userscript_source

spec = importlib.util.spec_from_file_location('showcase', ROOT / 'tests/capture-showcase.py')
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)

with sync_playwright() as p:
    browser = p.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1080}, device_scale_factor=3)
    page.add_init_script(capture.MUTE + '\n' + userscript_source())
    capture.load_track(page, capture.TRACK)
    metrics = page.evaluate('''() => {
      const progress = document.querySelector('.playbackTimeline__progressBar');
      const host = document.querySelector('#soundcloud-tempo-control');
      const slider = host.shadowRoot.querySelector('#rate-slider');
      const a = progress.getBoundingClientRect(), b = slider.getBoundingClientRect();
      return {centerDelta: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
        progressColor: getComputedStyle(progress).backgroundColor,
        tempoColor: getComputedStyle(host).getPropertyValue('--tempo-accent').trim(),
        progressHeight: a.height};
    }''')
    assert metrics['centerDelta'] <= .5, metrics
    assert metrics['tempoColor'] == metrics['progressColor'], metrics
    page.locator('.playControls__elements').screenshot(path=str(ROOT/'test-results/live-player-alignment.png'))
    page.locator('.settings-button').click()
    page.locator('.advanced-audio summary').click()
    page.locator('#use-wasm').uncheck()
    page.locator('#output-level').fill('-9')
    page.locator('.settings').screenshot(path=str(ROOT/'test-results/live-audio-settings.png'))
    metrics['media'] = capture.media_state(page)
    assert all(item['muted'] and item['paused'] for item in metrics['media'])
    browser.close()
print(json.dumps(metrics, indent=2))
