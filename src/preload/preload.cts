// Runs before the window's page and gives it a small, safe API (window.selectReader)
// for talking to the main process. Electron needs this file to be CommonJS (.cts).

import { contextBridge, ipcRenderer } from "electron";
import type { SelectReaderApi } from "../shared/types.js";

function listen(channel: string, callback: (...args: any[]) => void): void {
  ipcRenderer.on(channel, (_event, ...args) => callback(...args));
}

const api: SelectReaderApi = {
  getAppInfo: () => ipcRenderer.invoke("app-info"),
  updateSettings: (changes) => ipcRenderer.invoke("update-settings", changes),
  setShortcut: (setting, shortcut) => ipcRenderer.invoke("set-shortcut", setting, shortcut),
  pauseShortcut: (paused) => ipcRenderer.send("pause-shortcut", paused),
  setStartOnLogin: (enabled) => ipcRenderer.invoke("set-start-on-login", enabled),
  synthesize: (text, voice, speed) => ipcRenderer.invoke("synthesize", text, voice, speed),
  cancelSpeech: () => ipcRenderer.send("cancel-speech"),
  beginAudioFile: (text) => ipcRenderer.invoke("begin-audio-file", text),
  writeAudio: (samples) => ipcRenderer.invoke("write-audio", samples),
  endAudioFile: (keep) => ipcRenderer.invoke("end-audio-file", keep),
  readText: (text) => ipcRenderer.send("read-text", text),
  clearHistory: () => ipcRenderer.send("clear-history"),
  reportState: (state) => ipcRenderer.send("reader-state", state),
  windowReady: () => ipcRenderer.send("window-ready"),
  quit: () => ipcRenderer.send("quit"),

  onRead: (callback) => listen("read", callback),
  onStop: (callback) => listen("stop", callback),
  onTogglePause: (callback) => listen("toggle-pause", callback),
  onEngineStatus: (callback) => listen("engine-status", callback),
  onNotice: (callback) => listen("notice", callback),
  onHistory: (callback) => listen("history", callback),
};

contextBridge.exposeInMainWorld("selectReader", api);
