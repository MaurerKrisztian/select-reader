#!/usr/bin/env python3
"""
Select Reader: speak highlighted text on Linux.

This app watches the desktop selection and sends changed text to the first
available speech backend: Kokoro, speech-dispatcher, espeak-ng, or espeak.
"""

from __future__ import annotations

import importlib.util
import json
import os
import queue
import re
import shutil
import subprocess
import tempfile
import textwrap
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Callable


os.environ.setdefault("WANDB_DISABLED", "true")
os.environ.setdefault("USE_TF", "0")

APP_NAME = "Select Reader"
POLL_MS = 350
SPEAK_AFTER_MS = 550
MAX_CHARS = 5000
CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", "~/.config")).expanduser() / "select-reader" / "config.json"
DEFAULT_SHORTCUT = "Ctrl+Alt+R"
DEFAULT_FIRST_CHUNK_SENTENCES = 2
DEFAULT_NEXT_CHUNK_SENTENCES = 4

THEME = {
    "bg": "#050608",
    "panel": "#0d1117",
    "panel_2": "#111827",
    "border": "#273244",
    "text": "#e5eefb",
    "muted": "#94a3b8",
    "accent": "#38bdf8",
    "accent_hot": "#7dd3fc",
    "field": "#030712",
    "highlight": "#fde047",
    "highlight_text": "#111827",
    "danger": "#f87171",
}

KOKORO_VOICES = (
    "af_heart",
    "af_bella",
    "af_sarah",
    "af_nicole",
    "am_adam",
    "am_michael",
    "bf_emma",
    "bf_isabella",
    "bm_george",
    "bm_lewis",
)


class SpeechEngine:
    def __init__(self) -> None:
        self.kokoro_voice = os.environ.get("SELECT_READER_KOKORO_VOICE", "af_heart")
        self.kokoro_pipeline = None
        self.backend = self._detect_backend()
        self.process: subprocess.Popen[str] | None = None
        self.stop_event = threading.Event()
        self.lock = threading.Lock()

    def _detect_backend(self) -> str | None:
        if self._has_kokoro() and self._audio_player():
            return "kokoro"

        for command in ("spd-say", "espeak-ng", "espeak"):
            if shutil.which(command):
                return command
        return None

    @staticmethod
    def _has_kokoro() -> bool:
        return importlib.util.find_spec("kokoro") is not None

    def set_kokoro_voice(self, voice: str) -> None:
        self.stop()
        self.kokoro_voice = voice
        self.kokoro_pipeline = None
        self.backend = self._detect_backend()

    @staticmethod
    def _audio_player() -> list[str] | None:
        for command in ("paplay", "aplay", "ffplay"):
            if not shutil.which(command):
                continue
            if command == "ffplay":
                return [command, "-nodisp", "-autoexit", "-loglevel", "quiet"]
            return [command]
        return None

    def speak(
        self,
        text: str,
        stream_chunks: bool = True,
        first_chunk_sentences: int = DEFAULT_FIRST_CHUNK_SENTENCES,
        next_chunk_sentences: int = DEFAULT_NEXT_CHUNK_SENTENCES,
        on_progress: Callable[[str], None] | None = None,
        on_done: Callable[[], None] | None = None,
    ) -> None:
        if not self.backend:
            return

        text = text.strip()
        if not text:
            return

        self.stop()

        try:
            with self.lock:
                self.stop_event.clear()
                if self.backend == "kokoro":
                    self._speak_with_kokoro(
                        text,
                        stream_chunks=stream_chunks,
                        first_chunk_sentences=first_chunk_sentences,
                        next_chunk_sentences=next_chunk_sentences,
                        on_progress=on_progress,
                    )
                    return

                if on_progress:
                    on_progress(text)

                if self.backend == "spd-say":
                    self.process = subprocess.Popen(
                        ["spd-say", text],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                    self.process.wait()
                    return

                self.process = subprocess.Popen(
                    [self.backend, "--stdin"],
                    stdin=subprocess.PIPE,
                    text=True,
                )
                if self.process.stdin:
                    try:
                        self.process.stdin.write(text)
                        self.process.stdin.close()
                    except BrokenPipeError:
                        pass
                self.process.wait()
        finally:
            if on_done:
                on_done()

    def _speak_with_kokoro(
        self,
        text: str,
        stream_chunks: bool,
        first_chunk_sentences: int,
        next_chunk_sentences: int,
        on_progress: Callable[[str], None] | None = None,
    ) -> None:
        player = self._audio_player()
        if not player:
            return

        chunks = [text]
        if stream_chunks:
            chunks = self._chunk_text(text, first_chunk_sentences, next_chunk_sentences)

        if len(chunks) <= 1:
            wav_path = self._generate_kokoro_wav(text)
            if wav_path:
                try:
                    if on_progress:
                        on_progress(text)
                    self._play_wav(wav_path, player)
                finally:
                    self._unlink_quietly(wav_path)
            return

        self._speak_kokoro_streaming(chunks, player, on_progress)

    def _speak_kokoro_streaming(
        self,
        chunks: list[str],
        player: list[str],
        on_progress: Callable[[str], None] | None = None,
    ) -> None:
        wav_queue: queue.Queue[tuple[str, str] | None] = queue.Queue(maxsize=2)

        def producer() -> None:
            try:
                for chunk in chunks:
                    if self.stop_event.is_set():
                        break
                    wav_path = self._generate_kokoro_wav(chunk)
                    if not wav_path:
                        continue
                    wav_queue.put((wav_path, chunk))
            finally:
                wav_queue.put(None)

        producer_thread = threading.Thread(target=producer, daemon=True)
        producer_thread.start()

        while not self.stop_event.is_set():
            item = wav_queue.get()
            if item is None:
                break
            wav_path, chunk = item
            try:
                if on_progress:
                    on_progress(chunk)
                self._play_wav(wav_path, player)
            finally:
                self._unlink_quietly(wav_path)

        self.stop_event.set()
        while True:
            try:
                leftover = wav_queue.get_nowait()
            except queue.Empty:
                break
            if leftover:
                self._unlink_quietly(leftover)

    def _generate_kokoro_wav(self, text: str) -> str | None:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as wav_file:
            wav_path = wav_file.name

        try:
            from kokoro import KPipeline
            import soundfile as sf

            if self.kokoro_pipeline is None:
                self.kokoro_pipeline = KPipeline(lang_code=self.kokoro_voice[0])

            generator = self.kokoro_pipeline(text, voice=self.kokoro_voice)
            for _graphemes, _phonemes, audio in generator:
                sf.write(wav_path, audio, 24000)
                break
            return wav_path
        except (OSError, subprocess.TimeoutExpired, Exception):
            self._unlink_quietly(wav_path)
            return None

    def _play_wav(self, wav_path: str, player: list[str]) -> None:
        if self.stop_event.is_set():
            return
        self.process = subprocess.Popen(
            [*player, wav_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.process.wait()

    @staticmethod
    def _chunk_text(
        text: str,
        first_chunk_sentences: int,
        next_chunk_sentences: int,
    ) -> list[str]:
        first_chunk_sentences = max(1, min(first_chunk_sentences, 4))
        next_chunk_sentences = max(1, min(next_chunk_sentences, 8))
        sentences = [
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?])\s+", text)
            if sentence.strip()
        ]
        if len(sentences) <= first_chunk_sentences:
            return [text]

        chunks = [" ".join(sentences[:first_chunk_sentences])]
        index = first_chunk_sentences
        while index < len(sentences):
            chunks.append(" ".join(sentences[index : index + next_chunk_sentences]))
            index += next_chunk_sentences
        return chunks

    @staticmethod
    def _unlink_quietly(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    def stop(self) -> None:
        self.stop_event.set()
        if self.backend == "spd-say":
            subprocess.Popen(
                ["spd-say", "-C"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return

        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None


class SelectReaderApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_NAME)
        self.root.minsize(620, 480)

        self.config = self._load_config()
        self.engine = SpeechEngine()
        self.is_wayland = os.environ.get("XDG_SESSION_TYPE") == "wayland"
        self.warned_no_engine = False
        self.selected_voice = tk.StringVar(
            value=self.config.get("kokoro_voice", self.engine.kokoro_voice)
        )
        self.engine.set_kokoro_voice(self.selected_voice.get())
        self.enabled = tk.BooleanVar(value=self.config.get("watch_selections", True))
        self.auto_read = tk.BooleanVar(value=self.config.get("auto_read", True))
        self.show_play = tk.BooleanVar(value=self.config.get("show_play", True))
        self.watch_primary = tk.BooleanVar(value=self.config.get("watch_primary", True))
        self.watch_clipboard = tk.BooleanVar(
            value=self.config.get("watch_clipboard", self.is_wayland)
        )
        self.stream_chunks = tk.BooleanVar(value=self.config.get("stream_chunks", True))
        self.first_chunk_sentences = tk.IntVar(
            value=int(self.config.get("first_chunk_sentences", DEFAULT_FIRST_CHUNK_SENTENCES))
        )
        self.next_chunk_sentences = tk.IntVar(
            value=int(self.config.get("next_chunk_sentences", DEFAULT_NEXT_CHUNK_SENTENCES))
        )
        self.shortcut = self._normalize_shortcut(
            self.config.get("shortcut", DEFAULT_SHORTCUT)
        )
        self.shortcut_var = tk.StringVar(value=self.shortcut)
        self.last_seen = ""
        self.pending_text = ""
        self.pending_after_id: str | None = None
        self.read_token = 0
        self.play_popup: tk.Toplevel | None = None
        self.hotkey_listener = None
        self.bound_shortcuts: list[str] = []
        self.status = tk.StringVar(value="Starting...")
        self.preview = tk.StringVar(value="Select text in another app to hear it.")

        self._build_ui()
        self._setup_shortcuts()
        self._set_initial_status()
        self._poll_selection()

    @staticmethod
    def _load_config() -> dict[str, object]:
        try:
            with CONFIG_PATH.open("r", encoding="utf-8") as config_file:
                data = json.load(config_file)
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save_config(self) -> None:
        data = {
            "kokoro_voice": self.selected_voice.get(),
            "shortcut": self.shortcut,
            "watch_selections": self.enabled.get(),
            "auto_read": self.auto_read.get(),
            "show_play": self.show_play.get(),
            "watch_primary": self.watch_primary.get(),
            "watch_clipboard": self.watch_clipboard.get(),
            "stream_chunks": self.stream_chunks.get(),
            "first_chunk_sentences": self._clamped_int(
                self.first_chunk_sentences.get(), 1, 4, DEFAULT_FIRST_CHUNK_SENTENCES
            ),
            "next_chunk_sentences": self._clamped_int(
                self.next_chunk_sentences.get(), 1, 8, DEFAULT_NEXT_CHUNK_SENTENCES
            ),
        }
        try:
            CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with CONFIG_PATH.open("w", encoding="utf-8") as config_file:
                json.dump(data, config_file, indent=2)
                config_file.write("\n")
        except OSError:
            self.status.set("Could not save settings.")

    @staticmethod
    def _clamped_int(value: object, minimum: int, maximum: int, fallback: int) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError, tk.TclError):
            number = fallback
        return max(minimum, min(maximum, number))

    def _speech_options(self) -> dict[str, int | bool]:
        return {
            "stream_chunks": self.stream_chunks.get(),
            "first_chunk_sentences": self._clamped_int(
                self.first_chunk_sentences.get(), 1, 4, DEFAULT_FIRST_CHUNK_SENTENCES
            ),
            "next_chunk_sentences": self._clamped_int(
                self.next_chunk_sentences.get(), 1, 8, DEFAULT_NEXT_CHUNK_SENTENCES
            ),
        }

    def _apply_theme(self) -> None:
        self.root.configure(bg=THEME["bg"])
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure("App.TFrame", background=THEME["bg"])
        style.configure("Band.TFrame", background=THEME["panel_2"], relief="flat")
        style.configure(
            "Dark.TLabel",
            background=THEME["panel"],
            foreground=THEME["text"],
        )
        style.configure(
            "Title.TLabel",
            background=THEME["bg"],
            foreground=THEME["text"],
        )
        style.configure(
            "Muted.TLabel",
            background=THEME["bg"],
            foreground=THEME["muted"],
        )
        style.configure(
            "Status.TLabel",
            background=THEME["panel_2"],
            foreground=THEME["accent_hot"],
        )
        style.configure(
            "Dark.TLabelframe",
            background=THEME["panel"],
            foreground=THEME["text"],
            bordercolor=THEME["border"],
            lightcolor=THEME["border"],
            darkcolor=THEME["border"],
        )
        style.configure(
            "Dark.TLabelframe.Label",
            background=THEME["bg"],
            foreground=THEME["accent_hot"],
        )
        style.configure(
            "TButton",
            background=THEME["panel_2"],
            foreground=THEME["text"],
            bordercolor=THEME["border"],
            focusthickness=1,
            focuscolor=THEME["accent"],
            padding=(12, 7),
        )
        style.map(
            "TButton",
            background=[("active", THEME["accent"]), ("pressed", THEME["accent_hot"])],
            foreground=[("active", THEME["bg"]), ("pressed", THEME["bg"])],
        )
        style.configure(
            "TCheckbutton",
            background=THEME["bg"],
            foreground=THEME["text"],
            focuscolor=THEME["accent"],
        )
        style.map(
            "TCheckbutton",
            background=[("active", THEME["bg"])],
            foreground=[("active", THEME["accent_hot"])],
        )
        style.configure(
            "TCombobox",
            fieldbackground=THEME["field"],
            background=THEME["panel_2"],
            foreground=THEME["text"],
            arrowcolor=THEME["accent"],
            bordercolor=THEME["border"],
            padding=5,
        )
        style.map("TCombobox", fieldbackground=[("readonly", THEME["field"])])
        style.configure(
            "TEntry",
            fieldbackground=THEME["field"],
            foreground=THEME["text"],
            insertcolor=THEME["accent"],
            bordercolor=THEME["border"],
            padding=6,
        )

    def _build_ui(self) -> None:
        self._apply_theme()

        container = ttk.Frame(self.root, padding=18, style="App.TFrame")
        container.pack(fill="both", expand=True)
        container.columnconfigure(0, weight=1)
        container.rowconfigure(3, weight=1)

        title = ttk.Label(
            container,
            text=APP_NAME,
            font=("TkDefaultFont", 20, "bold"),
            style="Title.TLabel",
        )
        title.grid(row=0, column=0, sticky="w")

        subtitle = ttk.Label(
            container,
            text="Reads text aloud when your desktop selection changes.",
            style="Muted.TLabel",
        )
        subtitle.grid(row=1, column=0, sticky="w", pady=(4, 16))

        status_band = ttk.Frame(container, style="Band.TFrame", padding=(12, 9))
        status_band.grid(row=2, column=0, sticky="ew", pady=(0, 14))
        status_band.columnconfigure(0, weight=1)
        ttk.Label(status_band, textvariable=self.status, style="Status.TLabel").grid(
            row=0, column=0, sticky="w"
        )

        preview_frame = ttk.LabelFrame(container, text="Last text", style="Dark.TLabelframe")
        preview_frame.grid(row=3, column=0, sticky="nsew")
        preview_frame.columnconfigure(0, weight=1)
        preview_frame.rowconfigure(0, weight=1)

        self.preview_box = tk.Text(
            preview_frame,
            height=8,
            wrap="word",
            relief="flat",
            padx=10,
            pady=10,
            bg=THEME["field"],
            fg=THEME["text"],
            insertbackground=THEME["accent"],
            selectbackground=THEME["accent"],
            selectforeground=THEME["bg"],
            highlightthickness=1,
            highlightbackground=THEME["border"],
            highlightcolor=THEME["accent"],
        )
        self.preview_box.grid(row=0, column=0, sticky="nsew")
        self.preview_box.tag_configure(
            "speaking",
            background=THEME["highlight"],
            foreground=THEME["highlight_text"],
        )
        self.preview_box.insert("1.0", self.preview.get())
        self.preview_box.configure(state="disabled")

        controls = ttk.Frame(container, style="App.TFrame")
        controls.grid(row=4, column=0, sticky="ew", pady=(14, 0))
        controls.columnconfigure(0, weight=1)

        voice_frame = ttk.LabelFrame(controls, text="Kokoro voice", style="Dark.TLabelframe")
        voice_frame.grid(row=0, column=0, sticky="ew")
        voice_frame.columnconfigure(1, weight=1)
        ttk.Label(voice_frame, text="Voice", style="Dark.TLabel").grid(
            row=0, column=0, sticky="w", padx=(10, 8), pady=10
        )
        self.voice_combo = ttk.Combobox(
            voice_frame,
            textvariable=self.selected_voice,
            values=KOKORO_VOICES,
            state="readonly",
        )
        self.voice_combo.grid(row=0, column=1, sticky="ew", pady=10)
        self.voice_combo.bind("<<ComboboxSelected>>", self._select_voice)
        ttk.Button(voice_frame, text="Test", command=self._test_voice).grid(
            row=0, column=2, sticky="e", padx=(8, 10), pady=10
        )

        shortcut_frame = ttk.LabelFrame(controls, text="Read shortcut", style="Dark.TLabelframe")
        shortcut_frame.grid(row=1, column=0, sticky="ew", pady=(12, 0))
        shortcut_frame.columnconfigure(1, weight=1)
        ttk.Label(shortcut_frame, text="Keys", style="Dark.TLabel").grid(
            row=0, column=0, sticky="w", padx=(10, 8), pady=10
        )
        self.shortcut_entry = ttk.Entry(shortcut_frame, textvariable=self.shortcut_var)
        self.shortcut_entry.grid(row=0, column=1, sticky="ew", pady=10)
        ttk.Button(shortcut_frame, text="Save", command=self._save_shortcut_from_ui).grid(
            row=0, column=2, sticky="e", padx=8, pady=10
        )
        ttk.Button(shortcut_frame, text="Reset", command=self._reset_shortcut).grid(
            row=0, column=3, sticky="e", padx=(0, 10), pady=10
        )

        chunk_frame = ttk.LabelFrame(controls, text="Chunked TTS", style="Dark.TLabelframe")
        chunk_frame.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        chunk_frame.columnconfigure(3, weight=1)
        ttk.Checkbutton(
            chunk_frame,
            text="Generate next chunks while reading",
            variable=self.stream_chunks,
            command=self._save_config,
        ).grid(row=0, column=0, sticky="w", padx=(10, 14), pady=10)
        ttk.Label(chunk_frame, text="First", style="Dark.TLabel").grid(
            row=0, column=1, sticky="e", padx=(0, 6), pady=10
        )
        ttk.Spinbox(
            chunk_frame,
            from_=1,
            to=4,
            width=4,
            textvariable=self.first_chunk_sentences,
            command=self._save_config,
        ).grid(row=0, column=2, sticky="w", padx=(0, 10), pady=10)
        ttk.Label(chunk_frame, text="Next", style="Dark.TLabel").grid(
            row=0, column=3, sticky="e", padx=(0, 6), pady=10
        )
        ttk.Spinbox(
            chunk_frame,
            from_=1,
            to=8,
            width=4,
            textvariable=self.next_chunk_sentences,
            command=self._save_config,
        ).grid(row=0, column=4, sticky="w", padx=(0, 10), pady=10)

        toggles = ttk.Frame(controls, style="App.TFrame")
        toggles.grid(row=3, column=0, sticky="w", pady=(12, 0))
        ttk.Checkbutton(toggles, text="Watch selections", variable=self.enabled).grid(
            row=0, column=0, sticky="w", padx=(0, 14)
        )
        ttk.Checkbutton(toggles, text="Auto-read", variable=self.auto_read).grid(
            row=0, column=1, sticky="w", padx=(0, 14)
        )
        ttk.Checkbutton(toggles, text="Play button", variable=self.show_play).grid(
            row=0, column=2, sticky="w", padx=(0, 14)
        )
        ttk.Checkbutton(toggles, text="Watch highlighted text", variable=self.watch_primary).grid(
            row=1, column=0, sticky="w", padx=(0, 14), pady=(8, 0)
        )
        ttk.Checkbutton(toggles, text="Watch clipboard", variable=self.watch_clipboard).grid(
            row=1, column=1, sticky="w", pady=(8, 0)
        )

        buttons = ttk.Frame(controls, style="App.TFrame")
        buttons.grid(row=4, column=0, sticky="ew", pady=(12, 0))
        ttk.Button(buttons, text="Stop", command=self._stop_reading).pack(side="left")
        ttk.Button(buttons, text="Read again", command=self._read_again).pack(
            side="left", padx=(8, 0)
        )
        ttk.Button(buttons, text="Quit", command=self._quit).pack(side="right")

    def _setup_shortcuts(self) -> None:
        for sequence in self.bound_shortcuts:
            self.root.unbind_all(sequence)

        self.bound_shortcuts = self._shortcut_to_tk_sequences(self.shortcut)
        for sequence in self.bound_shortcuts:
            self.root.bind_all(sequence, self._read_from_shortcut)

        self._setup_global_hotkey()

    def _setup_global_hotkey(self) -> None:
        if self.hotkey_listener:
            self.hotkey_listener.stop()
            self.hotkey_listener = None

        if self.is_wayland:
            return

        try:
            from pynput import keyboard
        except ImportError:
            return

        pynput_shortcut = self._shortcut_to_pynput(self.shortcut)
        if not pynput_shortcut:
            return

        hotkey = keyboard.HotKey(
            keyboard.HotKey.parse(pynput_shortcut),
            lambda: self.root.after(0, self._read_from_shortcut),
        )

        def on_press(key: object) -> None:
            try:
                hotkey.press(self.hotkey_listener.canonical(key))
            except Exception:
                pass

        def on_release(key: object) -> None:
            try:
                hotkey.release(self.hotkey_listener.canonical(key))
            except Exception:
                pass

        try:
            self.hotkey_listener = keyboard.Listener(
                on_press=on_press,
                on_release=on_release,
            )
            self.hotkey_listener.daemon = True
            self.hotkey_listener.start()
        except Exception:
            self.hotkey_listener = None

    def _save_shortcut_from_ui(self) -> None:
        try:
            shortcut = self._normalize_shortcut(self.shortcut_var.get())
        except ValueError as error:
            self.status.set(str(error))
            return

        self.shortcut = shortcut
        self.shortcut_var.set(shortcut)
        self._setup_shortcuts()
        self._save_config()
        self.status.set(f"Read shortcut saved: {shortcut}")

    def _reset_shortcut(self) -> None:
        self.shortcut_var.set(DEFAULT_SHORTCUT)
        self._save_shortcut_from_ui()

    @staticmethod
    def _normalize_shortcut(shortcut: object) -> str:
        if not isinstance(shortcut, str):
            shortcut = DEFAULT_SHORTCUT

        raw_parts = re.split(r"\s*\+\s*", shortcut.strip())
        parts = [part for part in raw_parts if part]
        if not parts:
            return DEFAULT_SHORTCUT

        aliases = {
            "control": "Ctrl",
            "ctrl": "Ctrl",
            "ctl": "Ctrl",
            "alt": "Alt",
            "option": "Alt",
            "shift": "Shift",
            "super": "Super",
            "meta": "Super",
            "cmd": "Super",
            "win": "Super",
        }

        modifiers: list[str] = []
        key = ""
        for part in parts:
            lowered = part.lower()
            if lowered in aliases:
                modifier = aliases[lowered]
                if modifier not in modifiers:
                    modifiers.append(modifier)
            elif not key:
                key = part
            else:
                raise ValueError("Use one key plus optional modifiers, like Ctrl+Alt+R.")

        if not key:
            raise ValueError("Shortcut needs a key, like Ctrl+Alt+R.")

        if len(key) == 1:
            key = key.upper()
        else:
            key = key[0].upper() + key[1:].lower()

        return "+".join([*modifiers, key])

    @staticmethod
    def _shortcut_to_tk_sequences(shortcut: str) -> list[str]:
        parts = shortcut.split("+")
        key = parts[-1]
        modifiers = parts[:-1]
        tk_modifiers = {
            "Ctrl": "Control",
            "Alt": "Alt",
            "Shift": "Shift",
            "Super": "Mod4",
        }
        prefix = "-".join(tk_modifiers[part] for part in modifiers if part in tk_modifiers)

        if len(key) == 1:
            lower = key.lower()
            upper = key.upper()
            if prefix:
                return [f"<{prefix}-{lower}>", f"<{prefix}-{upper}>"]
            return [f"<{lower}>", f"<{upper}>"]

        special_keys = {
            "Space": "space",
            "Enter": "Return",
            "Return": "Return",
            "Escape": "Escape",
            "Esc": "Escape",
            "Tab": "Tab",
            "Backspace": "BackSpace",
            "Delete": "Delete",
        }
        tk_key = special_keys.get(key, key)
        return [f"<{prefix}-{tk_key}>"] if prefix else [f"<{tk_key}>"]

    @staticmethod
    def _shortcut_to_pynput(shortcut: str) -> str:
        parts = shortcut.split("+")
        key = parts[-1]
        modifiers = parts[:-1]
        pynput_modifiers = {
            "Ctrl": "<ctrl>",
            "Alt": "<alt>",
            "Shift": "<shift>",
            "Super": "<cmd>",
        }
        result = [pynput_modifiers[part] for part in modifiers if part in pynput_modifiers]
        if len(key) == 1:
            result.append(key.lower())
        else:
            result.append(f"<{key.lower()}>")
        return "+".join(result)

    def _select_voice(self, _event: tk.Event | None = None) -> None:
        self.engine.set_kokoro_voice(self.selected_voice.get())
        self._save_config()
        self._set_initial_status()

    def _test_voice(self) -> None:
        if self.engine.backend != "kokoro":
            if not self.engine._has_kokoro():
                self.status.set("Install Kokoro to use AI local voices.")
            else:
                self.status.set("Install paplay, aplay, or ffplay to play Kokoro audio.")
            return

        threading.Thread(
            target=self.engine.speak,
            kwargs={
                "text": "This is the selected Kokoro voice.",
                "stream_chunks": False,
            },
            daemon=True,
        ).start()

    def _set_initial_status(self) -> None:
        backend = self.engine.backend or "no speech command found"

        if not self.engine.backend:
            self.status.set(
                "Install Kokoro, speech-dispatcher, or espeak-ng."
            )
            if not self.warned_no_engine:
                self.warned_no_engine = True
                messagebox.showwarning(
                    APP_NAME,
                    "No speech engine was found.\n\nInstall one of these packages:\n"
                    "  python3 -m pip install --user kokoro soundfile\n"
                    "  sudo apt install speech-dispatcher\n"
                    "  sudo apt install espeak-ng",
                )
            return

        if self.engine.backend == "kokoro":
            chunk_mode = "streaming chunks" if self.stream_chunks.get() else "single pass"
            self.status.set(
                f"Speech: Kokoro {self.engine.kokoro_voice}, {chunk_mode}. Waiting for highlighted text."
            )
            return

        if self.is_wayland:
            self.status.set(
                f"Speech: {backend}. Wayland may block reading highlighted text; enable clipboard mode if needed."
            )
        else:
            self.status.set(f"Speech: {backend}. Waiting for highlighted text.")

    def _poll_selection(self) -> None:
        if self.enabled.get():
            text = self._read_desktop_text()
            if text and text != self.last_seen:
                self.last_seen = text
                self.pending_text = text
                self._show_preview(text)
                self._show_play_popup()
                if self.auto_read.get():
                    self._schedule_speech(text)

        self.root.after(POLL_MS, self._poll_selection)

    def _read_desktop_text(self) -> str:
        candidates: list[str] = []

        if self.watch_primary.get():
            primary = self._get_selection("PRIMARY")
            if primary:
                candidates.append(primary)

        if self.watch_clipboard.get():
            clipboard = self._get_selection("CLIPBOARD")
            if clipboard:
                candidates.append(clipboard)

        for text in candidates:
            cleaned = self._clean_text(text)
            if cleaned:
                return cleaned
        return ""

    def _get_tk_selection(self, selection: str) -> str:
        try:
            if selection == "CLIPBOARD":
                return self.root.clipboard_get()
            return self.root.selection_get(selection=selection)
        except tk.TclError:
            return ""

    def _get_selection(self, selection: str) -> str:
        text = self._get_tk_selection(selection)
        if text:
            return text

        command_sets = []
        if selection == "PRIMARY":
            command_sets = [
                ["wl-paste", "--primary", "--no-newline"],
                ["xclip", "-o", "-selection", "primary"],
                ["xsel", "-op"],
            ]
        else:
            command_sets = [
                ["wl-paste", "--no-newline"],
                ["xclip", "-o", "-selection", "clipboard"],
                ["xsel", "-ob"],
            ]

        for command in command_sets:
            if not shutil.which(command[0]):
                continue
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=0.3,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and result.stdout:
                return result.stdout
        return ""

    def _schedule_speech(self, text: str) -> None:
        if self.pending_after_id:
            self.root.after_cancel(self.pending_after_id)

        self.pending_text = text
        self._show_preview(text)
        self.pending_after_id = self.root.after(SPEAK_AFTER_MS, self._speak_pending)

    def _speak_pending(self) -> None:
        text = self.pending_text
        self.pending_after_id = None
        if not text:
            return

        self.status.set("Reading selected text...")
        options = self._speech_options()
        self.read_token += 1
        read_token = self.read_token
        threading.Thread(
            target=self.engine.speak,
            kwargs={
                "text": text,
                **options,
                "on_progress": lambda chunk: self._highlight_spoken_text(
                    chunk, read_token
                ),
                "on_done": lambda: self._clear_spoken_highlight(read_token),
            },
            daemon=True,
        ).start()
        self.root.after(900, self._set_initial_status)

    def _read_again(self) -> None:
        if self.last_seen:
            self._schedule_speech(self.last_seen)

    def _read_from_shortcut(self, _event: tk.Event | None = None) -> None:
        text = self._read_desktop_text()
        if text:
            self.last_seen = text
            self.pending_text = text
            self._show_preview(text)
            self._hide_play_popup()
            self._schedule_speech(text)
            return

        if self.last_seen:
            self._schedule_speech(self.last_seen)

    def _show_play_popup(self) -> None:
        if not self.show_play.get() or not self.last_seen:
            return

        if not self.play_popup or not self.play_popup.winfo_exists():
            self.play_popup = tk.Toplevel(self.root)
            self.play_popup.overrideredirect(True)
            self.play_popup.attributes("-topmost", True)
            self.play_popup.configure(bg=THEME["bg"])
            button = ttk.Button(
                self.play_popup,
                text=">",
                width=3,
                command=self._play_from_popup,
            )
            button.pack(ipadx=2, ipady=2)

        pointer_x = self.root.winfo_pointerx()
        pointer_y = self.root.winfo_pointery()
        self.play_popup.geometry(f"+{pointer_x + 12}+{pointer_y + 12}")
        self.play_popup.deiconify()
        self.play_popup.lift()

    def _play_from_popup(self) -> None:
        if self.last_seen:
            self._schedule_speech(self.last_seen)
        self._hide_play_popup()

    def _hide_play_popup(self) -> None:
        if self.play_popup and self.play_popup.winfo_exists():
            self.play_popup.withdraw()

    def _show_preview(self, text: str) -> None:
        self.preview_box.configure(state="normal")
        self.preview_box.delete("1.0", "end")
        self.preview_box.insert("1.0", text)
        self.preview_box.tag_remove("speaking", "1.0", "end")
        self.preview_box.configure(state="disabled")

    def _highlight_spoken_text(self, chunk: str, read_token: int) -> None:
        self.root.after(0, lambda: self._apply_spoken_highlight(chunk, read_token))

    def _apply_spoken_highlight(self, chunk: str, read_token: int) -> None:
        if read_token != self.read_token:
            return

        chunk = chunk.strip()
        self.preview_box.configure(state="normal")
        self.preview_box.tag_remove("speaking", "1.0", "end")

        start = ""
        if chunk:
            start = self.preview_box.search(chunk, "1.0", stopindex="end")

        if start:
            end = f"{start}+{len(chunk)}c"
        else:
            start = "1.0"
            end = "end-1c"

        self.preview_box.tag_add("speaking", start, end)
        self.preview_box.see(start)
        self.preview_box.configure(state="disabled")

    def _clear_spoken_highlight(self, read_token: int | None = None) -> None:
        def clear() -> None:
            if read_token is not None and read_token != self.read_token:
                return
            self.preview_box.configure(state="normal")
            self.preview_box.tag_remove("speaking", "1.0", "end")
            self.preview_box.configure(state="disabled")

        self.root.after(0, clear)

    def _stop_reading(self) -> None:
        self.read_token += 1
        self.engine.stop()
        self._clear_spoken_highlight()
        self._set_initial_status()

    @staticmethod
    def _clean_text(text: str) -> str:
        text = text.replace("\x00", " ").strip()
        text = "\n".join(line.strip() for line in text.splitlines())
        text = textwrap.shorten(text, width=MAX_CHARS, placeholder="...")
        return text

    def _quit(self) -> None:
        self.engine.stop()
        self._save_config()
        if self.hotkey_listener:
            self.hotkey_listener.stop()
        if self.play_popup and self.play_popup.winfo_exists():
            self.play_popup.destroy()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    app = SelectReaderApp(root)
    root.protocol("WM_DELETE_WINDOW", app._quit)
    root.mainloop()


if __name__ == "__main__":
    main()
