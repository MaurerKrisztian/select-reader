import { SAMPLE_RATE, type ReaderState } from "../shared/types.js";
import { splitIntoChunks, splitIntoSentences, type Chunk } from "./chunks.js";

export interface ReaderOptions {
  /** Start speaking after the first chunk instead of waiting for the whole text. */
  streamChunks: boolean;
  firstChunkSentences: number;
  nextChunkSentences: number;
}

export interface ReaderHooks {
  /** Turns text into audio samples, or null if that failed or was cancelled. */
  synthesize(text: string): Promise<Float32Array | null>;
  /** Drops speech that is still being generated. */
  cancel(): void;
  onStateChange(state: ReaderState): void;
  /** Called when a chunk starts playing. */
  onChunk(chunk: Chunk, text: string): void;
}

/** Going back within this many seconds of a sentence's start goes to the sentence before. */
const RESTART_SECONDS = 2;

/**
 * Reads text aloud: splits it into chunks, asks for the audio of each one and plays
 * them in order. The next chunk is generated while the current one plays.
 */
export class Reader {
  state: ReaderState = "idle";

  private audio = new AudioContext();
  /** Every chunk plays through this, so the volume can change while it plays. */
  private gain = this.audio.createGain();
  /** Goes up on every read() and stop(), so an older read() knows it should end. */
  private session = 0;
  private stopPlayback: (() => void) | null = null;

  // What is being read, for skipping and the progress bar.
  private text = "";
  private options: ReaderOptions = { streamChunks: true, firstChunkSentences: 1, nextChunkSentences: 3 };
  /** The chunk playing now; null until the first one starts. */
  private chunk: Chunk | null = null;
  /** Where reading started, until the first chunk plays. */
  private from = 0;
  private chunkStartTime = 0;
  private chunkDuration = 0;

  constructor(private hooks: ReaderHooks) {
    this.gain.connect(this.audio.destination);
  }

  /**
   * Sets how loud the reading is, from 0 (silent) to 1 (full volume). Takes effect at
   * once, even in the middle of a sentence.
   */
  setVolume(volume: number): void {
    // Ears hear loudness on a log scale, so squaring makes the slider's middle sound
    // like half volume instead of barely quieter than full.
    const gain = Math.min(1, Math.max(0, volume)) ** 2;
    if (this.audio.state === "running") {
      // A short ramp instead of a jump avoids clicks while dragging the slider.
      this.gain.gain.setTargetAtTime(gain, this.audio.currentTime, 0.02);
    } else {
      // Paused or not started: nothing is playing, so jump straight there.
      this.gain.gain.value = gain;
    }
  }

  /** Reads `text` from the sentence that character `from` is in, replacing whatever is being read now. */
  async read(text: string, options: ReaderOptions, from = 0): Promise<void> {
    this.stop();
    const session = ++this.session;
    const isCurrent = () => session === this.session;

    const chunks = options.streamChunks
      ? splitIntoChunks(text, options.firstChunkSentences, options.nextChunkSentences, from)
      : splitIntoChunks(text, Infinity, Infinity, from);
    if (chunks.length === 0) return;

    this.text = text;
    this.options = options;
    this.from = chunks[0].start;
    this.chunk = null;
    this.chunkDuration = 0;
    this.setState("reading");
    await this.audio.resume();

    let nextAudio = this.hooks.synthesize(chunks[0].text);
    for (let i = 0; i < chunks.length; i++) {
      const samples = await nextAudio;
      if (!isCurrent()) return;
      if (i + 1 < chunks.length) nextAudio = this.hooks.synthesize(chunks[i + 1].text);
      if (!samples) continue;

      this.chunk = chunks[i];
      this.hooks.onChunk(chunks[i], text);
      await this.play(samples);
      if (!isCurrent()) return;
    }
    this.setState("idle");
  }

  /**
   * Jumps to the next sentence (1) or back (-1). Going back first returns to the start
   * of the current sentence, unless that only just started.
   */
  skip(direction: 1 | -1): void {
    if (this.state === "idle") return;
    const sentences = splitIntoSentences(this.text);
    const position = this.position;
    let index = sentences.findIndex((sentence) => position < sentence.end);
    if (index === -1) index = sentences.length - 1;

    if (direction === 1) index++;
    else if (this.secondsInto(sentences[index]) < RESTART_SECONDS) index = Math.max(0, index - 1);

    if (index >= sentences.length) this.stop();
    else void this.read(this.text, this.options, sentences[index].start);
  }

  pause(): void {
    if (this.state !== "reading") return;
    void this.audio.suspend();
    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    void this.audio.resume();
    this.setState("reading");
  }

  togglePause(): void {
    if (this.state === "paused") this.resume();
    else this.pause();
  }

  stop(): void {
    if (this.state === "idle") return;
    this.session++;
    this.hooks.cancel();
    this.stopPlayback?.();
    void this.audio.resume();
    this.setState("idle");
  }

  /** How far through the text we are, from 0 to 1. Stands still while paused. */
  get progress(): number {
    if (this.state === "idle" || !this.text) return 0;
    return this.position / this.text.length;
  }

  /**
   * Roughly where in the text the voice is, as a character position. Kokoro speaks at
   * a fairly even pace, so the share of the chunk's audio played is close to the share
   * of its text spoken.
   */
  private get position(): number {
    if (!this.chunk) return this.from;
    const played = this.chunkDuration
      ? Math.min(1, (this.audio.currentTime - this.chunkStartTime) / this.chunkDuration)
      : 0;
    return this.chunk.start + played * (this.chunk.end - this.chunk.start);
  }

  /** Roughly how long the voice has been on `sentence`, in seconds. */
  private secondsInto(sentence: Chunk): number {
    if (!this.chunk || !this.chunkDuration) return 0;
    const charsPerSecond = (this.chunk.end - this.chunk.start) / this.chunkDuration;
    return (this.position - Math.max(sentence.start, this.chunk.start)) / charsPerSecond;
  }

  /** Plays the samples and resolves when they finish or playback is stopped. */
  private play(samples: Float32Array): Promise<void> {
    const buffer = this.audio.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    return new Promise((resolve) => {
      const finish = () => {
        source.onended = null;
        this.stopPlayback = null;
        resolve();
      };
      source.onended = finish;
      this.stopPlayback = () => {
        source.stop();
        finish();
      };
      this.chunkStartTime = this.audio.currentTime;
      this.chunkDuration = buffer.duration;
      source.start();
    });
  }

  private setState(state: ReaderState): void {
    if (state === this.state) return;
    this.state = state;
    this.hooks.onStateChange(state);
  }
}
