import { app, utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import type { EngineStatus, WorkerReply, WorkerRequest } from "../shared/types.js";

interface Waiting {
  resolve(samples: Float32Array): void;
  reject(error: Error): void;
}

/**
 * Runs Kokoro in its own process (src/worker/kokoro-worker.ts), so generating speech
 * never freezes the app.
 */
export class SpeechEngine {
  status: EngineStatus = { state: "loading", message: "Loading voice model…" };

  private worker: UtilityProcess;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();

  constructor(workerPath: string, private onStatus: (status: EngineStatus) => void) {
    this.worker = utilityProcess.fork(workerPath, [], {
      serviceName: "Select Reader speech",
      env: { ...process.env, SELECT_READER_MODEL_DIR: modelDir() },
    });
    this.worker.on("message", (reply: WorkerReply) => this.handleReply(reply));
    this.worker.on("exit", () => {
      for (const request of this.waiting.values()) request.reject(new Error("speech engine stopped"));
      this.waiting.clear();
      this.setStatus({ state: "error", message: "The speech engine stopped. Restart Select Reader." });
    });
  }

  /** Turns text into 24 kHz audio samples. */
  synthesize(text: string, voice: string, speed: number): Promise<Float32Array> {
    const id = this.nextId++;
    this.send({ type: "synthesize", id, text, voice, speed });
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  /** Drops speech that is still being generated. Its promises reject with "cancelled". */
  cancel(): void {
    this.send({ type: "cancel" });
  }

  stop(): void {
    this.worker.kill();
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request);
  }

  private handleReply(reply: WorkerReply): void {
    if (reply.type === "status") {
      this.setStatus(reply.status);
      return;
    }
    const request = this.waiting.get(reply.id);
    if (!request) return;
    this.waiting.delete(reply.id);
    if (reply.type === "audio") request.resolve(reply.samples);
    else request.reject(new Error(reply.message));
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}

/** Where the voice model is downloaded to: the user's cache folder. */
function modelDir(): string {
  const home = app.getPath("home");
  switch (process.platform) {
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "select-reader", "models");
    case "darwin":
      return path.join(home, "Library", "Caches", "select-reader", "models");
    default:
      return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "select-reader", "models");
  }
}
