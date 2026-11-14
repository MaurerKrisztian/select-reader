import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { toPcm16, WavFile } from "./wav.js";

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "select-reader-wav-")), "out.wav");
}

test("writes a WAV file piece by piece", () => {
  const file = tempFile();
  const wav = new WavFile(file, 24_000);
  wav.write(new Float32Array([0, 0.5]));
  wav.write(new Float32Array([-1]));
  wav.finish();

  const data = fs.readFileSync(file);
  assert.equal(data.length, 44 + 6);
  assert.equal(data.toString("ascii", 0, 4), "RIFF");
  assert.equal(data.readUInt32LE(4), 36 + 6);
  assert.equal(data.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(data.readUInt16LE(22), 1); // mono
  assert.equal(data.readUInt32LE(24), 24_000);
  assert.equal(data.readUInt16LE(34), 16); // bits
  assert.equal(data.toString("ascii", 36, 40), "data");
  assert.equal(data.readUInt32LE(40), 6);
  assert.deepEqual([data.readInt16LE(44), data.readInt16LE(46), data.readInt16LE(48)], [0, 16384, -32767]);
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("a discarded file leaves nothing behind, and doesn't touch the old file", () => {
  const file = tempFile();
  fs.writeFileSync(file, "old");
  const wav = new WavFile(file, 24_000);
  wav.write(new Float32Array([0.1]));
  wav.discard();
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("clips samples outside -1…1", () => {
  const pcm = toPcm16(new Float32Array([2, -2, NaN]));
  assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4)], [32767, -32767, 0]);
});
