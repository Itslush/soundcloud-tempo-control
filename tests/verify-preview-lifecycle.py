import io
import math
import os
import struct
import wave
from playwright.sync_api import sync_playwright
from userscript_fixture import browser_options

BASE = os.environ.get('SITE_URL', 'http://127.0.0.1:4322/')
PROBE = '''
(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
        constructor(options = {}) { super({...options, sampleRate: __SAMPLE_RATE__}); }
    };
    const NativeNode = AudioWorkletNode;
    const connect = AudioNode.prototype.connect;
    const disconnect = AudioNode.prototype.disconnect;
    let created = 0, connected = 0, configured = 0, inputConnected = false, probe, inputProbe;
    const held = [];
    const activations = [];
    const outputs = [];
    window.holdConfiguration = false;
    window.holdActivation = false;
    window.AudioWorkletNode = class extends NativeNode {
        constructor(...args) {
            super(...args);
            created++;
            const post = this.port.postMessage.bind(this.port);
            this.port.postMessage = (...message) => {
                if (message[0][1] === 'configure') {
                    configured++;
                    if (window.holdConfiguration) { held.push(() => post(...message)); return; }
                }
                if (message[0][1] === 'schedule' && message[0][2]?.active && window.holdActivation) {
                    activations.push(() => post(...message));
                    return;
                }
                return post(...message);
            };
        }
    };
    AudioNode.prototype.connect = function(destination, ...args) {
        if (destination instanceof AudioDestinationNode) {
            const analyser = this.context.createAnalyser();
            const silence = this.context.createGain();
            silence.gain.value = 0;
            connect.call(this, analyser, ...args);
            connect.call(analyser, silence);
            connect.call(silence, destination);
            outputs.push({analyser, data:new Float32Array(analyser.fftSize)});
            return destination;
        }
        if (this instanceof NativeNode && window.failOutputConnection)
            throw new Error('Injected output connection failure');
        const result = connect.call(this, destination, ...args);
        if (destination instanceof NativeNode) {
            inputConnected = true;
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 32768;
            const silence = this.context.createGain();
            silence.gain.value = 0;
            connect.call(this, analyser);
            connect.call(analyser, silence);
            connect.call(silence, this.context.destination);
            inputProbe = {analyser, data: new Float32Array(analyser.fftSize)};
        }
        if (this instanceof NativeNode) {
            connected = 1;
            const analyser = this.context.createAnalyser();
            const silence = this.context.createGain();
            silence.gain.value = 0;
            connect.call(this, analyser);
            connect.call(analyser, silence);
            connect.call(silence, this.context.destination);
            probe = {analyser, data: new Float32Array(analyser.fftSize)};
        }
        return result;
    };
    AudioNode.prototype.disconnect = function(...args) {
        if (this instanceof NativeNode) connected = 0;
        if (args[0] instanceof NativeNode) inputConnected = false;
        return disconnect.apply(this, args);
    };
    window.lifecycleState = () => {
        let peak = 0;
        if (probe) {
            probe.analyser.getFloatTimeDomainData(probe.data);
            for (const sample of probe.data.subarray(-128)) peak = Math.max(peak, Math.abs(sample));
        }
        let inputPeak = 0;
        if (inputProbe) {
            inputProbe.analyser.getFloatTimeDomainData(inputProbe.data);
            for (const sample of inputProbe.data) inputPeak = Math.max(inputPeak, Math.abs(sample));
        }
        let outputPeak = 0;
        for (const output of outputs) {
            output.analyser.getFloatTimeDomainData(output.data);
            for (const sample of output.data.subarray(-128)) outputPeak = Math.max(outputPeak,Math.abs(sample));
        }
        return {created, connected, configured, inputConnected, peak, inputPeak, outputPeak, sampleRate:probe?.analyser.context.sampleRate, held: held.length, activations: activations.length};
    };
    window.releaseConfiguration = () => {
        window.holdConfiguration = false;
        while (held.length) held.shift()();
    };
    window.releaseActivation = (all = false) => {
        if (all) window.holdActivation = false;
        if (activations.length) activations.shift()();
    };
})();
'''


def wav(tone):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        rate = 24000
        audio.setparams((1, 2, rate, rate * 16, 'NONE', 'not compressed'))
        content = bytearray(rate * 16 * 2)
        if tone:
            for index in range(rate * 6):
                value = math.sin(2 * math.pi * 440 * index / rate) * 16000
                struct.pack_into('<h', content, index * 2, round(value))
        audio.writeframes(content)
    return output.getvalue()


def pitch(page, preserve):
    page.locator('.select-trigger').click()
    page.get_by_role('option', name='Preserve key' if preserve else 'Natural', exact=True).click()


def ready(page, previous_config, tone=True):
    page.wait_for_function('(previous) => lifecycleState().configured > previous && lifecycleState().connected === 1 && !document.querySelector("audio").preservesPitch', arg=previous_config)
    if tone: page.wait_for_function('lifecycleState().outputPeak > 0.005')
    assert page.evaluate('lifecycleState().created') == 1
    assert 'Using browser key preservation' not in page.locator('#demo-status').inner_text()


def silent_output(page):
    maximum = 0
    samples = []
    for _ in range(35):
        page.wait_for_timeout(8)
        observed = page.evaluate('({...lifecycleState(), time:document.querySelector("audio").currentTime})')
        samples.append(observed)
        maximum = max(maximum, observed['outputPeak'])
    assert maximum < 0.000001, {'stale_output_peak': maximum, 'samples': samples}
    return maximum


def load_file(page, tone):
    page.locator('#preview-loader').evaluate('(element) => element.open = true')
    page.locator('#preview-file').set_input_files({'name': 'tone.wav' if tone else 'silence.wav', 'mimeType': 'audio/wav', 'buffer': wav(tone)})
    page.wait_for_function('document.querySelector("audio").duration === 16 && document.querySelector(".timeline-demo").dataset.playback === "paused"')


with sync_playwright() as runtime:
    browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.add_init_script(PROBE.replace('__SAMPLE_RATE__', os.environ.get('AUDIO_SAMPLE_RATE', '96000')))
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE, wait_until='networkidle')
    load_file(page, True)
    page.locator('#preview-fixed').click()
    page.locator('#demo-speed-number').fill('0.75')
    page.locator('#demo-speed-number').press('Enter')
    pitch(page, True)
    page.locator('#preview-play').click()
    ready(page, 0)
    peaks = []
    for _ in range(5):
        before = page.evaluate('lifecycleState().configured')
        page.locator('#preview-seek').fill('12')
        ready(page, before, False)
        peaks.append(silent_output(page))
        before = page.evaluate('lifecycleState().configured')
        page.locator('#preview-seek').fill('1')
        ready(page, before)
        before = page.evaluate('lifecycleState().configured')
        page.locator('#preview-play').click()
        assert page.evaluate('lifecycleState().connected') == 0
        page.locator('#preview-play').click()
        ready(page, before)
        before = page.evaluate('lifecycleState().configured')
        pitch(page, False)
        assert page.evaluate('lifecycleState().connected') == 0
        pitch(page, True)
        ready(page, before)
    page.locator('#preview-play').click()
    pitch(page, False)
    page.locator('#preview-play').click()
    page.wait_for_function('!document.querySelector("audio").preservesPitch && lifecycleState().outputPeak > 0.005')
    assert page.evaluate('lifecycleState().connected') == 0
    before = page.evaluate('lifecycleState().configured')
    pitch(page, True)
    ready(page, before)
    before = page.evaluate('lifecycleState().configured')
    load_file(page, False)
    page.locator('#preview-play').click()
    ready(page, before, False)
    peaks.append(silent_output(page))
    before = page.evaluate('lifecycleState().configured')
    load_file(page, True)
    page.locator('#preview-play').click()
    ready(page, before)
    pitch(page, False)
    page.evaluate('window.holdConfiguration = true')
    pitch(page, True)
    page.wait_for_function('lifecycleState().held === 1')
    pitch(page, False)
    page.evaluate('releaseConfiguration()')
    page.wait_for_timeout(150)
    assert page.evaluate('lifecycleState().connected') == 0
    assert page.locator('audio').evaluate('(audio) => !audio.preservesPitch')
    before = page.evaluate('lifecycleState().configured')
    pitch(page, True)
    ready(page, before)
    pitch(page, False)
    page.evaluate('window.holdActivation = true')
    pitch(page, True)
    page.wait_for_function('lifecycleState().activations === 1')
    page.locator('#demo-speed-number').fill('0.9')
    page.locator('#demo-speed-number').press('Enter')
    page.evaluate('releaseActivation()')
    page.wait_for_function('lifecycleState().activations === 1 && document.querySelector("audio").playbackRate === 0.9')
    assert page.locator('audio').evaluate('(audio) => audio.preservesPitch')
    page.evaluate('releaseActivation(true)')
    page.wait_for_function('!document.querySelector("audio").preservesPitch && lifecycleState().outputPeak > 0.005')
    assert page.evaluate('lifecycleState().created') == 1
    pitch(page, False)
    page.evaluate('window.failOutputConnection = true')
    pitch(page, True)
    page.wait_for_function('document.querySelector("#demo-status").textContent.includes("Using browser key preservation")')
    assert page.evaluate('!lifecycleState().inputConnected && lifecycleState().connected === 0')
    assert page.locator('audio').evaluate('(audio) => audio.preservesPitch')
    page.wait_for_function('lifecycleState().outputPeak > 0.005')
    assert errors == [], errors
    print({'lifecycle': page.evaluate('lifecycleState()'), 'silence_peaks_after_seek_or_source_change': peaks,
           'stale_configuration_did_not_reconnect': True, 'stale_initial_rate_did_not_activate': True,
           'paused_mode_change_and_partial_connection_failure_recovered': True, 'speaker_output_muted': True})
    browser.close()
