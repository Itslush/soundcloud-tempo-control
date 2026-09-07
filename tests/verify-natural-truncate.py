import hashlib
import json
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

from userscript_fixture import ROOT, browser_options


PROBE = r'''async () => {
    const require = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const startFrame = 128;
    const suspendFrame = 2048;
    const cutFrame = 4096;
    const endFrame = 12288;
    const length = endFrame + 128;
    const oldRate = Math.fround(0.85);
    const maximumError = 1e-3;
    const maximumRms = 1e-5;
    const cases = [];
    async function run(sourceRate, outputRate, nextRate, resetControl) {
        const channels = Array.from({length: 2}, (_, channel) =>
            Float32Array.from({length: sourceRate}, (_, frame) =>
                0.2 * Math.sin((frame / sourceRate * (channel ? 720 : 960) + 0.125) * 2 * Math.PI)
                + 0.03 * Math.sin(frame * 1.7)));
        const context = new OfflineAudioContext(2, length, outputRate);
        const referenceContext = new OfflineAudioContext(2, length, outputRate);
        const renderer = createNaturalOutput({context, destination: context.destination});
        const first = createRateWindow({
            outputStartFrame: startFrame, sourceStartFrame: 0,
            sourceSampleRate: sourceRate, outputSampleRate: outputRate,
            frameCount: 8192, rateAt: () => oldRate,
        });
        const second = createRateWindow({
            outputStartFrame: first.outputEndFrame, sourceStartFrame: first.sourceEndFrame,
            sourceSampleRate: sourceRate, outputSampleRate: outputRate,
            frameCount: 8192, rateAt: () => oldRate,
        });
        const changed = createRateWindow({
            outputStartFrame: cutFrame, sourceStartFrame: first.sourceAt(cutFrame),
            sourceSampleRate: sourceRate, outputSampleRate: outputRate,
            frameCount: endFrame - cutFrame, rateAt: () => nextRate,
        });
        const schedule = clock => renderer.schedule({
            clock, sampleRate: sourceRate, pcmStartFrame: 0, channels,
        });
        const referenceBuffer = referenceContext.createBuffer(2, sourceRate, sourceRate);
        channels.forEach((channel, index) => referenceBuffer.copyToChannel(channel, index));
        const referenceNode = referenceContext.createBufferSource();
        referenceNode.buffer = referenceBuffer;
        referenceNode.playbackRate.value = oldRate;
        referenceNode.playbackRate.setValueAtTime(oldRate, (startFrame - 0.5) / outputRate);
        referenceNode.playbackRate.setValueAtTime(Math.fround(nextRate), (cutFrame - 0.5) / outputRate);
        referenceNode.connect(referenceContext.destination);
        referenceNode.start(startFrame / outputRate);
        referenceNode.stop(endFrame / outputRate);
        let before, truncated, rescheduled, suspendedAt, result;
        try {
            schedule(first);
            schedule(second);
            const suspended = context.suspend(suspendFrame / outputRate);
            const rendering = context.startRendering();
            const referenceRendering = referenceContext.startRendering();
            await suspended;
            suspendedAt = context.currentTime * outputRate;
            require(suspendedAt === suspendFrame, 'Offline suspension missed the requested quantum');
            before = renderer.stats();
            require(before.nodes === 4 && before.bufferBytes > 0, 'Initial ownership missing');
            if (resetControl) renderer.reset();
            else renderer.truncate(cutFrame);
            truncated = renderer.stats();
            require(truncated.nodes === (resetControl ? 0 : 2), 'Unexpected retained ownership');
            require(truncated.generation === before.generation + (resetControl ? 1 : 0), 'Unexpected generation change');
            require(resetControl || truncated.lastOutputEndFrame === cutFrame, 'Truncate watermark mismatch');
            const handle = schedule(changed);
            require(handle.outputStartFrame === cutFrame && handle.sourceStartFrame === first.sourceAt(cutFrame), 'Replacement clock mismatch');
            rescheduled = renderer.stats();
            require(rescheduled.nodes <= 4 && rescheduled.bufferBytes < sourceRate * 2 * 4, 'Capture resource bound exceeded');
            await context.resume();
            const [actual, reference] = await Promise.all([rendering, referenceRendering]);
            let peak = 0, square = 0, invalid = 0, peakFrame = 0, cutPeak = 0;
            let gapActualSquare = 0, gapReferenceSquare = 0, referenceSquare = 0;
            let firstMismatch = null;
            for (let channel = 0; channel < 2; channel++) {
                const output = actual.getChannelData(channel);
                const expected = reference.getChannelData(channel);
                for (let frame = 0; frame < length; frame++) {
                    const delta = output[frame] - expected[frame];
                    if (!Number.isFinite(delta)) invalid++;
                    square += delta * delta;
                    referenceSquare += expected[frame] * expected[frame];
                    if (Math.abs(delta) > peak) { peak = Math.abs(delta); peakFrame = frame; }
                    if (frame >= cutFrame - 256 && frame < cutFrame + 256) cutPeak = Math.max(cutPeak, Math.abs(delta));
                    if (firstMismatch === null && Math.abs(delta) >= maximumError)
                        firstMismatch = {frame, channel, actual: output[frame], reference: expected[frame]};
                    if (frame >= suspendFrame && frame < cutFrame) {
                        gapActualSquare += output[frame] * output[frame];
                        gapReferenceSquare += expected[frame] * expected[frame];
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            const ended = renderer.stats();
            renderer.dispose();
            const disposed = renderer.stats();
            const rms = Math.sqrt(square / (length * 2));
            const gapActualRms = Math.sqrt(gapActualSquare / ((cutFrame - suspendFrame) * 2));
            const gapReferenceRms = Math.sqrt(gapReferenceSquare / ((cutFrame - suspendFrame) * 2));
            const referenceRms = Math.sqrt(referenceSquare / (length * 2));
            const matches = invalid === 0 && peak < maximumError && rms < maximumRms;
            const cleanup = ended.nodes === 0 && ended.bufferBytes === 0 &&
                disposed.disposed && disposed.nodes === 0 && disposed.bufferBytes === 0 && disposed.cleanupErrors === 0;
            const controls = referenceRms > 0.02 && gapReferenceRms > 0.02;
            result = {
                sourceRate, outputRate, nextRate, resetControl, length, suspendedAt,
                cutSourceFrame: changed.sourceStartFrame, peak, rms, cutPeak, peakFrame, firstMismatch,
                gapActualRms, gapReferenceRms, referenceRms, invalid, before, truncated, rescheduled,
                ended, disposed, matches, cleanup,
                passed: cleanup && controls && (resetControl ? !matches && gapActualRms === 0 : matches),
            };
        } finally {
            renderer.dispose();
            referenceNode.disconnect();
            referenceNode.buffer = null;
        }
        return result;
    }
    for (const sourceRate of [44100, 48000])
        for (const outputRate of [48000, 96000])
            for (const rate of [0.025, 4]) cases.push(await run(sourceRate, outputRate, rate, false));
    const controls = [];
    for (const outputRate of [48000, 96000]) controls.push(await run(44100, outputRate, 0.025, true));
    return {cases, controls, maximumError, maximumRms, passed: cases.every(item => item.passed) && controls.every(item => item.passed)};
}'''


def main():
    report = {
        'timestampUtc': datetime.now(timezone.utc).isoformat(),
        'scope': 'Future quantum truncation and changed-rate rescheduling against one continuously automated native source',
        'audio': 'OfflineAudioContext only; muted isolated browser; no device output',
        'sources': {},
        'passed': False,
    }
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(**browser_options(), headless=True, args=['--mute-audio'])
        try:
            report['browser'] = browser.version
            page = browser.new_page()
            for filename, name in [('rate-clock.mjs', 'createRateWindow'), ('natural-output.mjs', 'createNaturalOutput')]:
                path = ROOT / 'src/audio' / filename
                source = path.read_text(encoding='utf-8')
                report['sources'][filename] = hashlib.sha256(path.read_bytes()).hexdigest()
                page.add_script_tag(type='module', content=source + f'\nwindow.{name}={name};')
                page.wait_for_function(f'typeof {name} === "function"')
            report.update(page.evaluate('''async probe => {
                let timer;
                try {
                    return await Promise.race([
                        eval('(' + probe + ')')(),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Truncate diagnostic timed out')), 30000); }),
                    ]);
                } finally { clearTimeout(timer); }
            }''', PROBE))
        except Exception as error:
            report['error'] = {'name': type(error).__name__, 'message': str(error)[:2000]}
        finally:
            browser.close()
            report['browserClosed'] = True
    (ROOT / 'test-results/natural-truncate.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
