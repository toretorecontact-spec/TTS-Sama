# Third-party notices

TTS-Sama is not affiliated with, endorsed by or connected to Bonzi Buddy, L&H,
Microsoft or any of the projects listed below. All trademarks and
product names are the property of their respective owners.

## Components NOT included in this repository

The following are required to build or run the complete application, but are
**not** published here because they are proprietary or third-party binaries.
Obtain them only from sources that give you the right to use them.

- **L&H TruVoice** (`tv_enua.dll`, `tvenuax.dll` and related files) —
  proprietary speech engine. The "Bonzi Buddy" voice is a configuration of
  this engine.
- **Microsoft SAPI 4** (`SPEECH.DLL`, `MSTTSSYN.dll`, and support DLLs such as
  `SPCHTEL.DLL`, `XLISTEN.DLL`, `XTEL.DLL`, `XVOICE.DLL`, `VDICT.DLL`,
  `VTEXT.DLL`, `VCMSHL.DLL`, `XCOMMAND.DLL`, `WRAPSAPI.DLL`, `MSVCRT.DLL`) —
  proprietary Microsoft components.
- **Visual C++ 5 runtime** (`msvcp50.dll`, `msvcirt.dll`) — proprietary
  Microsoft components.
- **eSpeak NG** — open-source speech synthesizer, licensed under the
  **GNU General Public License version 3 or later** (see
  <https://github.com/espeak-ng/espeak-ng>). If you distribute a build that
  includes eSpeak NG, you must comply with that license, including providing
  the corresponding source and the GPL license text. This repository contains
  no eSpeak NG binaries.
- **Node.js** — used to build the single-file executable and as the runtime
  embedded by Node SEA. Node.js is licensed under the **MIT License**. See
  <https://nodejs.org/>.
- **postject** — build-time tool for injecting the SEA blob, MIT licensed.
- **Bonzi Buddy** — the voice preset is referenced for compatibility only. No
  Bonzi Buddy program, data or artwork is included.

## Content included in this repository

- **Speech filtering word lists** — `offensive-blanket.txt` and
  `offensive-standalone.txt` come from
  [BurntRouter/filtered-word-lists](https://github.com/BurntRouter/filtered-word-lists).
  The upstream repository README grants permission to "use and contribute as
  you please", but does not publish an explicit software license. Verify the
  current terms upstream before redistributing them.
- **MIDI tracks** in `midi/` — 23 short scale/arpeggio sequences bundled as
  data for the MIDI button.
- **Interface dingle** — the button sound is generated in the browser as pure
  sine-wave bell notes; no recorded audio is bundled.
- **Icon** — `installer/setup.ico` is a simple generated icon.

## Development tools

- **OpenCode** — the AI coding agent used to build and rebrand this project.
  It is a development tool only and is not bundled with or required by the app.

## Code

The source files in this repository are original to this project except where
noted above. See [LICENSE](LICENSE) for the terms that apply to them.
