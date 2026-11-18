# Building TTS-Sama from source

Everything in this repository is source (plus text/audio data). **No compiled
binaries and no proprietary speech DLLs are included.** You must supply those
locally, from copies you are legally allowed to use.

## Prerequisites (Windows)

- Node.js 18 or newer (must support `--experimental-sea-config`) and npm.
- .NET Framework 4 developer tools, specifically
  `C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe` and the .NET 4
  reference assemblies (for `System.Speech.dll`).
- The `postject` npm package used to inject the Node SEA blob.
- Your own legally obtained copies of the SAPI 4 / L&H TruVoice DLLs and a
  copy of eSpeak NG. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The C# sources target **C# 5** so the old .NET 4 compiler can build them. Keep
that constraint if you edit them: no inline `out` variables, no local functions
and no string interpolation.

## 1. Compile the C# helpers

From the repository root:

```bat
C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /platform:x86 /out:sapi4-tts.exe /r:System.Web.Extensions.dll /r:"C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.0\System.Speech.dll" sapi4-tts.cs

C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /target:winexe /platform:x86 /out:midi-play.exe midi-play.cs
```

`sapi4-tts.cs` is the speech helper; `midi-play.cs` is the MIDI playback helper.

## 2. Supply the third-party speech files

Create these local files (they are **not** in the repository and are ignored by
Git):

| Local path | What it is |
|---|---|
| `sapi4\SPEECH.DLL` | Microsoft SAPI 4 runtime |
| `sapi4\MSTTSSYN.dll` | Microsoft SAPI 4 synthesizer |
| `sapi4\tv_enua.dll` | L&H TruVoice English engine |
| `sapi4\tvenuax.dll` | L&H TruVoice English engine (extra) |
| `sapi4\msvcp50.dll` | Visual C++ 5 runtime |
| `sapi4\msvcirt.dll` | Visual C++ 5 runtime |
| `espeak-pack.zip` | Archive of eSpeak NG (`espeak-ng.exe` + `espeak-ng-data`) |

`voice-setup.cs` expects two generated containers next to it:

- `voice-setup-portable.bin` — a `TSE1` archive of the files in `sapi4\`.
- `engine-slim.bin` — a `TSE1` archive of the core DLLs plus the support DLLs
  listed in `build-voice-setup.ps1`.

`build-voice-setup.ps1` builds Voice Setup and both containers:

```powershell
.\build-voice-setup.ps1
```

It expects the extra support DLLs in `installer\engine-stage\` (for example
`SPCHTEL.DLL`, `XLISTEN.DLL`, `XTEL.DLL`, `XVOICE.DLL`, `VDICT.DLL`,
`VTEXT.DLL`, `VCMSHL.DLL`, `XCOMMAND.DLL`, `WRAPSAPI.DLL`, `MSVCRT.DLL`). Those
files are also proprietary and must be supplied locally.

The optional administrator installer is in `installer\`. Its build script takes
the paths of your locally extracted SAPI 4 / TruVoice installer files:

```powershell
.\installer\build-installer.ps1 `
  -SapiExtract <folder> -TvExtract <folder> `
  -SapiExe <spchapi.exe> -TvExe <tv_enua.exe>
```

## 3. Build the single-file EXE

The SEA asset list is in `sea-config.json`. It references the binaries above by
relative path; all of them must exist locally before this step.

```bat
node --experimental-sea-config sea-config.json
copy /Y "%ProgramFiles%\nodejs\node.exe" TwitchSamaTTS.exe
npx postject TwitchSamaTTS.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
node patch-gui.js TwitchSamaTTS.exe
```

`patch-gui.js` changes the PE subsystem from console (3) to GUI (2) so no
Node/cmd window appears. Verify with a PE inspector that the final EXE reports
subsystem `2`.

## Development mode (no SEA build)

For quick iteration, run the script directly with the helpers next to it:

```bat
node twitch-sam.js <channel>
node twitch-sam.js test
node twitch-sam.js --gui
```

In this mode the app looks for `sapi4-tts.exe`, `midi-play.exe`,
`voice-setup.exe`, the word lists, `midi\` and an `espeak\` folder beside the
script.

## Important

Building the full app requires third-party components that this repository
intentionally does not redistribute. If you do not have the rights to those
components, you can still run the app with Microsoft SAPI 4 voices only by
adjusting `sea-config.json` and the local asset set.
