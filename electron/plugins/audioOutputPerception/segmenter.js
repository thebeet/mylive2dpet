/** Frame PCM16 mono into bounded segments, gated by short-term audio energy. */
class AudioSegmenter {
  constructor(options, onSegment) {
    this.options = options;
    this.onSegment = onSegment;
    this.frameBytes = Math.round(options.sampleRate * options.frameMs / 1000) * 2;
    this.reset();
  }

  reset() {
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.frames = [];
    this.speechMs = 0;
    this.quietMs = 0;
    this.startedAt = 0;
  }

  push(chunk, receivedAt = Date.now()) {
    this.pending = Buffer.concat([this.pending, chunk]);
    // parec may deliver many frames at once; preserve their relative timestamps.
    const totalFrames = Math.floor(this.pending.length / this.frameBytes);
    let index = 0;
    while (this.pending.length >= this.frameBytes) {
      const frame = Buffer.from(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
      const frameAt = receivedAt - (totalFrames - ++index) * this.options.frameMs;
      this.acceptFrame(frame, frameAt);
    }
  }

  acceptFrame(frame, frameAt) {
    let squares = 0;
    for (let offset = 0; offset < frame.length; offset += 2) {
      const sample = frame.readInt16LE(offset) / 32768;
      squares += sample * sample;
    }
    const rms = Math.sqrt(squares / (frame.length / 2));
    const active = 20 * Math.log10(Math.max(rms, 1e-8)) >= this.options.speechThresholdDb;

    if (this.frames.length === 0 && !active) {
      this.preRoll.push(frame);
      const count = Math.ceil(this.options.preRollMs / this.options.frameMs);
      if (this.preRoll.length > count) this.preRoll.shift();
      return;
    }

    if (this.frames.length === 0) {
      this.frames = this.preRoll;
      this.preRoll = [];
      this.startedAt = frameAt - this.frames.length * this.options.frameMs;
    }
    this.frames.push(frame);
    if (active) {
      this.speechMs += this.options.frameMs;
      this.quietMs = 0;
    } else {
      this.quietMs += this.options.frameMs;
    }

    const durationMs = this.frames.length * this.options.frameMs;
    if (this.quietMs >= this.options.silenceMs || durationMs >= this.options.maxSegmentMs) {
      const segment = {
        pcm: Buffer.concat(this.frames),
        capturedAt: new Date(this.startedAt).toISOString(),
        endedAt: new Date(frameAt + this.options.frameMs).toISOString(),
        durationMs,
      };
      const enoughSpeech = this.speechMs >= this.options.minSpeechMs;
      this.frames = [];
      this.speechMs = 0;
      this.quietMs = 0;
      if (enoughSpeech) this.onSegment(segment);
    }
  }
}

function pcmToWav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = { AudioSegmenter, pcmToWav };
