# Select Reader

![Select Reader reading a highlighted paragraph](site/screenshot.png)

Select text in any app, press a shortcut, and hear it read aloud with natural-sounding
[Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voices. Everything runs on your
computer: no account, and no internet after the first start.

Works on **Linux** and **Windows**. macOS should work too but hasn't been tested.

**Website and downloads: https://maurerkrisztian.github.io/select-reader/**

## Using it

1. Start **Select Reader**. The first start downloads the voice model (about 310 MB, once).
2. Select text in any app.
3. Press the shortcut (**Ctrl+Shift+C** by default). Press it again to stop.

In the window you can:

- **Get help**: the **?** button (top right) or F1 shows how to use the app, every
  shortcut (including the ones you set) and what each feature does.
- **Change the shortcut**: click *Change shortcut* and press the new keys. You can also
  set shortcuts that pause and stop reading in any app.
- Pause, stop or replay what's being read. The current sentence is highlighted.
- Skip to the next or previous sentence (the arrow keys work too), or click a sentence
  to read from there. Space plays and pauses.
- **Save audio**: save the text as a WAV file.
- Pick a voice, a speed and a volume. Picking a voice plays a short preview.
- Paste text into the window (Ctrl+V) to read it.
- Read something again from *Recent* (also in the tray menu). The list is kept until
  you quit and is never saved to disk.
- Under *Advanced*: start Select Reader when you log in, and fix words the voice says
  wrong (for example, say "kubectl" as "cube control", or leave the "say" field empty
  to skip citation marks like "[1]").

Closing the window keeps the app running in the tray, so the shortcut keeps working.
Use **Quit** (in the window or the tray menu) to stop it.

Text copied from PDFs is tidied up: words split over two lines with a hyphen are put
back together. Up to 100,000 characters are read at once.

> The shortcut is taken over while the app runs. `Ctrl+Shift+C` is also "copy" in most
> terminals and "inspect" in browsers, so pick a different shortcut if you need those.

### How it gets the selected text

Select Reader presses "copy" in the app you're using and reads what it copied, so
the selected text ends up on your clipboard too. If nothing gets copied, the text
that was on your clipboard is put back.

- **Linux:** presses Ctrl+Insert (copy, but it can't interrupt a program in a terminal)
  using `xdotool`. The `.deb` installs it; otherwise run `sudo apt install xdotool`.
  If nothing gets copied, it reads the highlighted text directly (the "primary
  selection"), which is how terminals work.
- **Windows / macOS:** presses Ctrl+C (Cmd+C).
  On macOS, allow Select Reader under *System Settings → Privacy & Security → Accessibility*.

### Linux on Wayland

Wayland only lets the app you're typing in read your selection, and doesn't pass global
shortcuts on to other apps. So on Wayland:

- Select Reader runs through XWayland (X11), which the desktop shares the selection with.
  It restarts itself that way when started; there's nothing to set up.
- Add the shortcuts in your desktop's settings instead (Ubuntu: *Settings → Keyboard →
  Custom Shortcuts*), with these commands:

  ```sh
  select-reader --read    # read the selection
  select-reader --pause   # pause / resume
  select-reader --stop    # stop
  ```

## Command line

```sh
select-reader --read          # read the selected text
select-reader --text "Hello"  # read some text
select-reader --pause         # pause / resume
select-reader --stop          # stop
select-reader --hidden        # start in the tray, without the window
```

If the app is already running, the command is passed to it. Otherwise it starts.

## Local HTTP API

For scripts and browser extensions, the app listens on `127.0.0.1:4040`:

```sh
curl "http://127.0.0.1:4040/read?text=Hello"
curl --data-binary @article.txt "http://127.0.0.1:4040/read"   # long text: send it as the body
curl "http://127.0.0.1:4040/pause"                              # pause / resume
curl "http://127.0.0.1:4040/stop"
```

Web pages can't use it, so a site you visit can't make your computer talk: requests
that browsers mark as coming from a page (the `Sec-Fetch-Site` and `Origin` headers)
are refused. Browser extensions can, from their background script, with permission
for `http://127.0.0.1:4040/*`.

## Install

Download the installer for your system from the
[releases page](https://github.com/MaurerKrisztian/select-reader/releases), or build it
yourself (see *Development*), then:

- **Ubuntu / Debian:** `sudo apt install ./select-reader_amd64.deb`
- **Other Linux:** run `select-reader-x86_64.AppImage`
- **Windows:** run `select-reader-setup.exe`. The installer isn't signed, so
  Windows may warn about it: click *More info → Run anyway*.

### Upgrading from the Python version

If you installed the old Python version with `install.sh`, its launcher and menu entry
win over the new ones. Remove them:

```sh
rm ~/.local/bin/select-reader ~/.local/share/applications/select-reader.desktop
rm -r ~/.local/share/select-reader
```

Your settings carry over (`~/.config/select-reader/config.json`).

## Development

Needs Node.js 22 or newer.

```sh
npm install
npm start           # build and run
npm test            # unit tests
npm run dist:linux  # release/*.AppImage and *.deb
npm run dist:win    # release/*.exe (build this on Windows)
npm run dist:mac    # release/*.dmg (build this on a Mac)
```

Build each installer on its own system: npm only installs the speech engine's native
files for the system it runs on.

### Builds and releases

GitHub Actions ([.github/workflows/build.yml](.github/workflows/build.yml)) builds the
Linux and Windows installers on every push to `main` and every pull request. Download
them from the workflow run's *Artifacts*.

To publish a release, set the version in `package.json`, then push a matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds the installers and attaches them to a new GitHub release.

### Website

The website is the `site/` folder, published to GitHub Pages by
[.github/workflows/pages.yml](.github/workflows/pages.yml) whenever it changes on `main`.
One-time setup: on GitHub, open *Settings → Pages* and set *Source* to *GitHub Actions*.

Its download buttons link to the newest release, so they work once a release exists.
To preview it locally, serve the folder: `python3 -m http.server --directory site`.

### How it fits together

```
 shortcut / CLI / HTTP / tray
             │
             ▼
   main process (src/main)  ──── gets the selected text, decides what to read
             │  "read this"
             ▼
   window (src/renderer)    ──── splits text into chunks, plays audio, highlights
             │  "speak this chunk"            ▲ audio samples
             ▼                                │
   speech worker (src/worker) ── runs Kokoro in its own process
```

The first chunk is one sentence, so speech starts quickly. Each next chunk is generated
while the previous one plays.

### Files

| File | What it does |
| --- | --- |
| `src/main/main.ts` | Starts the app: window, tray, shortcuts, single instance, messages from the window |
| `src/main/selection.ts` | Gets the text the user selected |
| `src/main/text.ts` | Tidies text before it's read (PDF hyphens, length cap) |
| `src/main/speech.ts` | Starts the speech worker and sends it text |
| `src/main/settings.ts` | Loads and saves `config.json` |
| `src/main/autostart.ts` | Starting at login |
| `src/main/tray.ts` | Tray icon and menu |
| `src/main/wav.ts` | Writes WAV files for *Save audio* |
| `src/main/cli.ts` | `--read`, `--text`, `--pause`, `--stop`, `--hidden` |
| `src/main/http-server.ts` | The local HTTP API |
| `src/worker/kokoro-worker.ts` | Turns text into audio with Kokoro |
| `src/preload/preload.cts` | The bridge between the window and the main process |
| `src/renderer/app.ts` | The window's UI |
| `src/renderer/reader.ts` | Plays text chunk by chunk, with pause, stop, skip and volume |
| `src/renderer/chunks.ts` | Splits text into sentences and chunks |
| `src/renderer/keys.ts` | Turns key presses into a shortcut like `Ctrl+Shift+C` |
| `src/shared/` | Types, the voice list and the word replacements, used by all of the above |
| `electron-builder.yml` | Installer settings |
| `.github/workflows/build.yml` | Builds the installers on GitHub and publishes releases |
| `site/` | The website, published by `.github/workflows/pages.yml` |

Where things are stored:

| | Linux | Windows |
| --- | --- | --- |
| Settings | `~/.config/select-reader/config.json` | `%APPDATA%\select-reader\config.json` |
| Voice model | `~/.cache/select-reader/models` | `%LOCALAPPDATA%\select-reader\models` |
| Start at login | `~/.config/autostart/select-reader.desktop` | Windows' startup apps list |
