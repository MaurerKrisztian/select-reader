// The window: shows the shortcut, the text being read, and the voice settings.
// It also plays the audio (see reader.ts).

import type { EngineStatus, Settings } from "../shared/types.js";
import { describeVoice, VOICES } from "../shared/voices.js";
import { api } from "./api.js";
import type { Chunk } from "./chunks.js";
import { isUsableShortcut, shortcutFromKeyPress } from "./keys.js";
import { Reader } from "./reader.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const info = await api.getAppInfo();
const isMac = info.platform === "darwin";
let settings = info.settings;
let shownText = ""; // the text in the player

const reader = new Reader({
  synthesize: (text) => api.synthesize(text, settings.kokoro_voice, settings.speed).catch(() => null),
  cancel: () => api.cancelSpeech(),
  onStateChange: (state) => {
    api.reportState(state);
    renderPlayer();
  },
  onChunk: (chunk, text) => {
    if (text === shownText) renderText(chunk);
  },
});

function readAloud(text: string): void {
  shownText = text;
  renderText();
  void reader.read(text, {
    streamChunks: settings.stream_chunks,
    firstChunkSentences: settings.first_chunk_sentences,
    nextChunkSentences: settings.next_chunk_sentences,
  });
}

// ---------------------------------------------------------------------------
// Engine status (top right)

function renderEngine(status: EngineStatus): void {
  $("engine").dataset.state = status.state;
  $("engine").title = status.message;
  $("engine-text").textContent = status.state === "ready" ? "Voice ready" : status.message;

  const downloading = status.state === "loading" && status.progress !== undefined;
  $("download").hidden = !downloading;
  ($("download").firstElementChild as HTMLElement).style.width = `${status.progress ?? 0}%`;
  if (status.state === "error") showStatus(status.message);
}

// ---------------------------------------------------------------------------
// Shortcut

let recording = false;

const KEY_LABELS: Record<string, string> = {
  Super: isMac ? "⌘" : info.platform === "win32" ? "Win" : "Super",
  Alt: isMac ? "⌥" : "Alt",
};

function renderShortcut(): void {
  const keys = $("keys");
  keys.classList.toggle("recording", recording);
  $("change-shortcut").textContent = recording ? "Cancel" : "Change shortcut";
  if (recording) {
    keys.textContent = "Press the new keys…";
    return;
  }
  keys.replaceChildren(
    ...settings.shortcut.split("+").map((part) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = KEY_LABELS[part] ?? part;
      return kbd;
    }),
  );
}

function showShortcutMessage(message: string, kind: "info" | "ok" | "error" = "info"): void {
  $("shortcut-message").textContent = message;
  $("shortcut-message").dataset.kind = kind;
}

function startRecording(): void {
  recording = true;
  api.pauseShortcut(true); // so the old shortcut doesn't start reading
  showShortcutMessage("Hold Ctrl, Alt or Super and press a key. Esc cancels.");
  renderShortcut();
}

function stopRecording(): void {
  recording = false;
  api.pauseShortcut(false);
  renderShortcut();
}

$("change-shortcut").addEventListener("click", () => {
  if (recording) {
    stopRecording();
    showShortcutMessage("");
  } else {
    startRecording();
  }
});

window.addEventListener("keydown", async (event) => {
  if (!recording) return;
  event.preventDefault();
  if (event.key === "Escape") {
    stopRecording();
    showShortcutMessage("");
    return;
  }
  const shortcut = shortcutFromKeyPress(event);
  if (!shortcut) return; // only modifier keys so far
  if (!isUsableShortcut(shortcut)) {
    showShortcutMessage(`${shortcut} would get in the way of typing. Add Ctrl, Alt or Super.`, "error");
    return;
  }
  const result = await api.setShortcut(shortcut);
  settings = result.settings;
  stopRecording();
  if (result.error) showShortcutMessage(result.error, "error");
  else showShortcutMessage("Saved. It works in every app.", "ok");
});

// Don't leave the shortcut switched off if the user walks away mid-recording.
window.addEventListener("blur", () => {
  if (recording) {
    stopRecording();
    showShortcutMessage("");
  }
});

// ---------------------------------------------------------------------------
// Player

const LABELS = { idle: "Ready", reading: "Reading", paused: "Paused" };

function renderPlayer(): void {
  document.body.dataset.reader = reader.state;
  $("player-label").textContent = LABELS[reader.state];
  $("play").title = reader.state === "reading" ? "Pause" : "Play";
  if (reader.state === "idle") renderText();
  else animateProgress();
}

/** Shows the text, with the part being spoken highlighted and the part already spoken dimmed. */
function renderText(chunk?: Chunk): void {
  const box = $("text");
  box.hidden = !shownText;
  $("empty").hidden = !!shownText;
  if (!chunk) {
    box.textContent = shownText;
    return;
  }
  const spoken = document.createElement("span");
  spoken.className = "spoken";
  spoken.textContent = shownText.slice(0, chunk.start);
  const current = document.createElement("mark");
  current.textContent = shownText.slice(chunk.start, chunk.end);
  box.replaceChildren(spoken, current, shownText.slice(chunk.end));
  current.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

let animating = false;

function animateProgress(): void {
  if (animating) return;
  animating = true;
  const bar = $("progress");
  const frame = () => {
    bar.style.width = `${reader.progress * 100}%`;
    if (reader.state === "idle") {
      animating = false;
      bar.style.width = "0";
    } else {
      requestAnimationFrame(frame);
    }
  };
  frame();
}

$("play").addEventListener("click", () => {
  if (reader.state !== "idle") reader.togglePause();
  else if (shownText) readAloud(shownText);
  else showStatus("Select some text in any app and press the shortcut.");
});
$("replay").addEventListener("click", () => {
  if (shownText) readAloud(shownText);
});
$("stop").addEventListener("click", () => reader.stop());

// Pasting text into the window reads it.
$("paste-hint").textContent = `${isMac ? "⌘V" : "Ctrl+V"} reads pasted text`;
document.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (text?.trim()) api.readText(text);
});

// ---------------------------------------------------------------------------
// Voice and speed

const voiceSelect = $<HTMLSelectElement>("voice");
for (const accent of ["American", "British"]) {
  const group = document.createElement("optgroup");
  group.label = accent;
  for (const id of VOICES) {
    const voice = describeVoice(id);
    if (voice.accent === accent) group.append(new Option(`${voice.name} · ${voice.gender}`, id));
  }
  voiceSelect.append(group);
}
voiceSelect.value = settings.kokoro_voice;

function previewVoice(): void {
  const { name } = describeVoice(settings.kokoro_voice);
  void reader.read(`Hi, I'm ${name}. This is how I sound.`, {
    streamChunks: false,
    firstChunkSentences: 1,
    nextChunkSentences: 1,
  });
}

voiceSelect.addEventListener("change", async () => {
  settings = await api.updateSettings({ kokoro_voice: voiceSelect.value });
  if (reader.state === "idle") previewVoice();
});
$("preview-voice").addEventListener("click", previewVoice);

const speedInput = $<HTMLInputElement>("speed");
speedInput.value = String(settings.speed);

function renderSpeed(): void {
  const speed = Number(speedInput.value);
  $("speed-value").textContent = `${speed.toFixed(2).replace(/0$/, "")}×`;
  const fill = ((speed - Number(speedInput.min)) / (Number(speedInput.max) - Number(speedInput.min))) * 100;
  speedInput.style.setProperty("--fill", `${fill}%`);
}

speedInput.addEventListener("input", renderSpeed);
speedInput.addEventListener("change", async () => {
  settings = await api.updateSettings({ speed: Number(speedInput.value) });
});

// ---------------------------------------------------------------------------
// Advanced settings: inputs with data-setting="<settings key>"

function renderAdvanced(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-setting]")) {
    const value = settings[input.dataset.setting as keyof Settings];
    if (input.type === "checkbox") input.checked = value as boolean;
    else input.value = String(value);
  }
  $<HTMLFieldSetElement>("chunk-sizes").disabled = !settings.stream_chunks;
}

for (const input of document.querySelectorAll<HTMLInputElement>("[data-setting]")) {
  input.addEventListener("change", async () => {
    const value = input.type === "checkbox" ? input.checked : Number(input.value);
    settings = await api.updateSettings({ [input.dataset.setting!]: value });
    renderAdvanced();
  });
}

// ---------------------------------------------------------------------------
// Status line (bottom)

const DEFAULT_STATUS = "Closing this window keeps Select Reader running in the tray.";
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showStatus(message: string): void {
  $("status").textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = DEFAULT_STATUS), 6000);
}

$("quit").addEventListener("click", () => api.quit());

// ---------------------------------------------------------------------------
// Start

api.onRead(readAloud);
api.onStop(() => reader.stop());
api.onTogglePause(() => reader.togglePause());
api.onEngineStatus(renderEngine);
api.onNotice(showStatus);

$("status").textContent = DEFAULT_STATUS;
renderEngine(info.engine);
renderShortcut();
if (info.shortcutError) showShortcutMessage(info.shortcutError, "error");
renderPlayer();
renderSpeed();
renderAdvanced();
api.windowReady();
