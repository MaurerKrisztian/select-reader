import fs from "node:fs";

const HEADER_SIZE = 44;

/**
 * Writes mono audio to a 16-bit WAV file, a piece at a time, so long texts don't have
 * to fit in memory. It's written to "<name>.part" and renamed when finished, so a
 * cancelled save never leaves half a file (or wipes the file it was replacing).
 */
export class WavFile {
  private file: number;
  private dataSize = 0;
  private partPath: string;

  constructor(readonly path: string, private sampleRate: number) {
    this.partPath = `${path}.part`;
    this.file = fs.openSync(this.partPath, "w");
    fs.writeSync(this.file, Buffer.alloc(HEADER_SIZE)); // filled in by finish()
  }

  /** Adds samples (from -1 to 1) to the end. */
  write(samples: Float32Array): void {
    const data = toPcm16(samples);
    fs.writeSync(this.file, data);
    this.dataSize += data.length;
  }

  finish(): void {
    fs.writeSync(this.file, wavHeader(this.dataSize, this.sampleRate), 0, HEADER_SIZE, 0);
    fs.closeSync(this.file);
    fs.renameSync(this.partPath, this.path);
  }

  discard(): void {
    fs.closeSync(this.file);
    fs.rmSync(this.partPath, { force: true });
  }
}

/** The 44 bytes at the start of a WAV file: 16-bit mono PCM. */
export function wavHeader(dataSize: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(HEADER_SIZE - 8 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // size of this "fmt " part
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // one channel
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

/** Samples from -1 to 1 → 16-bit numbers. Louder samples are clipped. */
export function toPcm16(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return data;
}
