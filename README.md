# TTS-Sama

Reads a Twitch channel's chat out loud, with a Windows 95-style control panel.
No Twitch login or OAuth — it connects to Twitch IRC anonymously and read-only.

> **This repository is source code only.** It does **not** contain compiled
> executables, the Bonzi Buddy / L&H TruVoice DLLs, or the eSpeak NG engine.
> Those components are proprietary or third-party and must be obtained and
> built locally according to [BUILD.md](BUILD.md) and
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). See
> [License / legal](#license--legal) below.

## What the finished app does

- Reads any Twitch channel's chat aloud, fully offline for speech.
- Starts with the **Bonzi Buddy** voice when the L&H TruVoice engine is
  available: `Adult Male #2, American English (TruVoice)` (mode
  `{CA141FD0-AC7F-11D1-97A3-006008273001}`), pitch 140, speed 157 — the
  settings from Bonzi's own `Bonzi.acs`.
- Voice list of up to **501 entries**: classic SAPI 4 voices (Sam, Mary, Mike,
  whispers, space/hall/stadium effects, RoboSoft), SAPI 5 voices (Zira, Maria),
  eSpeak NG voices (Italian, Japanese, Klingon, Elvish, and many more), plus
  401 goofy variants (Deep, Chipmunk, Baby, Monster) of every voice.
- **Voice Setup** window: no elevation just to open it; the Microsoft and Bonzi
  voice install buttons ask for UAC only after an explicit click. Can also
  repair the portable files and retry the speech engine.
- Portable, no-admin design: no installer, no system-wide registration and no
  registry changes for normal use. The speech helpers unpack to
  `%LOCALAPPDATA%\TwitchSam\` on first run.
- The EXE is patched to the Windows **GUI subsystem (2)** so no console, cmd,
  PowerShell or Node window appears. The only visible window is the control
  panel.
- Dark neutral theme with Windows 95-style beveled buttons, a transparent logo
  and tooltips that appear **below** the hovered control.
- 🎵 Annoying MIDI button: plays one of 23 bundled high-BPM scale/arpeggio MIDI
  tracks through the Windows Microsoft GS Wavetable Synth with a randomly
  chosen General MIDI instrument. ⏹ Stop MIDI cuts it off instantly.
- Button presses play a soft rising bell dingle generated in the browser — no
  sound files or downloads.
- The browser "Do you want to translate this page?" bubble is suppressed.

## The control panel

Double-click `TwitchSamaTTS.exe`:

1. Type a channel name (or a `twitch.tv/...` URL).
2. Click **Start**.
3. Chat is read aloud. Type `test` and press **Start** for a fake channel that
   makes up random messages, so you can try voices and effects without Twitch.

Panel buttons: **Start**, **Stop**, **Skip message**, **Test chat**, **Language**
filter, **Voice**, 🎲 Random voice, 🎲 Funny voice, 🎲 Auto pitch + speed,
**Reset FX**, **Auto FX**, **Auto voice**, **Read names**, **Speed** / **Volume**
sliders, 🔊 Sound, 🎵 Annoying MIDI, ⏹ Stop MIDI, and **Open Voice Setup**.

Closing the panel window closes the app.

## Command line

```
TwitchSamaTTS.exe xqc
TwitchSamaTTS.exe twitch.tv/sodapoppin
TwitchSamaTTS.exe https://www.twitch.tv/kaicenat
TwitchSamaTTS.exe --gui
TwitchSamaTTS.exe --voice "eSpeak - Italian"
TwitchSamaTTS.exe test
```

| Option | Meaning |
|---|---|
| `--gui`, `-g` | Open the control panel (default with no arguments) |
| `--port N` | Panel port (normally automatic) |
| `--rate N` | Speech speed, -10 (slow) to 10 (fast) |
| `--volume N` | Volume 0–100 |
| `--voice NAME` | Use a voice whose name contains NAME |
| `--no-names` | Read messages without usernames |
| `--max-queue N` | Max queued messages (default 4) |
| `--test N` | Connect, print N messages without speaking, then exit |

Console commands while running: `/skip`, `/test`, `/auto [seconds]`,
`/rate N`, `/volume N`, `/voice NAME`, `/random`, `/funnyrandom`, `/fx`,
`/fx reset`, `/autofx`, `/names on|off`, `/voicesetup`, `/q`.

## Speech censorship

A spoken message is skipped entirely when it contains a slur or hate term.
**Only the audio is filtered** — the panel chat feed still shows exactly what
people typed. Ordinary profanity is deliberately allowed. Filtering is local,
using two bundled lists from
[BurntRouter/filtered-word-lists](https://github.com/BurntRouter/filtered-word-lists)
(`offensive-blanket.txt` and `offensive-standalone.txt`). Capitalisation,
accents, symbols between letters, spaced/stretched letters and leetspeak are
handled.

## Repository layout

| Path | Purpose |
|---|---|
| `twitch-sam.js` | Main host: Twitch IRC, speech queue, control panel |
| `sapi4-tts.cs` | C# 5 speech helper source (SAPI 4 / eSpeak) |
| `voice-setup.cs` | Voice Setup window source |
| `voice-setup.manifest` | UAC manifest for Voice Setup (`requireAdministrator`) |
| `midi-play.cs` | MIDI playback helper source |
| `build-voice-setup.ps1` | Builds Voice Setup and its two payload files |
| `patch-gui.js` | Flips the built EXE to the GUI subsystem |
| `sea-config.json` | Node SEA asset manifest (references local, excluded binaries) |
| `offensive-*.txt` | Speech filtering word lists |
| `midi/` | 23 MIDI tracks |
| `installer/` | Optional administrator installer source |

## Building

See [BUILD.md](BUILD.md). In short: compile the C# helpers with the .NET 4
`csc.exe`, supply the third-party speech DLLs and eSpeak NG engine locally,
build the payload files, inject the Node SEA blob with `postject`, then run
`patch-gui.js`.

The C# sources are kept compatible with the C# 5 compiler shipped with .NET
Framework 4 — no inline `out` variables, local functions or string
interpolation.

## License / legal

The code in this repository is **all rights reserved** unless the author says
otherwise; see [LICENSE](LICENSE). Redistribution of the compiled app requires
separate rights to the proprietary third-party components it uses.

This project is not affiliated with, endorsed by or connected to Bonzi Buddy,
L&H, Microsoft or Twitch. All trademarks belong to their respective owners.
See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for details.
