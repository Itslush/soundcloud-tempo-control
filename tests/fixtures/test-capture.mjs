export function encodeWave(channels, sampleRate, gain = 1) {
  const length = channels[0].length;
  const buffer = new ArrayBuffer(44 + length * channels.length * 4);
  const view = new DataView(buffer);
  const label = (offset, value) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  label(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 4, true);
  view.setUint16(32, channels.length * 4, true);
  view.setUint16(34, 32, true);
  label(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  for (let frame = 0; frame < length; frame++)
    for (let ch = 0; ch < channels.length; ch++)
      view.setFloat32(
        44 + (frame * channels.length + ch) * 4,
        channels[ch][frame] * gain,
        true,
      );
  return buffer;
}

export function encodeBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}

export async function browserBaseline(fixture, offset, rate) {
  const context = new AudioContext({ sampleRate: 48000 });
  const media = new Audio();
  const frames = Math.ceil((6 / rate) * context.sampleRate);
  const moduleUrl = URL.createObjectURL(
    new Blob(
      [
        `
    registerProcessor('test-capture', class extends AudioWorkletProcessor {
      constructor() { super(); this.channels = [new Float32Array(${frames}), new Float32Array(${frames})]; this.cursor=0; this.started=false; }
      process(inputs) {
        const input=inputs[0];
        if(!input?.[0] || this.cursor>=this.channels[0].length)return true;
        for(let i=0;i<input[0].length && this.cursor<this.channels[0].length;i++) {
          if(!this.started && input.some(c=>Math.abs(c[i])>1e-7))this.started=true;
          if(!this.started)continue;
          for(let ch=0;ch<2;ch++)this.channels[ch][this.cursor]=input[Math.min(ch,input.length-1)][i];
          this.cursor++;
        }
        if(this.cursor===this.channels[0].length) {
          this.port.postMessage(this.channels);this.cursor++;
        }
        return true;
      }
    });
  `,
      ],
      { type: "text/javascript" },
    ),
  );
  const pcm = Array.from({ length: 2 }, (_, ch) =>
    fixture.getChannelData(ch).slice(offset * 48000, (offset + 8) * 48000),
  );
  const mediaUrl = URL.createObjectURL(
    new Blob([encodeWave(pcm, 48000)], { type: "audio/wav" }),
  );
  let timer;
  try {
    await context.audioWorklet.addModule(moduleUrl);
    const recorder = new AudioWorkletNode(context, "test-capture");
    const source = context.createMediaElementSource(media);
    const headroom = context.createGain();
    headroom.gain.value = 0.5;
    const mute = context.createGain();
    mute.gain.value = 0;
    source
      .connect(headroom)
      .connect(recorder)
      .connect(mute)
      .connect(context.destination);
    const captured = new Promise((resolve, reject) => {
      recorder.port.onmessage = (event) => resolve(event.data);
      recorder.onprocessorerror = () =>
        reject(new Error("Capture processor failed"));
      timer = setTimeout(
        () => reject(new Error("Browser capture timed out")),
        30000,
      );
    });
    media.src = mediaUrl;
    media.playbackRate = rate;
    media.preservesPitch = true;
    await context.resume();
    await media.play();
    const channels = await captured;
    let peak = 0,
      energy = 0,
      invalid = 0,
      over = 0;
    for (const channel of channels)
      for (const sample of channel) {
        peak = Math.max(peak, Math.abs(sample));
        energy += sample * sample;
        if (!Number.isFinite(sample)) invalid++;
        if (Math.abs(sample) > 1) over++;
      }
    return {
      rate,
      peak,
      rms: Math.sqrt(energy / (frames * 2)),
      invalid,
      over,
      preview: encodeBase64(encodeWave(channels, 48000)),
    };
  } finally {
    clearTimeout(timer);
    media.pause();
    media.removeAttribute("src");
    media.load();
    await context.close();
    URL.revokeObjectURL(moduleUrl);
    URL.revokeObjectURL(mediaUrl);
  }
}
