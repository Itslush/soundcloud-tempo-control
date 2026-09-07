import hashlib
import json
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options


def main():
    result = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Resource-owning Natural output candidate versus continuous native PCM rendering',
        'audio': 'OfflineAudioContext only; muted isolated browser; no device output',
        'sources': {},
        'passed': False,
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        try:
            result['browser'] = browser.version
            page = browser.new_page()
            for file, name in [('rate-clock.mjs', 'createRateWindow'), ('natural-output.mjs', 'createNaturalOutput')]:
                source = (ROOT / 'src/audio' / file).read_text(encoding='utf-8')
                result['sources'][file] = hashlib.sha256(source.encode('utf-8')).hexdigest()
                page.add_script_tag(type='module', content=source+f'\nwindow.{name}={name};')
                page.wait_for_function(f'typeof {name} === "function"')
            page.add_script_tag(path=str(ROOT / 'tests/fixtures/natural-output-probe.js'))
            result.update(page.evaluate('''async () => {
                let timer;
                try {
                    return await Promise.race([
                        naturalOutputProbe(),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Output diagnostic timed out')), 30000); }),
                    ]);
                } finally { clearTimeout(timer); }
            }'''))
        except Exception as error:
            result['error'] = {'name': type(error).__name__, 'message': str(error)[:1500]}
        finally:
            browser.close()
            result['browserClosed'] = True
    (ROOT / 'test-results/natural-output.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
