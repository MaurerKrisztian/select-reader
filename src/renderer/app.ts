// The window: shows the shortcuts, the text being read, and the settings.
// It also plays the audio (see reader.ts).

import type { EngineStatus, Pronunciation, Settings, ShortcutSetting } from "../shared/types.js";
import { describeVoice, VOICES } from "../shared/voices.js";
import { api } from "./api.js";
import { splitIntoChunks, type Chunk } from "./chunks.js";
import { isUsableShortcut, shortcutFromKeyPress } from "./keys.js";
import { Reader, type ReaderOptions } from "./reader.js";

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

function readerOptions(): ReaderOptions {
  return {
    streamChunks: settings.stream_chunks,
    firstChunkSentences: settings.first_chunk_sentences,
    nextChunkSentences: settings.next_chunk_sentences,
  };
}

/** Shows `text` in the player and reads it, starting at character `from`. */
function readAloud(text: string, from = 0): void {
  cancelSaving();
  shownText = text;
  renderText();
  void reader.read(text, readerOptions(), from);
}

/** Says something short (a voice preview) without showing it in the player. */
function say(text: string): void {
  cancelSaving();
  void reader.read(text, { streamChunks: false, firstChunkSentences: 1, nextChunkSentences: 1 });
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
// Shortcuts: the big one reads the selection, the small ones pause and stop.

/** The shortcut being recorded, if any. */
let recording: ShortcutSetting | null = null;

const KEY_LABELS: Record<string, string> = {
  Super: isMac ? "⌘" : info.platform === "win32" ? "Win" : "Super",
  Alt: isMac ? "⌥" : "Alt",
  Mod: isMac ? "⌘" : "Ctrl", // the key for copy and paste
};

/** Shows a shortcut as keys: Ctrl + Shift + C. */
function renderKeys(element: HTMLElement, shortcut: string): void {
  element.replaceChildren(
    ...shortcut.split("+").map((part) => {
      const kbd = document.createElement("kbd");
      kbd.textContent = KEY_LABELS[part] ?? part;
      return kbd;
    }),
  );
}

function renderShortcuts(): void {
  const keys = $("keys");
  keys.classList.toggle("recording", recording === "shortcut");
  if (recording === "shortcut") keys.textContent = "Press the new keys…";
  else renderKeys(keys, settings.shortcut);

  for (const element of document.querySelectorAll<HTMLElement>("[data-keys]")) {
    const setting = element.dataset.keys as ShortcutSetting;
    element.classList.toggle("recording", recording === setting);
    element.classList.toggle("off", !settings[setting]);
    if (recording === setting) element.textContent = "Press keys…";
    else if (settings[setting]) renderKeys(element, settings[setting]);
    else element.textContent = "Off";
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-shortcut]")) {
    const setting = button.dataset.shortcut as ShortcutSetting;
    if (recording === setting) button.textContent = "Cancel";
    else if (setting === "shortcut") button.textContent = "Change shortcut";
    else button.textContent = settings[setting] ? "Change" : "Set";
  }
}

function showShortcutMessage(message: string, kind: "info" | "ok" | "error" = "info"): void {
  $("shortcut-message").textContent = message;
  $("shortcut-message").dataset.kind = kind;
}

function startRecording(setting: ShortcutSetting): void {
  recording = setting;
  api.pauseShortcut(true); // so the old shortcuts don't fire while typing the new one
  showShortcutMessage(
    setting === "shortcut"
      ? "Hold Ctrl, Alt or Super and press a key. Esc cancels."
      : "Hold Ctrl, Alt or Super and press a key. Backspace turns it off, Esc cancels.",
  );
  renderShortcuts();
}

function stopRecording(): void {
  recording = null;
  api.pauseShortcut(false);
  renderShortcuts();
}

async function saveShortcut(setting: ShortcutSetting, shortcut: string): Promise<void> {
  const result = await api.setShortcut(setting, shortcut);
  settings = result.settings;
  stopRecording();
  if (result.error) showShortcutMessage(result.error, "error");
  else if (!shortcut) showShortcutMessage("Turned off.", "ok");
  else showShortcutMessage("Saved. It works in every app.", "ok");
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-shortcut]")) {
  button.addEventListener("click", () => {
    const setting = button.dataset.shortcut as ShortcutSetting;
    const wasRecording = recording;
    if (recording) stopRecording();
    if (wasRecording === setting) showShortcutMessage("");
    else startRecording(setting);
  });
}

window.addEventListener("keydown", async (event) => {
  if (!recording) return handlePlayerKey(event);
  event.preventDefault();
  if (event.key === "Escape") {
    stopRecording();
    showShortcutMessage("");
    return;
  }
  const noModifiers = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (event.key === "Backspace" && noModifiers && recording !== "shortcut") {
    await saveShortcut(recording, "");
    return;
  }
  const shortcut = shortcutFromKeyPress(event);
  if (!shortcut) return; // only modifier keys so far
  if (!isUsableShortcut(shortcut)) {
    showShortcutMessage(`${shortcut} would get in the way of typing. Add Ctrl, Alt or Super.`, "error");
    return;
  }
  await saveShortcut(recording, shortcut);
});

// Don't leave the shortcuts switched off if the user walks away mid-recording.
window.addEventListener("blur", () => {
  if (recording) {
    stopRecording();
    showShortcutMessage("");
  }
});

$("wayland-hint").hidden = !info.wayland;

// ---------------------------------------------------------------------------
// Player

const LABELS = { idle: "Ready", reading: "Reading", paused: "Paused" };

function renderPlayer(): void {
  document.body.dataset.reader = reader.state;
  $("player-label").textContent = LABELS[reader.state];
  $("play").title = reader.state === "reading" ? "Pause (Space)" : "Play (Space)";
  $<HTMLButtonElement>("back").disabled = reader.state === "idle";
  $<HTMLButtonElement>("forward").disabled = reader.state === "idle";
  if (reader.state === "idle") renderText();
  else animateProgress();
}

/** Shows the text, with the part being spoken highlighted and the part already spoken dimmed. */
function renderText(chunk?: Chunk): void {
  const box = $("text");
  box.hidden = !shownText;
  $("empty").hidden = !!shownText;
  renderSaving();
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
$("back").addEventListener("click", () => reader.skip(-1));
$("forward").addEventListener("click", () => reader.skip(1));
$("stop").addEventListener("click", () => reader.stop());

// Clicking a sentence reads from there.
$("text").addEventListener("click", (event) => {
  if (!window.getSelection()?.isCollapsed) return; // selecting text to copy it
  const from = textPositionAt(event.clientX, event.clientY);
  if (from !== null) readAloud(shownText, from);
});

/** The position in shownText of the character at a point, or null if it's past the end. */
function textPositionAt(x: number, y: number): number | null {
  const box = $("text");
  const caret = document.caretPositionFromPoint(x, y);
  if (!caret || !box.contains(caret.offsetNode)) return null;
  // The box holds shownText split over a few elements: count the text before the caret.
  const before = document.createRange();
  before.setStart(box, 0);
  before.setEnd(caret.offsetNode, caret.offset);
  const position = before.toString().length;
  return position < shownText.trimEnd().length ? position : null;
}

/**
 * Space plays or pauses, the arrow keys skip a sentence, F1 or "?" opens the help.
 * Not while a field or button has the focus, or while the help is open.
 */
function handlePlayerKey(event: KeyboardEvent): void {
  if (helpDialog.open) return; // Esc closes it; other keys shouldn't reach the player
  if (event.key === "F1") {
    event.preventDefault();
    openHelp();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if ((event.target as HTMLElement).closest("input, select, textarea, button, summary")) return;
  const actions: Record<string, () => void> = {
    " ": () => $("play").click(),
    ArrowLeft: () => reader.skip(-1),
    ArrowRight: () => reader.skip(1),
    "?": openHelp,
  };
  if (!actions[event.key]) return;
  event.preventDefault();
  actions[event.key]();
}

// Pasting text into the window reads it.
$("paste-hint").textContent = `${isMac ? "⌘V" : "Ctrl+V"} reads pasted text`;
document.addEventListener("paste", (event) => {
  if ((event.target as HTMLElement).closest("input")) return; // typing in a field
  const text = event.clipboardData?.getData("text/plain");
  if (text?.trim()) api.readText(text);
});

// ---------------------------------------------------------------------------
// Saving the text as an audio file

/** Set while an audio file is being made. */
let saving: { cancelled: boolean; percent: number } | null = null;

function renderSaving(): void {
  const button = $("save-audio");
  button.hidden = !shownText;
  button.textContent = saving ? `Saving ${saving.percent}% · Cancel` : "Save audio";
}

async function saveAudio(): Promise<void> {
  const text = shownText;
  const fileName = await api.beginAudioFile(text);
  if (!fileName) return;
  reader.stop(); // the speech engine does one thing at a time
  const job = (saving = { cancelled: false, percent: 0 });
  renderSaving();

  // A few sentences at a time, so the progress moves and Cancel is quick.
  const chunks = splitIntoChunks(text, 3, 3);
  let ok = true;
  for (let i = 0; i < chunks.length && ok; i++) {
    const samples = await api.synthesize(chunks[i].text, settings.kokoro_voice, settings.speed).catch(() => null);
    if (job.cancelled || !samples) {
      ok = false;
    } else {
      await api.writeAudio(samples);
      job.percent = Math.round(((i + 1) / chunks.length) * 100);
      renderSaving();
    }
  }
  await api.endAudioFile(ok);
  saving = null;
  renderSaving();
  if (ok) showStatus(`Saved ${fileName}`);
  else if (job.cancelled) showStatus("Stopped saving the audio.");
  else showStatus("Could not make the audio. Try again.");
}

/** Stops making an audio file, for example because something else is being read. */
function cancelSaving(): void {
  if (!saving) return;
  saving.cancelled = true;
  api.cancelSpeech();
}

$("save-audio").addEventListener("click", () => {
  if (saving) cancelSaving();
  else void saveAudio();
});

// ---------------------------------------------------------------------------
// Voice, speed and volume

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
  say(`Hi, I'm ${name}. This is how I sound.`);
}

voiceSelect.addEventListener("change", async () => {
  settings = await api.updateSettings({ kokoro_voice: voiceSelect.value });
  if (reader.state === "idle") previewVoice();
});
$("preview-voice").addEventListener("click", previewVoice);

/** Colors a slider's track up to the thumb. */
function fillSlider(input: HTMLInputElement): void {
  const fill = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty("--fill", `${fill}%`);
}

const speedInput = $<HTMLInputElement>("speed");
speedInput.value = String(settings.speed);

function renderSpeed(): void {
  $("speed-value").textContent = `${Number(speedInput.value).toFixed(2).replace(/0$/, "")}×`;
  fillSlider(speedInput);
}

speedInput.addEventListener("input", renderSpeed);
speedInput.addEventListener("change", async () => {
  settings = await api.updateSettings({ speed: Number(speedInput.value) });
});

const volumeInput = $<HTMLInputElement>("volume");
volumeInput.value = String(settings.volume);
reader.setVolume(settings.volume);

function renderVolume(): void {
  $("volume-value").textContent = `${Math.round(Number(volumeInput.value) * 100)}%`;
  fillSlider(volumeInput);
}

// Change the volume while the slider moves, so it can be heard mid-sentence;
// save it once the slider is let go.
volumeInput.addEventListener("input", () => {
  reader.setVolume(Number(volumeInput.value));
  renderVolume();
});
volumeInput.addEventListener("change", async () => {
  settings = await api.updateSettings({ volume: Number(volumeInput.value) });
});

// ---------------------------------------------------------------------------
// Recently read texts (kept by the main process until the app quits)

function renderHistory(history: string[]): void {
  $("recent").hidden = history.length === 0;
  $("recent-list").replaceChildren(
    ...history.map((text) => {
      const button = document.createElement("button");
      button.className = "recent-item";
      button.textContent = text.replace(/\s+/g, " ").slice(0, 300);
      button.title = "Read again";
      button.addEventListener("click", () => api.readText(text));
      return button;
    }),
  );
}

$("clear-recent").addEventListener("click", () => api.clearHistory());

// ---------------------------------------------------------------------------
// Advanced settings

const startOnLogin = $<HTMLInputElement>("start-on-login");
startOnLogin.checked = info.startOnLogin;
startOnLogin.addEventListener("change", async () => {
  startOnLogin.checked = await api.setStartOnLogin(startOnLogin.checked);
});

// Inputs with data-setting="<settings key>"
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

// Pronunciations: one row per word. Saved whenever a row changes; rows without a
// word stay on screen (while being typed) but aren't saved.

function pronunciationRow({ from, to }: Pronunciation): HTMLElement {
  const row = document.createElement("div");
  row.className = "pronunciation";
  const word = Object.assign(document.createElement("input"), { value: from, placeholder: "Word" });
  const sayAs = Object.assign(document.createElement("input"), { value: to, placeholder: "Say" });
  word.setAttribute("aria-label", "Word");
  sayAs.setAttribute("aria-label", "Say it as");
  word.addEventListener("change", savePronunciations);
  sayAs.addEventListener("change", savePronunciations);

  const arrow = Object.assign(document.createElement("span"), { textContent: "→" });
  const hear = iconButton("▶", "Hear it", () => {
    if (word.value.trim()) say(word.value);
  });
  const remove = iconButton("×", "Remove", () => {
    row.remove();
    void savePronunciations();
  });
  row.append(word, arrow, sayAs, hear, remove);
  return row;
}

function iconButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = Object.assign(document.createElement("button"), { textContent: text, title: label });
  button.className = "icon-button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

async function savePronunciations(): Promise<void> {
  const pronunciations = [...document.querySelectorAll(".pronunciation")]
    .map((row) => {
      const [word, sayAs] = row.querySelectorAll("input");
      return { from: word.value.trim(), to: sayAs.value.trim() };
    })
    .filter((entry) => entry.from);
  settings = await api.updateSettings({ pronunciations });
}

$("pronunciation-list").append(...settings.pronunciations.map(pronunciationRow));
$("add-pronunciation").addEventListener("click", () => {
  const row = pronunciationRow({ from: "", to: "" });
  $("pronunciation-list").append(row);
  row.querySelector("input")!.focus();
});

// ---------------------------------------------------------------------------
// Help (the "?" button, or F1)

const helpDialog = $<HTMLDialogElement>("help-dialog");

function openHelp(): void {
  // Fixed keys, shown the way this computer labels them (⌘ on a Mac).
  for (const element of helpDialog.querySelectorAll<HTMLElement>("[data-help-keys]")) {
    renderKeys(element, element.dataset.helpKeys!);
  }
  // The user's own shortcuts, as they are now.
  for (const element of helpDialog.querySelectorAll<HTMLElement>("[data-help-setting]")) {
    const shortcut = settings[element.dataset.helpSetting as ShortcutSetting];
    element.classList.toggle("off", !shortcut);
    if (shortcut) renderKeys(element, shortcut);
    else element.textContent = "Not set";
  }
  $("help-wayland").hidden = !info.wayland;
  helpDialog.showModal();
  helpDialog.scrollTop = 0;
  // Focus the text, not the × button: Space would "press" that and close the help.
  $("help-body").focus({ preventScroll: true });
}

$("help").addEventListener("click", openHelp);
$("close-help").addEventListener("click", () => helpDialog.close());
// A click on the dimmed area around the panel closes it too.
helpDialog.addEventListener("click", (event) => {
  if (event.target === helpDialog) helpDialog.close();
});

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

api.onRead((text) => readAloud(text));
api.onStop(() => reader.stop());
api.onTogglePause(() => reader.togglePause());
api.onEngineStatus(renderEngine);
api.onNotice(showStatus);
api.onHistory(renderHistory);

$("status").textContent = DEFAULT_STATUS;
renderEngine(info.engine);
renderShortcuts();
if (info.shortcutError) showShortcutMessage(info.shortcutError, "error");
renderPlayer();
renderSpeed();
renderVolume();
renderHistory(info.history);
renderAdvanced();
api.windowReady();
