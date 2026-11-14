import { SAMPLE_RATE, type ReaderState } from "../shared/types.js";
import { splitIntoChunks, type Chunk } from "./chunks.js";

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

/**
 * Reads text aloud: splits it into chunks, asks for the audio of each one and plays
 * them in order. The next chunk is generated while the current one plays.
 */
export class Reader {
  state: ReaderState = "idle";

  private audio = new AudioContext();
  /** Goes up on every read() and stop(), so an older read() knows it should end. */
  private session = 0;
  private stopPlayback: (() => void) | null = null;

  // For the progress bar.
  private chunkIndex = 0;
  private chunkCount = 0;
  private chunkStartTime = 0;
  private chunkDuration = 0;

  constructor(private hooks: ReaderHooks) {}

  /** Reads `text`, replacing whatever is being read now. */
  async read(text: string, options: ReaderOptions): Promise<void> {
    this.stop();
    const session = ++this.session;
    const isCurrent = () => session === this.session;

    const chunks = options.streamChunks
      ? splitIntoChunks(text, options.firstChunkSentences, options.nextChunkSentences)
      : splitIntoChunks(text, Infinity, Infinity);
    if (chunks.length === 0) return;

    this.chunkIndex = 0;
    this.chunkCount = chunks.length;
    this.chunkDuration = 0;
    this.setState("reading");
    await this.audio.resume();

    let nextAudio = this.hooks.synthesize(chunks[0].text);
    for (let i = 0; i < chunks.length; i++) {
      const samples = await nextAudio;
      if (!isCurrent()) return;
      if (i + 1 < chunks.length) nextAudio = this.hooks.synthesize(chunks[i + 1].text);
      if (!samples) continue;

      this.chunkIndex = i;
      this.hooks.onChunk(chunks[i], text);
      await this.play(samples);
      if (!isCurrent()) return;
    }
    this.setState("idle");
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
    if (this.state === "idle" || this.chunkCount === 0) return 0;
    const played = this.chunkDuration
      ? Math.min(1, (this.audio.currentTime - this.chunkStartTime) / this.chunkDuration)
      : 0;
    return (this.chunkIndex + played) / this.chunkCount;
  }

  /** Plays the samples and resolves when they finish or playback is stopped. */
  private play(samples: Float32Array): Promise<void> {
    const buffer = this.audio.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = this.audio.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audio.destination);

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
