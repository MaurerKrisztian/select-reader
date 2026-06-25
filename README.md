# Select Reader

![Select Reader app screenshot](assets/select-reader-screenshot.png)

Select Reader is a small Linux accessibility app that reads highlighted text
aloud. Start it, select text in a browser or another app, and it speaks the
current selection. A small play button appears near your cursor when new text is
selected. Turn off **Auto-read** if you only want it to speak when you press the
button.

Whisper is for speech-to-text, so it cannot read text aloud. Select Reader uses
offline text-to-speech instead, preferring Kokoro local AI voices when installed.

## Features

- Reads highlighted text aloud on Linux desktops.
- Shows a small play button near the cursor for new selections.
- Supports auto-read, manual playback, clipboard watching, and a read shortcut.
- Uses Kokoro local AI voices when available, with offline speech fallbacks.
- Splits long selections into chunks for faster playback.

## Requirements

- Python 3 with Tkinter
- Kokoro for local AI voices, or one fallback speech command:
  - `spd-say` from `speech-dispatcher`
  - `espeak-ng`
  - `espeak`

On Debian or Ubuntu:

```sh
sudo apt install python3-tk speech-dispatcher
```

or:

```sh
sudo apt install python3-tk espeak-ng
```

For Kokoro local AI voices:

```sh
python3 -m pip install --user kokoro soundfile
sudo apt install espeak-ng
```

The **Kokoro voice** selector in the app lets you choose voices such as
`af_heart`, `af_bella`, `am_adam`, and `bf_emma`. You can set the default voice
when launching:

```sh
SELECT_READER_KOKORO_VOICE=af_bella python3 select-reader.py
```

## Keyboard Shortcuts

The default shortcut is `Ctrl+Alt+R` to read the current selection.

This works whenever the Select Reader window is focused. For a global shortcut
on X11, install the optional hotkey dependency:

```sh
python3 -m pip install --user pynput
```

Change the shortcut in the **Read shortcut** field inside the app. Shortcuts use
one key plus optional modifiers such as `Ctrl`, `Alt`, `Shift`, or `Super`.
Examples:

- `Ctrl+Alt+R`
- `Ctrl+Shift+Space`
- `Alt+F8`

Settings are saved in `~/.config/select-reader/config.json`.

## Chunked TTS

For long selections, enable **Generate next chunks while reading**. The first
chunk starts quickly with a small number of sentences, then later chunks are
generated while the current audio is playing.

- **First**: sentences in the first fast-start chunk
- **Next**: sentences in each following chunk

Optional helpers for selection access on some desktops:

```sh
sudo apt install wl-clipboard xclip xsel
```

## Run

```sh
python3 select-reader.py
```

## Install For Your User

```sh
chmod +x install.sh
./install.sh
```

After installing, open **Select Reader** from your app launcher or run:

```sh
select-reader
```

## Notes About Wayland

On X11, Linux exposes highlighted text through the primary selection, so the app
can read text just by selecting it.

On Wayland, many desktops intentionally prevent apps from reading highlighted
text from other apps. If selection reading does not work, enable **Watch
clipboard** in Select Reader, then copy selected text with `Ctrl+C` to read it.
