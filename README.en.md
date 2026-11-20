# SolidCraft AI Studio

*[Deutsche Version](README.md)*

Work on a **real, parametric CAD model** with a pen, your voice and text. You sketch, mark and
describe on a tablet (built for the Galaxy Tab S8+ with S Pen). An AI agent builds and changes the
model in the running [SolidCraft](https://github.com/tangency-labs/solidcraft) app on the PC. It works
step by step, checks its own results and asks when something is unclear.

The studio is a standalone extension, not a fork. It uses only SolidCraft's official interfaces: the
control channel (`solidcraft --control PORT`) and the MCP server (`solidcraft-cli mcp`). SolidCraft
updates can be taken without merging.

> **Status:** prototype (milestone 1 reached). What works, what is tested and what is missing is
> tracked in **[STAND.md](STAND.md)** (German). The requirements are in [docs/AUFTRAG.md](docs/AUFTRAG.md)
> (German).

## Features

| Feature | Status |
|---|---|
| Freehand sketching and marking on the 3D model (pen or mouse) | ✅ tested |
| Sketch + text → parametric part in SolidCraft | ✅ tested |
| Circle an edge + describe a change → exactly that edge is changed | ✅ tested |
| Rotate/zoom the model on the tablet, view refreshes after every change | ✅ tested |
| Voice input (local Whisper, recognised text goes into the input box) | ✅ tested (also on the tablet) |
| Voice output: answers read aloud (local Piper), can be switched off, answer questions by voice, echo protection | ✅ tested automatically (tablet check 🟡) |
| Undo/redo, "revert AI turn" | ✅ / 🟡 partly tested |
| Open and save on the PC in SolidCraft, the tablet follows the open file (also on a NAS) | ✅ tested |
| SolidCraft sketches visible on the tablet (yellow, construction lines dashed) | ✅ checked |
| S Pen: pressure → line width, palm rejection, pen button erases, pen draws / finger navigates | ✅ tested automatically (tablet check 🟡) |
| Local AI via Ollama (toggle) | ⛔ experimental, not usable with 8 GB VRAM |
| Line colours: colour per stroke, you define the meaning by voice/text ("green is a Ø 4 hole") | ✅ tested (tablet use 🟡) |
| Stroke vectorisation, native dimensioned SolidCraft sketches | 📋 planned |
| Wireless over Wi-Fi (no USB) | 📋 planned |

✅ tested · 🟡 implemented, not fully tested · 📋 planned · ⛔ on hold

## Architecture

```
Tablet (Firefox)                      PC
┌──────────────────────┐   WebSocket  ┌──────────────────────────────┐ control chan. ┌────────────┐
│ three.js view        │◄────────────►│ Studio service (Python)      │◄────────────►│ SolidCraft │
│ pen layer, AI chat   │   /model.glb │  · GLB export on change      │  127.0.0.1   │  (app)     │
│ microphone           │   /stt       │  · checkpoints, saving       │              └─────▲──────┘
└──────────────────────┘  adb reverse │  · Whisper (speech → text)   │                    │
                                      │  · agent: Claude Code ───────┼── MCP ─────────────┘
                                      └──────────────────────────────┘
```

- **View:** After every change the studio exports the model as GLB (`file.export`). The tablet shows it
  with three.js in SolidCraft world coordinates (mm, Z up). The app on the PC shows the same model.
- **Pen:** Every stroke point gets a 3D anchor: the hit on the model with its face normal, otherwise
  the ground plane Z = 0. Circled areas are also sampled inside. The agent receives a picture of the
  view with the strokes, the 3D points and the camera (`ui.camera` format). It uses the points as
  edge and face picks.
- **Agent:** A long-running `claude -p` process (stream-json). It has **no** shell and no file access,
  only the SolidCraft MCP server. Saving, opening and exporting are blocked for it, and file paths are
  limited to the studio folder. The system prompt is in `studio/agent.py`.
- **Voice:** Everything runs locally on the PC, no audio goes to the internet.
  - Input: the browser microphone records (MediaRecorder, Opus), the PC transcribes with faster-whisper
    (`large-v3-turbo`, German).
  - Output: the PC reads answers aloud with [Piper](https://github.com/OHF-Voice/piper1-gpl) (voice
    `de_DE-thorsten-medium`, downloaded on first start to `~/.local/share/solidcraft-ai-studio/voices`).
  - Questions: after a question from the AI, the microphone listens automatically (👂) and stops at a
    pause in speech.
  - Echo protection: reading aloud and recording never overlap. Recordings that match what was just read
    aloud are discarded by the PC.
- **Pen and fingers:**
  - Only the pen (and the left mouse button) draws. Fingers rotate, zoom and pan.
  - A palm is ignored: while the pen writes or hovers, for 600 ms after that, and when the contact is
    large (≥ 40 px).
  - If the pen touches down while a finger is on the screen, navigation is blocked until the stroke ends.
  - Thresholds: `PALM_MS` and `PALM_SIZE` in `web/app.js`.
- **Colours:** Every stroke keeps its colour. It is visible in the picture and included in the stroke
  data. You tell the AI in words what a colour means, there are no built-in colour functions. The AI
  reports the legend back, the studio shows it on the palette, saves it with the project and passes it
  to every turn. Several colours with different tasks in one turn work.
- **Security:**
  - The service listens on `127.0.0.1` only and checks the Host header.
  - It requires an access key, stored as a cookie.
  - The tablet connects via `adb reverse` over USB.
  - There are no API keys in the browser or the service: Claude Code uses its own login on the PC.
- **Nothing gets lost:**
  - A checkpoint (`edit.checkpoint`) is set before every AI turn.
  - You open, create and save files **on the PC in SolidCraft**, also directly on a NAS. The tablet
    follows the file open there; it never opens or saves anything itself.
  - Every turn (picture, text, strokes, 3D points, camera) is kept next to the file in `<file>.studio/`,
    before the first save in `~/CAD/ai-studio/sitzungen/`. Saving on the PC takes the turns along.

## Install and run

Requirements:
- Linux, SolidCraft ≥ 0.44 (`solidcraft`, `solidcraft-cli` on `PATH`)
- [uv](https://docs.astral.sh/uv/), [Claude Code](https://claude.com/claude-code) (logged in)
- For the tablet: `adb`, USB debugging, Firefox
- For voice: ideally an NVIDIA GPU. The Whisper model (~1.6 GB) and the Piper voice (~63 MB) are
  downloaded on first start.

```bash
git clone https://github.com/TheTuner24/solidcraft-ai-studio.git
cd solidcraft-ai-studio
./start.sh
```

`start.sh` does everything in one step:
- starts SolidCraft with the control channel (port 7979) if it is not running,
- sets up the USB forwarding and keeps it alive, even after re-plugging,
- starts the studio,
- opens the UI in Firefox on the tablet.

The link with the access key is printed to the console and written to
`~/CAD/ai-studio/.cache/studio-url.txt`. Open the same link in a browser on the PC.

Options:

| Call | Effect |
|---|---|
| `./start.sh --model sonnet` | different Claude model |
| `./start.sh --no-speech` | without speech recognition |
| `./start.sh --no-voice` | without voice output |
| `./start.sh --local-model NAME` | Ollama model for "Lokal" |
| `CONTROL_PORT`, `STUDIO_PORT`, `STUDIO_WHISPER_MODEL`, `STUDIO_PIPER_VOICE` | ports, Whisper model, Piper voice |

**Desktop menu entry** (optional):

```bash
sed "s#@DIR@#$PWD#" packaging/solidcraft-ai-studio.desktop.in > ~/.local/share/applications/solidcraft-ai-studio.desktop
```

The studio has its own icon (tablet with pen and an "AI" badge), so it is not mixed up with plain
SolidCraft in the menu or favourites. If SolidCraft is already a favourite, replace it with the
studio: only the studio starts SolidCraft with the control channel and the tablet interface.

## Usage

| Input | Effect |
|---|---|
| pen | draw and mark (pressure = line width) |
| colour dot in the toolbar | choose the stroke colour. The meaning you gave the AI is shown below it. |
| pen button held, eraser end or "Radierer" tool | erase strokes |
| ↩ Strich / ✕ Alle | remove the last stroke / all strokes |
| ⤺ Skizze | bring back the last sent sketch with its view angle, correct it and send again. "KI-Runde" brings it back automatically. Also after a restart: when you open a file on the PC, its last sketch is offered here. If the last turn was not saved yet, sketch and text come back right away. |
| one finger | rotate the model |
| two fingers | zoom and pan |
| mouse on the PC | left draws, right rotates, middle pans, wheel zooms |
| 🎤 tap – speak – tap | recognised text goes into the input box, check it, then send. While reading aloud: stops the voice and starts recording. |
| 🔊 / 🔇 | read answers aloud on/off |
| 👂 | listen automatically after a question on/off |
| Ctrl+Enter | send |
| KI-Runde | revert the last AI turn completely |
| An PC | SolidCraft takes over the tablet's camera |
| Online / Lokal | AI via Claude or via a local Ollama model |

The UI is in German.

## Functional test

A reproducible test (automated in the browser, plus a tablet checklist) is in
**[docs/FUNKTIONSTEST.md](docs/FUNKTIONSTEST.md)** (with an English summary). In short:

```bash
cd tests/funktionstest && npm install && npm run smoke
```

## Contributing and project rules

Rules for development and documentation, also for AI assistants: [CLAUDE.md](CLAUDE.md).

## License

MIT, see [LICENSE](LICENSE). Bundles [three.js](https://threejs.org) 0.170.0 in `web/vendor/` (MIT,
see `web/vendor/THREE-LICENSE`). SolidCraft is not included and is installed separately.

Dependencies are downloaded at install time, not bundled. They include faster-whisper (MIT) and, for
voice output, [piper-tts](https://github.com/OHF-Voice/piper1-gpl) (**GPL-3.0**) with the voice
`de_DE-thorsten-medium` (Thorsten dataset, CC0). To run without the GPL component, start with
`--no-voice` and remove `piper-tts` from `pyproject.toml`.
