// Runs in a separate process (started by src/main/speech.ts) and turns text into audio
// with the Kokoro voice model. Requests are handled one at a time, in order.

import { env } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream, type GenerateOptions } from "kokoro-js";
import type { WorkerReply, WorkerRequest } from "../shared/types.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
// fp32 is the biggest download (~310 MB, once), but on a CPU it sounds best and is
// about 3x faster than the smaller q8 model.
const DTYPE = "fp32";

// Download the model into the user's cache folder instead of next to the app.
env.cacheDir = process.env.SELECT_READER_MODEL_DIR ?? env.cacheDir;

const send = (reply: WorkerReply) => process.parentPort.postMessage(reply);

const ttsReady = loadModel();
let queue = Promise.resolve();
// "cancel" bumps this number. Requests made before that are dropped.
let generation = 0;

process.parentPort.on("message", ({ data }: { data: WorkerRequest }) => {
  if (data.type === "cancel") {
    generation++;
    return;
  }
  const requestGeneration = generation;
  queue = queue.then(() => synthesize(data, requestGeneration));
});

async function loadModel(): Promise<KokoroTTS> {
  let lastPercent = -1;
  try {
    const tts = await KokoroTTS.from_pretrained(MODEL, {
      dtype: DTYPE,
      device: "cpu",
      progress_callback: (progress) => {
        if (progress.status !== "progress" || !progress.file.endsWith(".onnx")) return;
        const percent = Math.floor(progress.progress);
        if (percent === lastPercent) return;
        lastPercent = percent;
        send({
          type: "status",
          status: { state: "loading", message: `Getting the voice model… ${percent}%`, progress: percent },
        });
      },
    });
    send({ type: "status", status: { state: "ready", message: "Ready" } });
    return tts;
  } catch (error) {
    const message = `Could not load the voice model: ${(error as Error).message}`;
    send({ type: "status", status: { state: "error", message } });
    throw error;
  }
}

async function synthesize(
  request: Extract<WorkerRequest, { type: "synthesize" }>,
  requestGeneration: number,
): Promise<void> {
  const { id, text, speed } = request;
  const voice = request.voice as GenerateOptions["voice"];
  const cancelled = () => requestGeneration !== generation;

  try {
    const tts = await ttsReady;
    const pieces: Float32Array[] = [];
    if (!cancelled()) {
      // Speak one sentence at a time: Kokoro can only handle so much text at once.
      // (Pass a closed splitter: given a plain string, kokoro-js waits forever for more text.)
      const sentences = new TextSplitterStream();
      sentences.push(text);
      sentences.close();
      for await (const { audio } of tts.stream(sentences, { voice, speed })) {
        if (cancelled()) break;
        pieces.push(audio.audio);
      }
    }
    if (cancelled()) send({ type: "failed", id, message: "cancelled" });
    else send({ type: "audio", id, samples: joinAudio(pieces) });
  } catch (error) {
    send({ type: "failed", id, message: (error as Error).message });
  }
}

function joinAudio(pieces: Float32Array[]): Float32Array {
  const joined = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}
