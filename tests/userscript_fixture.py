import hashlib
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
(ROOT/'test-results').mkdir(exist_ok=True)


def browser_options():
    configured = os.environ.get('CHROME_PATH')
    if configured:
        return {'executable_path': configured}
    installed = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    return {'executable_path': str(installed)} if installed.exists() else {}


def tempo_tick_geometry(ruler, slider, thumb_width, intervals=35):
    result = ruler.evaluate('''ruler => {
        const matrix = ruler.getScreenCTM();
        const paths = [...ruler.querySelectorAll('path')];
        const positions = [...new Set(paths.flatMap(path =>
            [...path.getAttribute('d').matchAll(/M(\\d+) 0v[\\d.]+/g)].map(match => +match[1])
        ))].sort((a, b) => a - b);
        return {
            positions,
            centers: positions.map(x => new DOMPoint(x, 0).matrixTransform(matrix).x),
            strokes: paths.map(path => getComputedStyle(path).vectorEffect),
        };
    }''')
    assert result['positions'] == list(range(intervals + 1)), result
    assert all(stroke == 'non-scaling-stroke' for stroke in result['strokes']), result
    centers = result['centers']
    gaps = [right - left for left, right in zip(centers, centers[1:])]
    assert max(gaps) - min(gaps) < 0.000001, gaps
    bounds = slider.bounding_box()
    zoom = slider.evaluate('element => element.getBoundingClientRect().width / parseFloat(getComputedStyle(element).width)')
    half_thumb = thumb_width * zoom / 2
    assert abs(centers[0] - bounds['x'] - half_thumb) < 0.05, result
    assert abs(centers[-1] - bounds['x'] - bounds['width'] + half_thumb) < 0.05, result
    minimum = float(slider.get_attribute('min'))
    maximum = float(slider.get_attribute('max'))
    normal_index = round(intervals * (1 - minimum) / (maximum - minimum))
    assert abs(centers[normal_index] - (bounds['x'] + half_thumb + (bounds['width'] - half_thumb * 2) * (1 - minimum) / (maximum - minimum))) < 0.05, result
    normal_tick = ruler.locator('.normal-tick')
    if normal_tick.count():
        assert normal_tick.get_attribute('d') == f'M{normal_index} 0v5'
    return {'gap': gaps[0], 'endpoints': [centers[0], centers[-1]]}


def text_contrast(element):
    colors = element.evaluate('''element => {
        const foreground = getComputedStyle(element).color;
        let ancestor = element;
        while (ancestor) {
            const background = getComputedStyle(ancestor).backgroundColor;
            if (background !== 'rgba(0, 0, 0, 0)') return [foreground, background];
            ancestor = ancestor.parentElement || ancestor.getRootNode().host;
        }
        throw new Error('No opaque background found');
    }''')

    def luminance(color):
        values = [float(value) for value in re.findall(r'[\d.]+', color)]
        assert len(values) == 3 or values[3] == 1, color
        channels = [value / 255 for value in values[:3]]
        linear = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in channels]
        return sum(value * weight for value, weight in zip(linear, [.2126, .7152, .0722]))

    light, dark = sorted(map(luminance, colors), reverse=True)
    return (light + .05) / (dark + .05)


def userscript_bytes(path=None):
    candidate = os.environ.get('TEMPO_TEST_ARTIFACT') if path is None else None
    source = Path(path) if path is not None else ROOT / (candidate or 'dist/soundcloud-tempo-control.user.js')
    data = source.read_bytes()
    if candidate and hashlib.sha256(data).hexdigest() != os.environ.get('TEMPO_TEST_ARTIFACT_SHA256'):
        raise ValueError('Candidate userscript checksum mismatch or missing expected checksum')
    return data


def userscript_source(path=None):
    script = userscript_bytes(path).decode('utf-8')
    if '// @require' in script:
        metadata = json.loads((ROOT/'vendor/signalsmith/signalsmith.json').read_text(encoding='utf-8'))
        library = (ROOT/'vendor/signalsmith'/metadata['file']).read_bytes()
        if hashlib.sha256(library).hexdigest() != metadata['sha256']:
            raise ValueError('Signalsmith test dependency checksum mismatch')
        if metadata['url'] not in script:
            raise ValueError('Userscript dependency does not match the test lock')
        script = library.decode('utf-8')+'\n;\n'+script
    return '''if (window.top === window && (
      (location.protocol === 'https:' && ['soundcloud.com','m.soundcloud.com'].includes(location.hostname)) ||
      (location.protocol === 'http:' && ['127.0.0.1','localhost'].includes(location.hostname))
    )) {\n''' + script + '\n}'
