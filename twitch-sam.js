#!/usr/bin/env node
// TwitchSamaTTS - reads any Twitch channel's chat out loud with the Microsoft Sam
// voice (SAPI4). Zero dependencies: Node's built-in WebSocket listens to chat;
// sapi4-tts.exe (embedded in the single-file build) does the speaking.
// Run with --gui (or no arguments) to open the control panel window.
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

// When bundled as a single-file EXE, sapi4-tts.exe lives inside this file as
// a SEA asset. Extract it to local app data so the helper can be spawned.
function resolveHelper() {
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) {
      const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam');
      fs.mkdirSync(dir, { recursive: true });
      const exe = path.join(dir, 'sapi4-tts.exe');
      fs.writeFileSync(exe, Buffer.from(sea.getAsset('sapi4-tts.exe')));
      return exe;
    }
  } catch {}
  return path.join(__dirname, 'sapi4-tts.exe');
}

// SAPI 4 itself and both TTS engines are bundled too. Loading them directly
// from this folder avoids system-wide installation entirely, so the app stays
// portable and needs no administrator rights.
function setupSapi4Portable() {
  const files = [
    'SPEECH.DLL', 'MSTTSSYN.dll', 'tv_enua.dll',
    'tvenuax.dll', 'msvcp50.dll', 'msvcirt.dll'
  ];
  let dir;
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) {
      dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam', 'sapi4');
      fs.mkdirSync(dir, { recursive: true });
      for (const name of files) {
        try { fs.writeFileSync(path.join(dir, name), Buffer.from(sea.getAsset('sapi4/' + name))); } catch {}
      }
      process.env.TS_SAPI4_DIR = dir;
      return dir;
    }
  } catch {}
  dir = path.join(__dirname, 'sapi4');
  if (files.every(n => fs.existsSync(path.join(dir, n)))) {
    process.env.TS_SAPI4_DIR = dir;
    return dir;
  }
  return null;
}

// The MIDI helper drives the Windows General MIDI synthesizer (winmm). Like
// the speech helper it is bundled as a SEA asset and extracted once.
function resolveMidiHelper() {
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) {
      const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam');
      fs.mkdirSync(dir, { recursive: true });
      const exe = path.join(dir, 'midi-play.exe');
      fs.writeFileSync(exe, Buffer.from(sea.getAsset('midi-play.exe')));
      return exe;
    }
  } catch {}
  return path.join(__dirname, 'midi-play.exe');
}

// Voice Setup is a tiny GUI that opens only when the speech helper reports no
// engines. It is an SEA asset too, so the main EXE still needs no side files.
function resolveVoiceSetup() {
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) {
      const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam');
      fs.mkdirSync(dir, { recursive: true });
      const exe = path.join(dir, 'voice-setup.exe');
      fs.writeFileSync(exe, Buffer.from(sea.getAsset('voice-setup.exe')));
      // The slim Voice Setup reads its DLL payloads from side files instead of
      // embedded .NET resources, so place them beside the extracted EXE.
      for (const name of ['engine-slim.bin', 'voice-setup-portable.bin']) {
        try { fs.writeFileSync(path.join(dir, name), Buffer.from(sea.getAsset(name))); } catch {}
      }
      return exe;
    }
  } catch {}
  return path.join(__dirname, 'voice-setup.exe');
}

// Small ZIP reader for the bundled eSpeak pack. Keeping the extraction in this
// file avoids starting a helper shell just to unpack bundled data.
function extractZipSync(zipPath, destDir) {
  const b = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid voice archive');
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid archive entry');
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (b.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid archive header');
    const lNameLen = b.readUInt16LE(local + 26);
    const lExtraLen = b.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = b.subarray(start, start + compSize);
    if (!name.endsWith('/')) {
      let out;
      if (method === 0) out = data;
      else if (method === 8) out = zlib.inflateRawSync(data);
      else throw new Error('Unsupported archive compression: ' + method);
      const parts = name.split('/').filter(x => x && x !== '.' && x !== '..');
      const target = path.join(destDir, ...parts);
      if (target !== destDir && !target.startsWith(destDir + path.sep)) {
        throw new Error('Unsafe archive path');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
}

// The eSpeak NG voice engine is bundled as a zip inside the EXE. Extract it
// once to local app data, then tell the speech helper where to find it.
function setupEspeak() {
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam', 'espeak');
  const exe = path.join(dir, 'espeak-ng.exe');
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) {
      if (!fs.existsSync(exe)) {
        fs.mkdirSync(dir, { recursive: true });
        const zipPath = path.join(dir, 'espeak-pack.zip');
        fs.writeFileSync(zipPath, Buffer.from(sea.getAsset('espeak-pack.zip')));
        try {
          extractZipSync(zipPath, dir);
        } catch {}
        try { fs.unlinkSync(zipPath); } catch {}
      }
      if (fs.existsSync(exe)) { process.env.TS_ESPEAK_EXE = exe; return exe; }
    }
  } catch {}
  // development fallback: a folder next to the script
  const local = path.join(__dirname, 'espeak', 'espeak-ng.exe');
  if (fs.existsSync(local)) { process.env.TS_ESPEAK_EXE = local; return local; }
  return null;
}

// ---------------------------------------------------------- speech censoring
// Offensive-word lists are bundled as SEA assets, copied unchanged from the
// public BurntRouter/filtered-word-lists project. Filtering is entirely local
// - no chat text is sent anywhere. Only the SPOKEN copy is filtered; the panel
// still shows every message exactly as it was typed.
//
//   blanket    - terms blocked wherever they appear in a message
//   standalone - terms blocked only when the whole message is that term
//                (this split avoids masking ordinary words used in sentences)

function loadWordListAsset(name) {
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) return Buffer.from(sea.getAsset(name)).toString('utf8');
  } catch {}
  try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); } catch {}
  return '';
}

// Normalise both the lists and the chat text the same way. This catches caps,
// accented letters, symbol substitutions, stretched letters and leetspeak.
function normalizeSpeechChunk(s) {
  let t = String(s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch {}
  t = t.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a')
       .replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a').replace(/\$/g, 's')
       .replace(/!/g, 'i').replace(/\|/g, 'l');
  t = t.replace(/[^a-z0-9]/g, '');   // drop punctuation and stray symbols
  t = t.replace(/(.)\1{2,}/g, '$1'); // stretched words: ffff -> f
  return t;
}

function normalizeListEntry(entry) {
  return String(entry).toLowerCase().split(/\s+/).map(normalizeSpeechChunk).filter(Boolean);
}

// Split a message into comparable pieces. Runs of spaced-out single letters
// are glued back together so "s p a m" style spelling still matches.
function speechPieces(text) {
  const pieces = [];
  let singles = '';
  const flush = () => { if (singles) { pieces.push(singles); singles = ''; } };
  for (const chunk of String(text).split(/\s+/)) {
    const t = normalizeSpeechChunk(chunk);
    if (!t) continue;
    if (t.length === 1) singles += t;
    else { flush(); pieces.push(t); }
  }
  flush();
  return pieces;
}

function containsSequence(pieces, seq) {
  if (!seq.length || seq.length > pieces.length) return false;
  outer: for (let i = 0; i <= pieces.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (pieces[i + j] !== seq[j]) continue outer;
    return true;
  }
  return false;
}

const blanketEntries = loadWordListAsset('offensive-blanket.txt')
  .split(/\r?\n/).map(normalizeListEntry).filter(e => e.length);
const standaloneEntries = loadWordListAsset('offensive-standalone.txt')
  .split(/\r?\n/).map(normalizeListEntry).filter(e => e.length);

// Single-token blanket terms of 4+ letters are also matched inside a longer
// piece, to catch words that have been run together or padded with junk.
const blanketShortSet = new Set();
const blanketSubstringSet = new Set();
const blanketMulti = [];
for (const e of blanketEntries) {
  if (e.length !== 1) { blanketMulti.push(e); continue; }
  if (e[0].length < 4) blanketShortSet.add(e[0]);
  else blanketSubstringSet.add(e[0]);
}

function containsBlockedSubstring(pieces, blocked) {
  for (const p of pieces) {
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 4; j <= p.length; j++) {
        if (blocked.has(p.slice(i, j))) return true;
      }
    }
  }
  return false;
}

function shouldCensorSpeech(text) {
  const pieces = speechPieces(text);
  if (!pieces.length) return false;

  // Standalone terms only fire when the entire message is that term.
  const flat = pieces.join('');
  for (const e of standaloneEntries) if (e.join('') === flat) return true;

  // Blanket terms fire anywhere.
  for (const term of blanketShortSet) if (pieces.includes(term)) return true;
  if (containsBlockedSubstring(pieces, blanketSubstringSet)) return true;
  for (const seq of blanketMulti) if (containsSequence(pieces, seq)) return true;
  return false;
}

// ---------------------------------------------------------- annoying MIDI pack
// 23 short MIDI files are bundled into the EXE as SEA assets. The panel asks
// for one at random through /midi and synthesizes it with Web Audio - no media
// player, codecs or downloads are needed. Only a label and the raw bytes cross
// the local HTTP connection.
const MIDI_TRACKS = [
  ['midi-00.mid', 'Arabic (Double Harmonic) - C'],
  ['midi-01.mid', 'Arabic (Double Harmonic) - D'],
  ['midi-02.mid', 'Blues - F#'],
  ['midi-03.mid', 'Blues - G#'],
  ['midi-04.mid', 'Diminished (Whole-Half) - C#'],
  ['midi-05.mid', 'Diminished (Whole-Half) - F'],
  ['midi-06.mid', 'Harmonic Minor - F#'],
  ['midi-07.mid', 'Harmonic Minor - G# (alt)'],
  ['midi-08.mid', 'Harmonic Minor - G#'],
  ['midi-09.mid', 'Japanese (Ichikosucho) - A#'],
  ['midi-10.mid', 'Locrian Mode - D'],
  ['midi-11.mid', 'Lydian Mode - A#'],
  ['midi-12.mid', 'Lydian Mode - F'],
  ['midi-13.mid', 'Major Bebop - B'],
  ['midi-14.mid', 'Major Scale - C (2 bars, calm)'],
  ['midi-15.mid', 'Major Scale - G#'],
  ['midi-16.mid', 'Minor Bebop - F'],
  ['midi-17.mid', 'Minor Bebop - G'],
  ['midi-18.mid', 'Minor Scale - C#'],
  ['midi-19.mid', 'Mixolydian Mode - A'],
  ['midi-20.mid', 'Pentatonic Minor - C#'],
  ['midi-21.mid', 'Phrygian Dominant - F'],
  ['midi-22.mid', 'Whole Tone Scale - A']
];

function loadMidiAsset(name) {
  try {
    const sea = require('node:sea');
    if (sea.isSea() && sea.getAsset) return Buffer.from(sea.getAsset(name));
  } catch {}
  try { return fs.readFileSync(path.join(__dirname, 'midi', name)); } catch {}
  return null;
}

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
const options = {
  channel: null,
  gui: args.length === 0,   // double-click / no args -> open the panel
  rate: null,               // -10..10 (SAPI-style, 0 = normal)
  volume: null,             // 0..100
  voice: null,              // preferred voice name substring
  names: false,
  maxQueue: 4,
  test: 0,
  port: 0,                  // GUI: 0 = pick a free port
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  else if (a === '--gui' || a === '-g') options.gui = true;
  else if (a === '--port') options.port = parseNum(args[++i], 'port');
  else if (a.startsWith('--port=')) options.port = parseNum(a.split('=')[1], 'port');
  else if (a === '--no-names') options.names = false;
  else if (a === '--rate') options.rate = parseNum(args[++i], 'rate');
  else if (a.startsWith('--rate=')) options.rate = parseNum(a.split('=')[1], 'rate');
  else if (a === '--volume') options.volume = parseNum(args[++i], 'volume');
  else if (a.startsWith('--volume=')) options.volume = parseNum(a.split('=')[1], 'volume');
  else if (a === '--voice') options.voice = args[++i];
  else if (a.startsWith('--voice=')) options.voice = a.split('=')[1];
  else if (a === '--max-queue') options.maxQueue = parseNum(args[++i], 'max-queue');
  else if (a.startsWith('--max-queue=')) options.maxQueue = parseNum(a.split('=')[1], 'max-queue');
  else if (a === '--test') options.test = parseNum(args[++i], 'test');
  else if (a.startsWith('--test=')) options.test = parseNum(a.split('=')[1], 'test');
  else if (!a.startsWith('-') && !options.channel) options.channel = a;
  else if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(1); }
}

function parseNum(v, name) {
  const n = parseInt(v, 10);
  if (isNaN(n)) { console.error(`Invalid number for --${name}`); process.exit(1); }
  return n;
}

function printHelp() {
  console.log(`TwitchSamaTTS - read a Twitch chat out loud (Bonzi Buddy by default)

Usage: TwitchSamaTTS [channel-or-url] [options]
       TwitchSamaTTS --gui      open the control panel window

  channel-or-url   channel name, or a URL like https://www.twitch.tv/channelname
                   (also works with /popout/.../chat links)

Options:
  --gui, -g        open the button control panel (default if no arguments)
  --port N         GUI panel port (default: automatic)
  --rate N         speech speed, -10 (slow) to 10 (fast), default 0
  --volume N       volume 0-100, default 100
  --voice NAME     switch to a voice whose name contains NAME (default: Bonzi Buddy)
  --no-names       don't read usernames, only the messages
  --max-queue N    max messages waiting while speech is behind (default 4)
  --test N         connect, print N messages to the console, don't speak, exit
  -h, --help       show this help

Console commands while running:
  /skip            throw away everything waiting (and stop the current message)
  /test            start a fake channel with random chat messages (no Twitch)
  /auto [sec]      toggle automatic voice switching (default 45 seconds)
  /rate N          change speech speed (-10 slow .. 10 fast)
  /volume N        change volume (0-100)
  /voice NAME      change voice (no NAME lists installed voices)
  /random          pick a random voice (dice button in the panel)
  /funnyrandom     pick a random funny voice (funny dice button)
  /fx              random pitch + speed for the current voice (FX dice)
  /fx reset        put pitch + speed back to normal
  /autofx          toggle a different pitch + speed for every message
  /names on|off    read usernames or not
  /voicesetup      open Voice Setup (install/repair speech voices)
  /q               quit`);
}

if (!options.channel && !options.gui) { printHelp(); process.exit(1); }

// ------------------------------------------------------------ channel parse
function parseChannel(raw) {
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, '').replace(/^(www|m)\./i, '');
  if (/^twitch\.tv/i.test(s)) {
    const segs = s.split('/').filter(Boolean).slice(1); // after "twitch.tv"
    if (segs.length === 0) return null;
    let c = segs[0];
    if (c === 'popout' && segs.length > 1) c = segs[1];
    else if (c === 'videos' && segs.length > 1) c = segs[1];
    s = c;
  }
  s = s.split(/[?#]/)[0].replace(/\/+$/, '').trim().toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
}

// ------------------------------------------------------------- text cleanup
const BOTS = new Set(['nightbot', 'streamelements', 'moobot', 'streamlabs', 'fossabot', 'wizebot', 'sery_bot']);

function cleanText(raw) {
  let t = String(raw);
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ');
  t = t.replace(/(https?:\/\/|www\.)\S+/gi, ' link ');
  t = t.replace(/@([A-Za-z0-9_]{2,})/g, '$1');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ');
  t = t.replace(/[\u0300-\u036F]/g, '');
  t = t.replace(/[\u2500-\u25FF]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 280) t = t.slice(0, 280).trim() + ' ...';
  return t;
}

// ------------------------------------------------------------ speech host
// Protocol (one JSON object per line):
//   host -> {"op":"modes","modes":[...],"selected":...,"selectedName":...}
//   app  -> {"op":"speak","text","rate","volume"} -> {"op":"ready"}
//   app  -> {"op":"select","name":"Sam"} -> {"op":"selected"} | {"op":"error"}
const hostExe = resolveHelper();
const midiHelper = resolveMidiHelper();
setupSapi4Portable(); // loads Sam + TruVoice straight from the bundled DLLs
setupEspeak(); // makes the extra funny voices available to the helper
if (!fs.existsSync(hostExe)) {
  console.error(`Missing speech helper: ${hostExe}`);
  process.exit(1);
}

let curRate = options.rate === null ? 0 : Math.max(-10, Math.min(10, options.rate));
let curVolume = options.volume === null ? 100 : Math.max(0, Math.min(100, options.volume));
let curPitchFx = -1; // normalized -100..100 from the auto pitch+speed dice; -1 = normal
let autoFx = false;  // when ON, every spoken message gets its own random pitch + speed
let lastFx = null;   // last per-message roll, shown on the panel button
let pendingVoice = options.voice || 'Bonzi Buddy';

let host = null;
let hostReady = false;
let speaking = false;
const midiProcs = new Set();
let midiStopGen = 0;
let shuttingDown = false;
let shownVoiceList = false;
let outBuf = '';
let currentVoice = 'Bonzi Buddy';
let voiceNames = [];
let voiceLanguages = {};

// Voice Setup: shown only for a fatal "no speech engines" init error.
let hostFatal = false;
let voiceSetupNeeded = false;
let voiceSetupError = '';
let voiceSetupLastResult = null;
let voiceSetupMarkerTicks = 0;
let voiceSetupProc = null;

function spawnHost() {
  host = spawn(hostExe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  host.stdin.setDefaultEncoding('utf8');
  host.stdout.setEncoding('utf8');
  host.stderr.setEncoding('utf8');
  outBuf = '';
  host.stdout.on('data', chunk => {
    outBuf += chunk;
    let nl;
    while ((nl = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, nl).trim();
      outBuf = outBuf.slice(nl + 1);
      if (line) handleHostLine(line);
    }
  });
  host.stderr.on('data', d => process.stderr.write('[speech host] ' + d));
  host.on('exit', code => {
    hostReady = false;
    speaking = false;
    if (shuttingDown || hostFatal) return;
    if (code !== 0 && code !== null) console.error(`Speech helper exited (code ${code}).`);
    setTimeout(spawnHost, 150);
  });
}

function sendHost(obj) { try { host.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }

function handleHostLine(line) {
  if (!line.startsWith('{')) { console.log('[speech host] ' + line); return; }
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const op = m.op || '';
  if (op === 'modes') {
    voiceNames = (m.modes || []).map(x => x.modeName).filter(n => n);
    voiceLanguages = voiceLanguageMap(voiceNames);
    currentVoice = m.selectedName || currentVoice;
    // Helper may have restarted - restore an active pitch effect before any speech.
    if (curPitchFx >= 0) sendHost({ op: 'pitch', value: curPitchFx });
    if (!shownVoiceList) {
      shownVoiceList = true;
      console.log('Installed voices: ' + voiceNames.join(', '));
      console.log('Using voice: ' + currentVoice + '  [Microsoft Sam]' + '\n');
    }
    if (pendingVoice) {
      const n = pendingVoice;
      pendingVoice = null;
      sendHost({ op: 'select', name: n });
      // 'selected' will unlock the queue
    } else {
      hostReady = true;
      pumpQueue();
    }
  } else if (op === 'ready') {
    hostReady = true;
    speaking = false;
    pumpQueue();
  } else if (op === 'selected') {
    currentVoice = m.name;
    console.log(`[voice] now using "${m.name}"`);
    hostReady = true;
    speaking = false;
    pumpQueue();
  } else if (op === 'error') {
    console.log('[voice] ' + (m.message || 'error') + (m.stage ? ` (${m.stage})` : ''));
    if (m.stage === 'init') {
      // No engines at all. Stop the restart loop and let the user choose what
      // to install instead of retrying forever in the background.
      hostFatal = true;
      hostReady = false;
      speaking = false;
      openVoiceSetup(m.message || 'No speech engines were found.');
      return;
    }
    if (m.stage === 'speak' || m.stage === 'select') { hostReady = true; speaking = false; pumpQueue(); }
  }
}

function winTicks() {
  // DateTime.UtcNow.Ticks: 100 ns intervals since 1601-01-01 UTC.
  return (Date.now() + 11644473600000) * 10000;
}

function voiceMarkerPath() {
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam', 'voice-setup-result.json');
}

function openVoiceSetup(errorText) {
  if (shuttingDown) return;
  voiceSetupNeeded = true;
  voiceSetupError = String(errorText || 'No speech engines were found.');

  // Already open? Do not stack windows on every helper restart.
  if (voiceSetupProc && voiceSetupProc.exitCode === null) return;

  try {
    const exe = resolveVoiceSetup();
    if (!fs.existsSync(exe)) throw new Error(`Missing Voice Setup: ${exe}`);
    voiceSetupMarkerTicks = winTicks();
    voiceSetupProc = spawn(exe, [voiceSetupError], {
      stdio: 'ignore', windowsHide: false, detached: true
    });
    voiceSetupProc.on('exit', () => { voiceSetupProc = null; });
    voiceSetupProc.unref();
    console.log('Voice Setup opened. Choose which voices to install.');
  } catch (e) {
    console.error('Could not open Voice Setup: ' + e);
  }
}

function checkVoiceSetupResult() {
  if (shuttingDown || !voiceSetupNeeded || hostFatal === false) return;
  try {
    if (!fs.existsSync(voiceMarkerPath())) return;
    const j = JSON.parse(fs.readFileSync(voiceMarkerPath(), 'utf8'));
    const ts = Number(j.ts || 0);
    if (!ts || ts <= voiceSetupMarkerTicks) return; // stale marker from an old run
    voiceSetupMarkerTicks = ts;
    voiceSetupLastResult = {
      ok: !!j.ok, retry: !!j.retry, action: String(j.action || ''),
      message: String(j.message || '')
    };
    if (voiceSetupLastResult.ok || voiceSetupLastResult.retry) {
      console.log('[voice] setup result: ' + (voiceSetupLastResult.message || voiceSetupLastResult.action));
      voiceSetupNeeded = false;
      voiceSetupError = '';
      hostFatal = false;
      hostReady = false;
      speaking = false;
      setTimeout(spawnHost, 250);
    }
  } catch {}
}
setInterval(checkVoiceSetupResult, 500);

// ---------------------------------------------------------------- queueing
const queue = [];
let dropped = 0;
const recent = []; // last chat lines for the GUI panel

function addRecent(who, text) {
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  recent.push({ t: stamp, who, text });
  if (recent.length > 60) recent.shift();
}

function rateMultiplier() { return Math.pow(2, curRate / 10); }

function rollFx() {
  // Clearly audible but not absurd: pitch +/-20..50, speed +/-2..8.
  const p = 20 + Math.floor(Math.random() * 31);        // 20..50
  const r = 2 + Math.floor(Math.random() * 7);          // 2..8
  return { pitch: Math.random() < 0.5 ? -p : p, speed: Math.random() < 0.5 ? -r : r };
}

function randomPitchSpeed() {
  const fx = rollFx();
  curPitchFx = fx.pitch;
  curRate = fx.speed;
  sendHost({ op: 'pitch', value: curPitchFx });
  console.log(`[fx] auto pitch ${curPitchFx} / speed ${curRate}`);
}

function toggleAutoFx() {
  autoFx = !autoFx;
  console.log(`[fx] different pitch + speed every message: ${autoFx ? 'ON' : 'OFF'}`);
}

function resetPitchSpeed() {
  curPitchFx = -1;
  curRate = 0;
  sendHost({ op: 'pitch', value: -1 });
  console.log('[fx] pitch + speed back to normal');
}

function pumpQueue() {
  if (!hostReady || speaking) return;
  // Voice switches go first, at the boundary between two spoken messages.
  if (pendingSelectName) {
    const name = pendingSelectName;
    pendingSelectName = null;
    speaking = true;
    hostReady = false;
    sendHost({ op: 'select', name });
    return;
  }
  const next = queue.shift();
  if (next === undefined) return;
  speaking = true;
  hostReady = false;
  dbg('SPEAK', next);
  let rate = rateMultiplier(), msgPitch = -1;
  if (autoFx) {
    // One fresh roll per message - the helper applies it to this message only.
    lastFx = rollFx();
    msgPitch = lastFx.pitch;
    rate = Math.pow(2, lastFx.speed / 10);
  }
  sendHost({ op: 'speak', text: next, rate, volume: curVolume / 100, pitch: msgPitch });
}

function dbg(tag, text) {
  if (!process.env.TS_DEBUG) return;
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'ts-debug.log'),
      new Date().toISOString() + ' ' + tag + ' ' + JSON.stringify(text) + '\n');
  } catch {}
}

function enqueueSay(text) {
  dbg('ENQUEUE', text);
  if (options.test > 0) return;
  if (queue.length >= options.maxQueue) {
    queue.shift();
    dropped++;
    if (dropped % 5 === 1) console.log(`[queue] chat too fast, dropped ${dropped} message(s) so far. Use /skip to clear.`);
  }
  queue.push(text);
  pumpQueue();
}

// ------------------------------------------------- automatic voice rotation
let autoVoice = false;
let autoInterval = 45; // seconds
let autoTimer = null;
let autoIndex = 0;
let pendingSelectName = null; // applied at the next idle boundary (between messages)

function queueVoiceSelect(name) {
  // Selecting a different voice restores its natural pitch (the helper clears
  // the override on select), so keep the panel state in sync.
  if (curPitchFx >= 0) { curPitchFx = -1; sendHost({ op: 'pitch', value: -1 }); }
  pendingSelectName = name;
  // if nothing is being spoken, apply it right away; otherwise it waits for
  // the current message to finish (the helper cannot select mid-speech).
  pumpQueue();
}

function setAutoVoice(on) {
  autoVoice = !!on;
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (autoVoice) {
    autoTimer = setInterval(() => {
      if (voiceNames.length < 2) return;
      autoIndex = (autoIndex + 1) % voiceNames.length;
      let name = voiceNames[autoIndex];
      if (name === currentVoice) { autoIndex = (autoIndex + 1) % voiceNames.length; name = voiceNames[autoIndex]; }
      console.log(`[auto] switching voice to "${name}"`);
      queueVoiceSelect(name);
    }, autoInterval * 1000);
  }
  console.log(`[auto] automatic voice switching ${autoVoice ? 'ON every ' + autoInterval + 's' : 'OFF'}`);
}

spawnHost();

// ------------------------------------------------------------------ Twitch
const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
let ws = null;
let testTimer = null;
let channel = null;
let stopped = false;
let reconnectDelay = 2000;
let messageCount = 0;

function connect() {
  if (!channel) return;
  console.log(`Connecting to #${channel} ...`);
  ws = new WebSocket(IRC_URL);

  ws.onopen = () => {
    reconnectDelay = 2000;
    console.log(`Connected. Listening to #${channel} - press Ctrl+C to quit.\n`);
    ws.send('CAP REQ :twitch.tv/tags');
    ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 89999)}`);
    ws.send(`JOIN #${channel}`);
  };

  ws.onmessage = ev => {
    for (const rawLine of String(ev.data).split(/\r?\n/)) {
      if (rawLine.trim()) handleLine(rawLine);
    }
  };

  ws.onclose = () => {
    if (stopped) return;
    console.log(`Disconnected. Retrying in ${reconnectDelay / 1000}s ...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Fake chat channel for testing the whole program without Twitch.
const TEST_NAMES = ['xqc', 'luna', 'toasty', 'pixelpanda', 'nightowl', 'gamer42',
  'kittycat', 'moonbeam', 'streamfan99', 'sunny', 'retro_gamer', 'fuzzball'];
const TEST_LINES = [
  'hello chat', 'anyone watching on mobile?', 'that was actually insane',
  'lets gooooo', 'wait what just happened', 'chat is flying today',
  'first time here, loving the stream', 'bruh', 'the voice is so good lol',
  'can you read this', 'random dice roll', 'good morning everyone',
  'how many voices do we have now', 'this is exactly what I needed',
  'lol that timing', 'we are so back', 'sam is the best', 'test message number two',
  'the chat goes brrr', 'ok that is funny', 'hello from germany', 'hi from brazil',
  'yabba dabba doo', 'what a nice setup', 'this voice is hilarious',
  'turn the speed up', 'can we get a dice roll', 'w stream', 'chat say hi',
  'I love the funny voices', 'this is a test of the speech system',
  'skip message if this is annoying', 'did the voice just change'
];

function testChatMessage() {
  const who = TEST_NAMES[Math.floor(Math.random() * TEST_NAMES.length)];
  const text = TEST_LINES[Math.floor(Math.random() * TEST_LINES.length)];
  messageCount++;
  addRecent(who, text);
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`${stamp} ${who}: ${text}`);
  if (shouldCensorSpeech(text)) { console.log('[censored] skipped a message (offensive language)'); return; }
  enqueueSay(options.names ? `${who} says, ${text}` : text);
}

function scheduleTestMessage() {
  testTimer = setTimeout(() => { testChatMessage(); scheduleTestMessage(); }, 1800 + Math.random() * 1600);
}

function startTestChannel() {
  if (testTimer) { clearTimeout(testTimer); testTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  channel = 'test';
  stopped = false;
  messageCount = 0;
  console.log('Test channel started - making up random chat messages every few seconds.');
  testChatMessage();
  scheduleTestMessage();
}

function startListening(raw) {
  const ch = parseChannel(raw);
  if (!ch) return false;
  if (ch === 'test') { startTestChannel(); return true; }
  // Never open a second connection for the same channel: that would make
  // every chat message arrive (and be spoken) twice.
  if (channel === ch && ws && ws.readyState === WebSocket.OPEN) return true;
  if (testTimer) { clearTimeout(testTimer); testTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} }
  channel = ch;
  stopped = false;
  messageCount = 0;
  connect();
  return true;
}

function stopListening() {
  stopped = true;
  channel = null;
  queue.length = 0;
  if (testTimer) { clearTimeout(testTimer); testTimer = null; }
  try { ws.close(); } catch {}
}

function handleLine(line) {
  let tags = {};
  let rest = line;
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    const tagStr = line.slice(1, sp);
    rest = line.slice(sp + 1);
    for (const kv of tagStr.split(';')) {
      const eq = kv.indexOf('=');
      if (eq >= 0) {
        tags[kv.slice(0, eq)] = kv.slice(eq + 1)
          .replace(/\\s/g, ' ').replace(/\\\\/g, '\\').replace(/\\:/g, ';');
      }
    }
  }
  if (rest.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); return; }

  const sp = rest.indexOf(' ');
  const prefix = sp > 0 && rest.startsWith(':') ? rest.slice(1, sp) : '';
  const after = sp > 0 ? rest.slice(sp + 1) : rest;
  const parts = after.split(' ');
  const cmd = parts[0];
  const params = parts.slice(1).join(' ');

  if (cmd === 'JOIN') { return; }
  if (cmd === 'PRIVMSG') {
    const text = params.startsWith('#' + channel + ' :')
      ? params.slice(channel.length + 3)
      : params.replace(/^[^:]*:/, '');
    const login = prefix.split('!')[0].toLowerCase();
    const display = tags['display-name'] || login;
    const isBot = BOTS.has(login);
    const cleaned = cleanText(text);
    if (!cleaned) return;
    messageCount++;
    addRecent(display, cleaned);
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const label = (tags['msg-id'] ? `[${tags['msg-id']}] ` : '') + (isBot ? '[bot] ' : '');
    console.log(`${stamp} ${label}${display}: ${cleaned}`);

    // Speech-only filtering: the line is already in the panel feed above, but
    // it is never handed to the voice if it contains offensive language.
    if (shouldCensorSpeech(cleaned)) {
      console.log('[censored] skipped a message (offensive language)');
      return;
    }

    if (options.test > 0) {
      if (messageCount >= options.test) {
        console.log(`\nGot ${options.test} message(s) - connection works. Exiting (test mode).`);
        shutdown(0);
      }
      return;
    }
    enqueueSay(options.names ? `${display} says, ${cleaned}` : cleaned);
  }
}

// ------------------------------------------------------- shared command API
function pickRandomVoice(onlyFunny) {
  // Avoid the current voice so every click changes something. The funny dice
  // draws only from the 401 goofy variants; the normal dice uses all voices.
  let pool = voiceNames.filter(n => n !== currentVoice);
  if (onlyFunny) pool = pool.filter(isFunnyVoice);
  if (!pool.length) pool = onlyFunny ? voiceNames.filter(isFunnyVoice) : voiceNames;
  if (!pool.length) return;
  const name = pool[Math.floor(Math.random() * pool.length)];
  console.log(`[dice] ${onlyFunny ? 'funny ' : ''}random voice: "${name}"`);
  queueVoiceSelect(name);
}

function runCommand(text) {
  const line = String(text).trim();
  if (!line) return;
  if (line === '/q' || line === '/quit' || line === '/exit') { shutdown(0); return; }
  if (line === '/test') { startTestChannel(); return; }
  if (line === '/skip') {
    queue.length = 0;
    if (speaking) { try { host.kill(); } catch {} speaking = false; console.log('[queue] cleared, speech stopped.'); }
    else console.log('[queue] cleared.');
    return;
  }
  if (line === '/autofx') { toggleAutoFx(); return; }
  if (line === '/voicesetup') { openVoiceSetup('Opened from TwitchSamaTTS.'); return; }
  if (line.startsWith('/auto')) {
    const n = parseInt(line.slice(5).trim(), 10);
    if (!isNaN(n) && n >= 5 && n <= 600) autoInterval = n;
    setAutoVoice(!autoVoice);
    return;
  }
  if (line.startsWith('/rate')) {
    const n = parseInt(line.split(' ')[1], 10);
    if (!isNaN(n)) { curRate = Math.max(-10, Math.min(10, n)); console.log(`[voice] rate = ${curRate}`); }
    return;
  }
  if (line.startsWith('/volume')) {
    const n = parseInt(line.split(' ')[1], 10);
    if (!isNaN(n)) { curVolume = Math.max(0, Math.min(100, n)); console.log(`[voice] volume = ${curVolume}`); }
    return;
  }
  if (line.startsWith('/voice')) {
    const name = line.slice(6).trim();
    if (!name) { sendHost({ op: 'list' }); console.log('[voice] available: ' + voiceNames.join(', ')); return; }
    queueVoiceSelect(name);
    return;
  }
  if (line === '/random' || line === '/dice') { pickRandomVoice(false); return; }
  if (line === '/funnyrandom' || line === '/funnydice') { pickRandomVoice(true); return; }
  if (line === '/fx' || line === '/fxrandom') { randomPitchSpeed(); return; }
  if (line === '/fx reset' || line === '/fx off') { resetPitchSpeed(); return; }
  if (line.startsWith('/names')) {
    const v = line.split(' ')[1];
    if (v === 'on' || v === 'off') { options.names = v === 'on'; console.log(`[voice] reading usernames: ${options.names}`); }
    return;
  }
  console.log('Unknown command. /skip /auto /rate /volume /voice /random /funnyrandom /fx /fx reset /autofx /names /voicesetup /q');
}

if (!options.gui) {
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', d => runCommand(d.toString()));
} else {
  startPanel();
}

// Killing a player leaves notes sustaining on the shared synth, so the new
// helper clears them itself as soon as it opens the device. Track every child
// so a quick double press can never leave an old track running underneath.
function killMidiPlayback() {
  for (const p of midiProcs) { try { p.kill(); } catch {} }
  midiProcs.clear();
}

function stopMidiPlayback() {
  midiStopGen++; // makes any in-flight play request stale
  killMidiPlayback();
  // Explicit Stop: send all-notes-off as well, so silence is immediate even
  // when there is no next track to clear the synth.
  try { spawnSync(midiHelper, ['stop'], { stdio: 'ignore', windowsHide: true, timeout: 3000 }); } catch {}
}

function shutdown(code) {
  shuttingDown = true;
  if (testTimer) { clearTimeout(testTimer); testTimer = null; }
  try { if (ws) ws.close(); } catch {}
  try { host.kill(); } catch {}
  stopMidiPlayback();
  if (autoTimer) clearInterval(autoTimer);
  setTimeout(() => process.exit(code), 200);
}
process.on('SIGINT', () => { console.log('\nBye!'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

if (options.channel && !options.gui) startListening(options.channel);

// --------------------------------------------------------- language grouping
// These labels are used ONLY by the panel's Language dropdown, which just
// narrows the Voice list for browsing. The dice button and automatic voice
// rotation always pick from every voice in voiceNames, in every language.
const ENGLISH_VOICE_LABELS = new Set([
  'New York', 'American', 'American Female', 'American Female 2',
  'American Deep Male', 'British', 'British Female', 'Posh British',
  'Scottish', 'West Midlands', 'Lancaster', 'Caribbean English',
  'English Default', 'English Female', 'English Deep Male',
]);
const FICTIONAL_VOICE_LABELS = new Set([
  'Esperanto', 'Lojban', 'Quenya (Elvish)', 'Sindarin (Elvish)',
  'Klingon', 'Lang Belta',
]);
const LANGUAGE_ALIASES = {
  'Latin American Spanish': 'Spanish',
  'Belgian French': 'French',
  'Brazilian Portuguese': 'Portuguese',
  'Mandarin Chinese': 'Chinese',
  'Ancient Greek': 'Greek',
  'Irish Gaelic': 'Irish',
};

const FUNNY_SUFFIXES = ['Deep', 'Chipmunk', 'Baby', 'Monster'];
function isFunnyVoice(name) {
  return FUNNY_SUFFIXES.some(s => String(name || '').endsWith(' - ' + s));
}

function voiceLanguage(name) {
  let n = String(name || '');
  // A funny twin inherits its original voice's language for filtering.
  for (const s of FUNNY_SUFFIXES) {
    const suffix = ' - ' + s;
    if (n.endsWith(suffix)) { n = n.slice(0, -suffix.length); break; }
  }
  if (n.startsWith('eSpeak - ')) {
    const label = n.slice('eSpeak - '.length);
    if (ENGLISH_VOICE_LABELS.has(label)) return 'English';
    if (FICTIONAL_VOICE_LABELS.has(label)) return 'Fictional / Fun';
    return LANGUAGE_ALIASES[label] || label;
  }
  if (n.startsWith('Windows - ')) return /Maria/i.test(n) ? 'Portuguese' : 'English';
  return 'English'; // classic SAPI4 voices (Sam, Mike, Mary and friends)
}

function voiceLanguageMap(names) {
  const map = {};
  for (const n of names) map[n] = voiceLanguage(n);
  return map;
}

// ---------------------------------------------------------------- GUI panel
const PANEL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="google" content="notranslate"><title>TwitchSamaTTS</title>
<style>  :root {
    color-scheme: dark;
    --ink:#e8e8e8; --muted:#9b9b9b; --line:#333338;
  }
  * { box-sizing:border-box; }
  body {
    margin:0; height:100vh; display:flex; flex-direction:column;
    font:14px 'Segoe UI',Arial,sans-serif; color:var(--ink);
    background:
      radial-gradient(900px 500px at 12% -10%, rgba(255,255,255,.045), transparent 60%),
      radial-gradient(700px 420px at 95% 0%, rgba(160,160,170,.05), transparent 55%),
      linear-gradient(160deg,#0d0d0f,#161619 55%,#0c0c0e);
    background-attachment:fixed;
  }
  body::before {
    content:""; position:fixed; inset:0; pointer-events:none; z-index:0;
    background-image:
      linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px),
      linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px);
    background-size:38px 38px;
    -webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,.7),transparent 78%);
    mask-image:linear-gradient(to bottom,rgba(0,0,0,.7),transparent 78%);
  }
  header, .row, #status { position:relative; z-index:1; flex:none; }
  #chat { position:relative; z-index:1; }
  header {
    display:flex; align-items:center; gap:14px; padding:12px 18px;
    background:linear-gradient(100deg,#1c1c20,#202025 55%,#1a1a1e);
    border-bottom:1px solid var(--line);
    box-shadow:0 6px 26px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);
  }
  header::after {
    content:""; position:absolute; left:0; right:0; bottom:-1px; height:2px;
    background:linear-gradient(90deg,#3a3a40,#8a8a92,#3a3a40,#8a8a92);
    background-size:300% 100%; animation:slide 8s linear infinite; opacity:.7;
  }
  @keyframes slide { to { background-position:300% 0; } }
  #logo {
    width:56px; height:56px; object-fit:contain; flex:none;
    filter:drop-shadow(0 0 10px rgba(210,210,215,.28));
    animation:float 4s ease-in-out infinite;
  }
  @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }
  h1 {
    margin:0; font-size:24px; font-weight:700; letter-spacing:.4px;
    background:linear-gradient(90deg,#f2f2f2,#b0b0b0 35%,#f2f2f2 65%,#a8a8a8);
    background-size:250% 100%;
    -webkit-background-clip:text; background-clip:text;
    -webkit-text-fill-color:transparent;
    animation:shine 9s linear infinite;
  }
  @keyframes shine { to { background-position:250% 0; } }
  h1 small {
    display:block; margin-top:3px; font-size:11px; font-weight:600;
    letter-spacing:1.6px; text-transform:uppercase; color:var(--muted);
    -webkit-text-fill-color:var(--muted);
  }
  .row {
    display:flex; gap:8px; align-items:center; padding:9px 16px; flex-wrap:wrap;
    background:rgba(24,24,27,.72); border-bottom:1px solid #2b2b30;
    -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
  }
  .voice-setup-bar {
    display:flex; gap:8px; align-items:center; padding:8px 16px; flex:none;
    position:relative; z-index:1; color:#ffd79a;
    background:linear-gradient(90deg,#392a12,#2a2011);
    border-bottom:1px solid #6b5220; font-size:12px;
  }
  .voice-setup-bar[hidden] { display:none; }
  .voice-setup-bar span { flex:0 1 auto; }
  .voice-setup-bar #voicesetupmsg { color:#d8c39a; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  input[type=text], select {
    background:#111113; color:var(--ink);
    border:1px solid #3a3a40; border-radius:3px; padding:7px 9px;
    box-shadow:inset 0 1px 3px rgba(0,0,0,.6);
    transition:border-color .18s,box-shadow .18s;
  }
  input[type=text]:focus, select:focus {
    outline:none; border-color:#8a8a92;
    box-shadow:0 0 0 2px rgba(180,180,185,.18);
  }
  input[type=text] { flex:1; min-width:170px; }
  select { max-width:230px; }
  #language { max-width:170px; }
  label { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.6px; }
  /* Classic Windows 95 beveled buttons: light top/left, dark bottom/right. */
  button {
    font:11px Tahoma,'MS Sans Serif','Segoe UI',sans-serif; font-weight:700;
    color:#000; background:#c0c0c0;
    border:2px solid; border-color:#ffffff #000000 #000000 #ffffff;
    border-radius:0; padding:6px 11px; cursor:pointer;
    box-shadow:inset 1px 1px 0 #dfdfdf,inset -1px -1px 0 #808080;
    transition:filter .12s,transform .10s;
  }
  button:hover { filter:brightness(1.07); }
  button:active {
    border-color:#000000 #ffffff #ffffff #000000;
    box-shadow:inset 1px 1px 0 #808080,inset -1px -1px 0 #dfdfdf;
    padding:7px 10px 5px 12px; transform:translateY(1px);
  }
  button.primary { background:#c8c8c8; }
  button.on {
    background:#a6a6a6;
    border-color:#000000 #ffffff #ffffff #000000;
    box-shadow:inset 1px 1px 0 #808080,inset -1px -1px 0 #dfdfdf;
    padding:7px 10px 5px 12px;
  }
  .auto-box { display:flex; align-items:center; gap:6px; }
  #dice { background:#c9bd9e; font-size:12px; }
  #funnydice { background:#c9b3bd; font-size:12px; }
  #fxdice { background:#b3c2c6; font-size:12px; }
  #fxdice.on { background:#a6a6a6; }
  #fxreset { background:#bcbcbc; padding:6px 9px; }
  #autofx { background:#bcbcc4; }
  #testchat { background:#b6c6be; }
  input[type=range] {
    -webkit-appearance:none; appearance:none; height:18px; outline:none;
    background:transparent;
  }
  input[type=range]::-webkit-slider-runnable-track {
    height:6px; background:#808080;
    border:1px solid; border-color:#404040 #ffffff #ffffff #404040;
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance:none; width:13px; height:20px; margin-top:-8px;
    background:#c0c0c0; border:2px solid;
    border-color:#ffffff #000000 #000000 #ffffff;
    box-shadow:inset 1px 1px 0 #dfdfdf,inset -1px -1px 0 #808080;
    cursor:pointer;
  }
  input[type=range]::-moz-range-track {
    height:6px; background:#808080;
    border:1px solid; border-color:#404040 #ffffff #ffffff #404040;
  }
  input[type=range]::-moz-range-thumb {
    width:12px; height:18px; background:#c0c0c0; border:2px solid;
    border-color:#ffffff #000000 #000000 #ffffff; cursor:pointer;
  }
  #chat {
    flex:1 1 auto; min-height:100px; overflow-y:auto; padding:10px 16px 16px;
    background:linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.28));
  }
  .msg {
    padding:7px 11px 7px 13px; margin:5px 0;
    background:#1a1a1d; border:1px solid #2e2e33; border-left:3px solid #8a8a92;
    border-radius:3px; word-wrap:break-word; box-shadow:0 2px 8px rgba(0,0,0,.25);
    animation:pop .22s ease-out;
  }
  .msg:nth-child(even) { border-left-color:#5a5a62; }
  @keyframes pop { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  .msg b { color:#dedede; }
  .msg span { color:#777780; font-size:11px; margin-right:7px; }
  #status {
    padding:7px 16px; color:#a8a8b0; font-size:12px;
    border-top:1px solid var(--line); background:#141416;
  }
  #status::before {
    content:""; display:inline-block; width:7px; height:7px; margin-right:8px;
    border-radius:50%; background:#b8b8bf; box-shadow:0 0 8px rgba(200,200,205,.35);
    animation:pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.45;transform:scale(.8)} }
  #tip {
    position:fixed; z-index:99; max-width:330px; padding:10px 13px;
    background:#1e1e22; color:#e8e8e8;
    border:1px solid #6a6a72; border-radius:4px;
    box-shadow:0 8px 28px rgba(0,0,0,.7);
    font-size:12px; line-height:1.5;
    pointer-events:none; opacity:0; transform:translateY(-4px);
    transition:opacity .14s,transform .14s;
  }
  #tip.show { opacity:1; transform:none; }
  ::-webkit-scrollbar { width:14px; }
  ::-webkit-scrollbar-track { background:#b8b8b8; border-left:1px solid #ffffff; }
  ::-webkit-scrollbar-thumb {
    background:#c0c0c0; border:2px solid;
    border-color:#ffffff #000000 #000000 #ffffff;
  }
</style></head><body translate="no" class="notranslate">
<header>
  <img id="logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAACgCAYAAACLz2ctAAAQAElEQVR4Aey9B4BeR3X3/Z+Ze+9TtqtY1VWybFxxN8X4dTA4lMCL6QnwhQAOJZSE5nyEGkoCScCkkUAglPAm5qVDCNiYjjE4xgXbyMZFktXLrrY99d77/s59dmXJXtmSpZVW0T6eudPPnDnnP2faCrxmf7MSOIgSmAXgQRT+bNfSLABnUXBQJTALwIMq/tnOZwE4i4GDKoFZAB5U8c92fvgCcFb3M0ICswCcEWo4fJmYBeDhq/sZMfJZAM4INRy+TMwC8PDV/YwY+SwAZ4QaDl8mZgF4+Ol+Ro14FoAzSh2HHzOzADz8dD6jRjwLwBmljsOPmVkAHn46n1EjngXgjFLH4cfMLAAPP53PqBEfUADOqJHPMjMjJDALwBmhhsOXiVkAHr66nxEjnwXgjFDD4cvELAAPX93PiJHPAnBGqOHwZWIWgAdE97Od7E4CswDcnWRm8w+IBGYBeEDEPNvJ7iQwC8DdSWY2/4BIYBaA+yDm4eHht+xD89mmSGAWgAjhkbg0TT/V1dX1rnXr1j3+kbSfbdORwCwAO3LYq++tt96aeK8X5i6rzJ8//wt71fgwq/xww/0fA8BNmzZ1r1q1auDhBrw/yk844fgf5MpKclI7ay3M8/w7+4PuQ9G48cYbHz+4dfATv1m58vkPVe9QKzvkAbh1bOSysXZ9+5z5cweXHrVkc56nn5lOJdx0ww3PCT6c32q3VG/WVUpKyrLsSevXr3/ndPW7dtOGK047/fQfdvd2v2zZ8cv/T31s5IvT1deBpntIAxAQfHFOtfr31Vy9Ic8in+VBtfrv5e3WmqF1686eDmGe9ugz/mJ0dERJFKscJ2YE1Wq1tGDBgndMR3/1dvv7i+YveF2j3XIu8mq26y4uRZfmeXPlmpUrl0xHnweS5iEJwLVr1/4Oy959UYguVZZHck55vSHliC5OvOqNpX1HzL+uOTT4cXL2m7v55pv/stVuLevu6YGmV97OledOpVLJQOhrtdrNFOwXd/uau363nudDpRAubI7WVQbweZYricvyIdL42NiKpSuOu3vr1s1/s186PEhE/EHq9xF3OzI4/PHFixZ/NW1lS7JMyuQkFJIliWqNOnGGVK0YfR/39b4EoN5wzz33lC1jX/2pp558WRQHtdttA4AiQNFutop0CEHlcvnUwcHBf9nXfmrjtc+dsOi4z5VS9aklAF5WPtpWlAUp9WrWc1W7+pUrSnp6+t7AFuDafe3zYLVHWwer673r967r7+qrj4/f1N3X8/LtQ8MuRF4e7h2fodEx+RCrUu1WnpGJVWo0M6WpS+jljKOPOWZs+3j9tcQfsasPD3+5Ua/3GwEfBVWrXVKeK04SRVGkZrNpRerv738xFvriIrGXn+uvXzkPK3cLQP49tRhECgGz6m3JlSI+khheAPiW3WikiuPYAcDzmWjbR0dHX0KNQ8oxnJnP78b1G99+3JnHDcalymlm8PoGetVOMyyAsIBSX3ePGjW0lEu2LArdlQBGYGnOGrlcLt8Vl65oZ4/stHrbDTccXaqWnp6EjrhQNB25wmdpKrOICf1ZyH4wXrhw4ef2Vqpbt46+8cyzVqyh3Slj4zW5slMeMsm8Y3sRS02Xq+3oFixmgLOcBDUaLXkmIe16uZf8FGA8pK6FOhKF+5nq8iy7Zt4R894DppyD21H2eshetiFvsSdK8Rgilr9I9VpDPqAhXG4AbWfyiZPVAYWOoie129mW9eu3nLs3433Uo0/9tHJFLgSCXF0AHkVLKN45V1jAQJlZQSwS2X4uQPzqnvYxPtb66sCcrg/Vmq0y41RXl20hMjkxqXymVpSqxX8Z8XreEsZddKssk0qlmLhTvV637rxz7lImwtqhoaGzLGOme1Q6M1m89+41f5S186FM7qLUecQvUwdAKwECKcX2OSxC8E4ixLopqSYS1iF1prRcKeBrEq9nTbZObVqkCiGfu3B+/0/yevPD2oPf7bfffkyWpY+Vp5Msz70cGDZku5TmTRd8BthGiber1eqWNE2HiI97789f+TCn1Pvuu+/ReZaurVT1jGbWdAkWzcbVbjelZi5lTi3HHpPtRluMQXXG3lTk26q3G3KBKoZCOmTZZkeQm/dMhsW9vb0/Bogfo2hGOz8TuVu3+r4fLV688G8RcJ9ZBAfGMhhtZigja6OEXEGe/9BTvSnHfwHz1mqmajTb8gA2+KBW2qRVplIcK0CkXh9XTnvlrUghf0OeNm/ccNNNbOaotht34oknrrrxpl+evvLmmy74xY9/eua3vvXtE6/94U+XXHvttQPf/8H3u5xzIUmSHsIYP5/94ABhXwhhwQknnLB2N2Q1Njb23kULj/jvvFVfLEYUea/B8WEmlseiJsqHxyQFSgJ5OXhskXKKGFs7bagCWBuMJwOA7P+o23EWNw8PZSbBZcRv2LBhw7Gd0pn39TOJpTV33XXq2NDwfYuWLnm8w+AYb1x7FAowRmMfFKOoqFBLJmGISjFWj4pWPfERCopEA9nWqewT+cwsSQrwUlXKZckIRY50U8qapy84adm6xtYNn4TElA5F5med9ZjbTzzjnJ+ce9FFNz71qU+966KLLtrw+Mc/foSwPWWjh8kEFD/CWv4JFsqDX/iQGoylp9rP2UMab0iur1dqeYU0xhPmjEXEFZnBl5NULpWLOPRI7eom8hxL8xncUd5B+o92rTEzUqaOGcHJfatXf2zpscfdXO3pWdKs1RRhtWx2Y1HgL1PGApznqTjayqXovZ0qeNhnA5hyVdFuC1jmcg6wiQylcviIuhFto/EROSyGG69JGzfLtQBwnXqj9d6kUnlpno3+io6m1d19992vAAhcF9bsDxgqwcdSwLugOMLq5RK7Bqyb1KylYgAKTadKw6mb5ThiBcga46pYmzrlgDaEICaJoCv7WdxCS5v8LI6PSF+B//66deuqpGeMQ4MHnxdm6S1Llh75h8ZJC/AlnCgtzhJCkMnlGcuPVHJOwTsJwSvNJY6C3rUAaxvfUubqhfcBNLoxpeNbqDMm1Uck4KlhtmqDxH/DYfM/vyd97ku69X1/pbs//x9So3FylteG7lt9z+9Teb87DgX/edRRR/0zICiXuLi2DkIccXhoMac8do3xSUqM9YywwuRwDene1dLmQcxiDWveVpk2xfhDCTmgPmRCs50BWADSOeREge0NCaycynrcvHnz7hkfH3+25c0Eb0wdND7WrFnz+izPR5NS6ZTUTBicxBVOgMxqs4IoC+C5jgeEMt9i5vP0pVpdGgNQw+z5hzZLw4OKxkcVWd6WTdLa9QrrN0o//2/pS1/T2N99TLe86jX68mMfp6ue+wL9/E1v0VVvf7du+48vaSFXNWLjn6nVt2jp4k9t2bzt69pPv5/+9KdnMI6VPT09T3HOFeAw0hxWwHxL5QpAIqM2XpfnSke1cWn7NmnTBukbX9HXnvss/fsTLpC+910s90bGzLhtW2GW3FYA2pqlow9iuzrnXHFFxAQv+qXPCIt5BBPg/xD/9K61D07qoAFw27Zt31+6dOlH2mm7OASYEHeIgGXVI1zUhZFjSeVKJa03lY0hfANfiCQfsAqkuYTWr38jXfND6bNXKn/7+/WbZ/2+fnH+U3X9OZfo9me9VHe87k91359/UHOv+ZHO27pNJ2/dqOO2rtUJrVEdj8Wpslc0emlGH86rf97A09u17J6b/vvW39rB0yOIMME++JjHPOa6Vqu1wsbHnq+gUowNcJS4Qmkxtla7rmqV8aRMqBbW7oZrte1Vr9OvXv4qrbjjVzpj2zrd9NrXa+w9fyHdcYc0ul2qAC6w27ZtCVSdcwXIiMr6MkA65xRxSW4rinNOgYltPNB/TJ0XU2cd1vA8HcTfAQfg6tWrL2BGrhsYGLgwxaKZUGz8URLLrGCKQnKOvlGppJRTLILi2sEr5t3Vb9wq3cRz69e/pnv++q907etfp69f+L/0vUufrev+8FW67Z3v1r2f+pwqP7tey9dt1GnD43oUS+4xg9t0Ahe2Rwxt0xFYyMXtluZxjdE9PqJyvS6Njct2/85F7BZtvymFxB1z6mknfffeVfd9Vo/gl2f51YsXLnkzVjt2ygCCl+cFxcYDIAFLLrGniznRlvO2NLydsd2ole9+u77z8pdq9Dvf1omjI1rBFmPJ2JiWbt6me6/8sr7y7Bco+9KXpPVrsfbDinh+DLT3nMKgqDZbkxZblIw9MlkS8vTImc7UaNUVx4HRZAqRtcgWVSqVn6ZpukdXUjTc787vd4oPQRCr97ElS5b8kCVgEYOWx9o4uaKFc062J1IMSyYjlBaCV7A9T60l3b1O//yMZ+ua5z2HpfQP1bjiCi389tU6a9MWnTw0rOXDI1oyPKz57Pfm5g11c28WZePov8bZUco5qQSJ5Zy4XV002vLeq+Gh3Y0p4dXO5WXKA7vFjOOLBB519JFLXtSopTff9DDXNZr43X7PPZdw8b0B9p/oUyfRlx2EMi6QnXeGBzVbqcT9pMYHpXEm1W23SH/9UV198dPV/rcv6pTtI+qyLQH3fXmaqwvgBi7gF9faOmnLdt38jvfpmsddIH3zmwB3SBoZluhwrF5Tiz48MouiWMUgaC8OYjmJwFRIOaBlalM7VROL385o4dzrsIa3bNy4cQGEDqhD2wemP0z/z7B6f9hoNIoOQwgoA0UUKT45HmdBRjjpnAHUZnC1S2cvXarlLMWnMOtXsN87BguxCOs1nxeQOSiot9lQF0t0CbBFeYuWRt+8UTQ/SbUTWo5hRMHEEORcLC9HISUGEGLmksSfetqpp6wb3Lr5HZbenV+17r4rlx9zzH9xFbmg2NKCAWGdVI4k59VgnxenXl2OvrYDvg3r1P74J3TVsy7VrX9zhR7DVmAFp9/eoboGKiYfKUcgKYDthq9+wLyE8T+K8R63doNuf+Nbde+fvUdat0m6Z7W6m3VVAJddZLe578zyphiQBCBbyLAGEB0ZDloZ5RE8FZbSOc9SfMrcuXPvTVutd+oA/vx097Vly5aLmV3bAdx5Br7JU1mTx/vgw67dI2w3mWMRPE6yz0CXjj3nDLWck0vKElYhC06s1trnHwramQY9yDlXZDXqbWE8LN7b3dPzjjzLOT5b8n5//fXX9+V5+7qF8xY+t9mSPMAbz+tq8nQ2EloaYrlvKVZV8F0D3Ks3SJy8f/7ES3Tfh/9BR6/ZoCMaTaUjY9z5OVV9Sc3xTJGHViQ+UhRyjGZNSmvKtg/pqO4B9a3bIveVb+uHF1wifeFr0tq10vB65dk2ZVGqsSTTaOQ0mgd5V1I1dGEMYzXqOdyYtU8UxyU6kFiVFEIo+xC9kzFevacWv2i8Dx+/D20f1HSqjCzLXoD167Ul1wbpnBNpJUmCoFDGzo3yQtY75wjwCslIlUgDp5ygIYCrECvFaqUAkOuxXervdYIlCy3saJYrl5fbkS6Z9fKSncqjmA2U04Xtdja8du3aF1ql1ffd/WdnnXXaS0EBCwAAEABJREFUxixtnxuDmEksx+UYOpmqLlK/CyptHZIAmL73A33jiU/Sne94t5Zt3qp5GzZrRVe35lcTANZUjvn0yMZnsi2iXEjkARGGUXZgseU4Ykb4Vk0L4X3ulvU6jX3sXeyJv/OUp0rXXacqB61kcIOqWLzMVgPq2QG7PpbLO8cFdiLZzE3FSJ3Yk8t7Ly4o1W61HEL/LU7txfg0zT9EO709YNrzKIoUWHLNAtognesouAAXuxGHF+AzThyhMUVQZAFgpmckReQsP0ppuUs5Sm17KYUMudZs33wco5BczkFwCkp265FUK1iPthiPC8H1LFq8+N+I3754ztI/Vxvz4lJlzvac4yixhq0LcqMNhVoubR2Vbr1d973yMt36mst0+tAW9QHGwGVyBdnUORiNjA4rKjk535Y4LDgBFnk17E04VOHNKzXeXFBcTlRv1Hg9GVccmur2NfVv36Kj12/Q7a94o2rv/gj3hxsVxprqZen1TFokyEnbCdFBU0rrDLmdK2OPaKuS6YIDiUxXdOOydjaHcNodapzePpxzUfHnS3RjILRBWlgswSGQO+HcRLhL4JmMFOBSJq0WHqH5y49T3UfKQ4TCd6n8iBIpilbSAaApIbf0TpTqHID8Tmyasqw4zVJXKVdODLRNeVHxHhqY4wilVuXlOBQFrJluX6kt7/9LXf3MS9W85vtasmWLFrCHnR8cS6IrVoNyd7cqmM60kSmzPSP7M+sjwvopj2RGKSn1KIqrGmk1lXFAYQeiSlWCjDJeR0qAbAntlmzaqtWfv1LfeeZzpU9xgF+zUQnLe+DkL/aOakklZBkqAoxOHgJmFOxkLn6mF9CukZGRXpLT7vx098BAfDcCbnD4sNlly68N0ky+xa3/3D47eUfcPIHkXTHzW8x89fTo2EefpSEzSQDQP7Bh0WDPP7lTB26mzU4MwHeI5nknLFcAFiRNSSGKZHzb3+BFPqiF0mWAYWXO2VWltVi+jWa3jEi33crJ9gP60RP/l9pXXqlTeeA9glNsAu9GY5SL5Jh9XYnD1Sh3mU32mhhAlmEpg5c4KStn3Yxtu8G1Sh2QK/eqIAdjzZZkzjQyBdqBp0Rjj0ACe8SFWaoVm7dr5V9+VHe/5BUq7khH2S82tyr4Mcm1NMqLUytITa5rzCiUSiXZLyG0caWZDcRyptcb/9PaQxzHZVNmwr7GOsIiKmD5DIx2D2h5MjE6YuYJkL99VSTZmzRYRmxBkkdiy5ZrG8tG5jzPV65TR4/8h9GSAPnOFEwoDvyZogteiJvls+2ATZpSKZZNohhTknlAScg1I4Y0lrZs06ZPfkrffuELdNPfflRnc5ru5s5uAXeaUWtIgbu/wAbP1A1OVGvW6NoBX6/YRQrQYnhSqyX71bksr9Cfg069Pa4IOYYg2a7BDCTXfPJUNHnanXSzlamKhVzAaWg+1rB04y362R/8gcY+8AFp2yZpZGvhu6sxe8o2dEIxFkgUjj2gjFYSxwNFxjR/jPdp7SJN08xAZ96AaLM/mATpNYkTvjbj1dGzI2meADNgX7yTATVWhFJAwmmnaytcg0lFmcSkp84jd5n1HMcSVrCdZYoAtlEzPg2EBcKdZPw7JoPxbsBMopjlUmp6aRy2ItgT1kerbtfP/+GjWsGd5DFYSM/7c5X2OWUl+oq5o8y5r6NH2RgQD7kMhK9yxyEkk+M/0RcjV5fJKhuVc3WVQsbBhL2f3a4Awoy+29SLyyUpc7KloicJqtNvrqZi3sTLtUEtq49q6yc+q5+c/0Tp378ojQF6ni5jQC0GY4Az3YhfZLIgzHMHdSLT7A5EJ6hn6lEgsh0FGTHzOypbBN9CqgaGIGrHZam3R9mcAXmWCievAiR6ZL8MkuhcCh4CuQxkROTsk9vnfv+AZFFg7VNimeNjjQCXamPqb45pgC1HbyNVkqmgl6Ps1KcqPEAq+pWKrrt7EjXE7jOQgfO0SDm92uxqEmbIgJWbEhlebK6I7Z7s2ThnBraxqo1aU/aXNBFtbVp75xSwhD2RFI2P6UheU05hP3vN5e/SN3//MuUcWHLKnTI55/Sgn2O9f1Dm/s/w+5/k3lP0CGGyVWYRlCXAJWQQKyDsXC6lIAKACxYoPnKpRrh41k7tKH1ErugP62eNnXMW7LFH93CnCd+Scpqy2c994GCcGvtkkO0kA2sbadcwfQ2AlhK39iXKHGtxRroFWjNOwbkKrlSgs0TlclneCesc24she0MpzoL67B8qgUyrb0OIS15KM1FVng4SJcqw6lCAtZbKXFQfN5Kq9851anF5nSSxKCh4fODHOWfNHpi939NwvN9p7kIQAbhJ875LQZHIiq99jBHzFs/tY1IktKDkI5Ye6prZ6O/TsvPO1TCWQbaGUWdfXMFbsX5CxVlvhObygguL7eKdu7+OQ3sxYAlmvwpeGAGbQacI1u6vZwSMdfMGNLAhmhbW2yxZazxVgvmqcy3Do4d8EqnGwWYLy+G9LLF3Aeh7Q6Lt/XNVr/apxYm4BQDt/FNOAFlbMnbb9Uw5AEx8wqRw5OViC8TZLdEodUqg+KhKtypjdSWLFirFSmsnNgtZwKxzRSboJDHNDolNbw+O30P1YEMtPPp2eJvNmTWwTMKMzXjCZPQIWrY7J1z4uMeojjDZ5MhMg3Vhnup77TJDAlcgaAtduMI/HBHnqMHHYZYD4IvYb7WLPMTJ8dSpJGWRCkNOVXM2NvMRg4uw5g7rLmASlSqFVYu47+tlIkRUbkUVrQSJq9hqHPeyl8o99Sm66/jluq7SpVtYBbZ0zVE76QdcVdXHHX15xVhJyAqcYfVSuMrkuS/Moo7VNDSlnKYHuXMcM9TPG9AYd6tmmZ2DhoQIcvsQk1zurImm++enuwPod0ZH5IFucsYV+YzdQvTDjofYRKvY9sJWZgWlRMUGaMERGmP6p9xhmQCpXTjnJhoVqYf/FGStCZYG5O3awEyKVSDXLBcBtg79WGTST5TbUuqMAMuh3bUVaeLOuU6DiXqBkO2fLNxBgtNqBZCADRnw1vlYNwdp84pjdTaHmejyt+r4Kz6qp33jG7rka1/RBf/6KR15+ZuUPelC3Tp/QCv7+rR5zjwNMQMiAGwncx88vDZVr4+riPF+XCk7NXgZiaoVHXviiRL3iaWoSr1JTmCVMe/QiXcI+/6y6Yr56SI8SZclwO8Y1GTmA0MUU0jCQsoyEjabTafC+qnRVhuFck+hwnBwEOleME8N7h0mmtDqkbmCN9tAIfwHUQA/D8rbOSPHXuUlrEVVsW3wuIRWfUylvAnrLXWA6ykP8iyZDu+ZSA6mDaS5+C9kapGRAYY7uSu866jFOvtD79Nvf/db0kUXSABMff3SvHnS0UukC86SXv276r3y73Xm7d/TGT/9ho7+i3doS7mqYS4EG1w6K2+pO0pUorMIGUVeqrdyuWpZ21oN9TKB1dWrlIPJ5GRwbqfBEveOmaDp/8Ha9Hbi+O2+h4nubewTUa+MWStUQyvLb6aSixTFjnurTCnLnhbM1dLTHq1hz+IXvEzRedFqgohoT1vLJ/oQbrI+JicXoBG9S0Qli0HDEuDDUuQVuUVYfIpyaPDYrwKMZHAFEhkAAYGscUEVoLIvLNpMfMxyN0PQcFzRxnKP7unpU/9Tf1sX/ce/Sy98obRwsca7e1Vjz9b0XqkdGPp7AOKARrkc316tqjEXUK44RnrU8dquVAPVASVRrGI76trKuMgOTCxjJeZ6pka61VVR/3nnSGlQGbm6YkZPMEVQTEhCyTgsIg/52ddCpLevJB66fZ6bWciolMmhyUk8Tg40BziFwpmtmIlCTclEnhk9mQV0NKdSZ6tWk3h6Gnjsxdoc96nJHVgTukxwZQjTAUq2VrLNvvkOCG2Y5iVLmxd9COCkJmefSGzyczuNKlfLdlJgkk2WlHX6FvWZCiREjSLgQyFtKFLBuNHiasOzx8ph3nkx5kgOY8LtHVvYTEXf3skM5iBjW5PM0S8Yx8lXfESLP/1J6dhjpe4+NXh7LOcVVUJJSVSSZ/uRQjCVU8mXRS4+luqSuPyO4Lle2y5H/QZZGfWsL1gR5xnZi4flN6qJNKef4UTypW7JOU3qIoQgFzx5ohwmCabb0dt0dyHG6PTQPy/wRZVMRaSTkOmzUOxEcxNUhJDUVZaWL9cgoGkiJxM0jXG7G06HQFHPouapLZATJ9ByTp3ORPcOW5ITUsFNMDIRkNPJt4h5moFhmuaCcyk4adtmluBUxaqeim1CQ62sqS6e3KIKSseajdN2e1+/VvO0eOplL9OlV39beurFUjVWPn++tnPYiuIS3FERl+ML+oSe3IiJlphgDMUmpMEh2Y1MyWTDS0gCNC1bQYIjBcZnQ0mjSEMc6orlnDzNgN/uNLYfWXvoLkxA93e2c928ULYJP8WapGigxSbaTnkCdDruaKU9Xcx7J2vlClFTiT2PCdvT0LxDWeJHku+uzi6HnSHF6OW5nHO7VphM7SbbijM6Sw2yZgldqtFNm7h8dkqwVrCtJJRlIB3lcrrGHWG9iRWszNGNTJ7z/unvpNf/gXTCEVIll6qlAsgRwwhOYrgit8izvgIxRxndiDttkSz8xrvuka0ajj7bgN0TZpyibfzWzkHEy8mRP2qJRfMlwEm2Fe/OP0zx7prtXb7fu+p7X9t7G/GD2znndmR2YjuxwtA7eZJZrTw42eQO7G/aooQHes2fq8WnnQIAJU8lRzfmiRZ60S4/o+12ydFErXYBHMpYeszCWiVnfVgEUFow6aeiYmVOOS3aEifz9uiwAjQd6PPWgAop+XWKs0qs7d1V3RI5XfJvn5eexNPYgj6N+6YanE5tNW1wKq4mibJmKgcdmuMyJhnII0ZX9GOEnYohNNu695Zb5TmAyDx1bBx0T0yyuZWZRc1D0dQP9EqcngVzJisYL+odrI+NZFr7du5husjp3jzBDmfTvJBuLg6OMkGZR5wqBMtSIkC5/HHnsl8LcjSMin7yHfsZslCglFOaW2LCg1OZt2TmMjVsSbIEmspZt6Agz3+WlfGKQHOL4icAQGxn56kTkVGMkg1X1mzIcUmeonTHrGmmdVW4OKaKNrE//eX8Xl34zS9IZ58hdfdoGA5TDiFNxYzYya5SMoDk4yAf+6J7T2MbI4GKjMC4JjNrDa2/80457nFSrH/kYupkYj7JTr8Wwoo8DS2ct5w9JgcRZq1sj6zd/3Z0ufsq+17i953EQ1NwzuX4opLNzCKy47PrGHPLn1gyO4yxXJHXzgEK76pWXhglZyrPFU4+WXWPNhyzu9NAYEgZbdCrffETBcSmcj6BVsCjIiu32uYtPsm3xSe9lRVcFx/JLJ1yEsYYwKkNDnMl48iXBG+x79Jm3mmH5s7VLSyxz/j3z0qnnKyMu8dGlAC4HjWVa5wlOihSTBvrgyxuU5oQyYAOQeEocV7WXerIMIHU63Ijo7L9nxflWNcUXox3Dr0SspH9MrFaOC095du3YfMAABAASURBVCTJth0gc5KEFU/h/RR5+z3rAHQCenbDNnLaUYJ8dsQ7kftzosgrxkcSKkqUK0i9nOCOPko1BNlGyM45OZ+r7aTiqYu6MoXgM3yRfMAnd7mq/QMqdvATbDrUnXUgLEGbZNHKF98HfzIAQcdq22BSp21rtqrcCioBpIwLgKaLNMx1ycoVR+tZV/2XdCqWj1cSX+pSqUHXLWmuqjoi6ZdnowtLcjYhGjW6dpg68cvYZXo8YyOLbsjDYX21fVg99G17QDkn+3OqnDrOEc8ku4qJXWBlELKJtGDF8VIcJOrkOvg/P90sOAcqHqYTE5gJIzOgIBirboF5+9NzSweWSJCHVWiL7ZEUlaSuLo2FSLUoUorAbUnNqWzLtFnCXEaBjKkcRVanZ6APWigEZeb0QbZy4hmAdN7v0tLKzO+cmZMw386pG2LdXBvS6r6qtvBmvboc624myn1LF+hpn/uMdNSREk9p6hlQntKKboM8yJByLHwMWG2MYhlXifEFKkxMBmorneiLQMUFMoDVxvUqtdrIBTsKEOtsSiKW7hBFYpci60ZYWmtrMtL8BRKTWYyN6ruVkONn/Uy399PdQRRFmS295m1Mtq+yuPXrJrTJRC3EbELuSMQTBAW+1VJFkdWzQnwlLiv2kezeT739uvB5z9MwwmzjC4F6KY7RKURz2ls/HU8qR9HQMsB38qRKD5bUFGmNqJ/jI5+IF5zJKiJLU/1ywGP9tqkQJQCmK9LvfeVfNfDml+rek3m77etW6Q+eowu/9GkVd2/lHslX1IL5zJ7GXCZFUHaSt2WRaAHAghcShjLn1WBCtChoIaU2J+kAqhxvx+KFSJu2qNxsKjGLS3lC/SZbgaxYf6FhzvIoa8KvFi6SuOLJKY+dFXb8/Tpxsniz2Uw6JdP79dNL3qgbLCycyufaGQwPrGHyMQYtLMrQl3KhbvGjBKHr1NM0wmV0Pqk0StCHSsx6D4RJIvZsog0p2vMtnPWdm5WBlFWYnBBFcjKxo3NBp2gGiguHSifTeacnLLLOO0NL3vAanffpT+n5V31Hy17/aunIxVK5LMGTvJdzjlcdyRE3HuR0/8/iniRPdJZvEzYQiemhBFoD/Bb/foMLb1m9+1arWpj8VEYrK9bwXNbOQctTKeOAEkUV+e4uFU97yMAZL4T0NKVz/KYs2M+ZNoT9TPJB5B5imPfXNUaQFxkWw9uShi/ydlDoREzGxcKOArVsmTYFXzwIOOcL64fBkENR2Q6IZBLxjoIsJhkl845lUj5Qbn0KdRHFOef4TridokXDiWxayKPcGMKuRWYjZ8mLpK450uKjpaOO64SccGWUWVrTek0RVUpORa5xxjBlxXLQ8JlSLGObqHlIy062djdIkZzN58grr8BzaGto5Up1WQEnYGvvnBFhfNTzyMcpqE1BqxSr3yZCN68gRc9eiEQ7j0cH4QcX09urcwVUpu5kQlhWaGKbkhlDyQMroLWCqkeTC+apfcR8jYK6yVkP9iQ2PZ2mVJ6UMp2kE95IZvQf2UuIbZbIJ2nZIirnXKeVJYrcqT9RAV4qFZ0FZXnCLqyslENGm2uWVh4DAPjkbk9Ua2cglRDyYjW9nyh5RTmoaJNrPgOVzhjOyWAYab0JwHP5KCg1YXHts+aOX6ubcp/mcs4BN8cNSya2sNa6yMsZ3whcLFyxQuIuNQ/wg7xkfWrqH8twPnXJ/s31+5fcVNTy3LmHGCkCF575fL88rPqknyRJOjcP8nIshFnBosHChVpy7tlKWVJc5sQVnAyADZYo7xE07WnGV/QiFTTIoCoJr6jEVqcAkWT0Crqa+kcz2lC2k2qcR4RWYAMAGDGXazmvHXUmgOk4Dl4RB6YW1VqcPpOubrUBSz2DFOwV2zyjh8/hkGY2d2Q/mshNZlDfePUhCBjigej4qIbWrVMZK+wFARrZvb8ZRGsrTGsmrwb8jcBfsgyrHNv+2asYv7WhjGYHzRV8TmfvbicLyKyS+cn+nJAqHnGQRTwnwE0ExCYcQuKcJ7tiMY+OOwUG7Eqi4849R/aHlyHEWAApYsabkrADnXr0IWhYogBgEfF8vYIdHoqyTq/Gn3kP7dwURK2HcvZPGJuNFpaPWkYSHjh4FXyQI+aBBWqClwaASAGE/a/727+Mi61+UcrHZXCZ0aPxkVPLK+LrjFIm0IoPog5Sw4qWc+pxkAjj44o5BTMvC9laSM3OcKmTs1zXoV0vRdLiBRIHkBaAdUwc683qHkzvp79z25zs2ospeDLHIXLzBJNZCFk7J4t4m9I2JSk+Q6AilHHPWlNevlwNyhXQEGHGptyjgtzQZvXIKxxAM11mzpOkV9I+WBsiOZ7cnXkj+ZDOaMVY0IT9lS2JdjBtqiWz0BGmrQCYAyi4rtClUl4p6DkYj+HLtcYYhlFR8aMaXMsgJ+yydphCSpuw3CRMyaw6oFknsXqDevIgBwCDcpnFNf4dRVRXG9lwBSE7oBV/Qb5oISWUMmbrdWLI5D3YOWeMPzh/f+cYn/ub5i708hzJ7JLzwAQCKcR+f/4uTFkxRRMBxExNExkGpDInuwULNIJCa+bZYrHXVxJF4NHqmqe+uZ2iglKRFVC1aYJ310CGKdC8sFYCyGQ92E0yQ0nxBwOkjRUbBoqTWU+Xt9Rq1hVx19HGQlp3aVOyO0yPMZKtrR6GPFBgQtlKS0zGQ2SEoF04wCUEEnEqLuVNVetj8qPj0tp10k9/obnWMUDzCkV1W1pt25ixChQWDgXE3BDU2S9qHoejZk3275ysr4y2edHq4H0Y2vR2HkUOCObFjTx6kidp3pTbsY3GwqTv8GL1zFuqA4a8OLfF8oSBTbY3fSpnGRFC1OIlmn/GSdpmR8tSVXFUog5IzDATKDeH2KSgA5Fg0iffgh5eKRQiyadynAoCS5bzpFGow9KIH03kCAu3I5LBjRQ8uUYol7yTIiwSOcqdk0+wS+26olKQWeVSGdgDuKZrakxtNUOsJvxbvI5lgwR851wy58Vy2soajJFxuKZ8a1jiklsb7pM+/1ldddaZWv2B96u0fUQhlAv5Rj6oqVy258sBfqB/Tz95oyHvYzoXDGZy6Ri1pLFmiylLNiClpHCFvIl5b7ODyDQ7P830EeT9A5kc3K59Ggt4lHe/lnetYSmHdgrwEFo8p37hAQoa1tFnnKZxrlRcuSK7V3aBChgFswjWftI7LBslRTKj2ywANkfEVAEorSCzD/3IvMULb3UsQulEPUtZHaM3WWpxRx+5bJKQG/BY1xQrZdYvpq9AmWeHxxauiOWs30ExI+GAUJxOAqLIFWNenU2iwU3SmtWqfeIT+uKFF+pnl1+u07Gq8wFfN/y3EUiqHJBnqrAnhqhGjQ4zIkVIw9RtV1kpjmAJRojOOdXHG+pOYquq3fyy3eTv12y/X6lNQYyJtE8Dcc7JObcLZec6aeSu3F4DEKM76WRtR7ljrZaQucZ5bWjQc05LA6F5i096W6bMCwXK6JkV6JClxZ44r051KFrbokmuHF7MCzhl5n2itkPRnICjQKVUiluRKo2SKu2Swkiq7iziNQNLVBMvcIWZxNq1pJFh6dZfKf/QB3XTxb+tVe/6c50zPKYTmDl9+FIw2rlaWapSnCggkNpYkyXWAa6g8VpLTaxjq6dP430DEMcK2gT1JfW4kiJWcppoN798N/n7NdvvDbVHUtfZjpyGZv3ME93hHpjeUTBFxDm3S65zTs45ea4V5IJ0wkkaYum0vzIplUpKeHlwnnzd/3NYJviRI2vSLgdrT7pwzkoAgnJZtJMqSu7/PDDTrCE+Y0+XmxWlpvWBoZH1bthscuo0a0dR4aKIwCTPZHEJBIsjshTbZBppSoBMN92i7X/3MV116Qt01yc/r8Wr1mv5UFOL6y2VR8cUWhx32uOKsXKVaoLVb6mdS6UoaLSRa3vmNNo7V/dWunRntVsnXvocaWCe2nDVkpNL4CHG04bvLs45yp2bomSXavsl4fcLlYci4tHmTuWToJsMdyp62Khz7sF1UrLGx7hiWKJ6/xy1vVejVleEhFutFFGLfdX9Ps7E0ubYZ6koiwwNTvzs4wmndg/UhtU2wOUguY1PGWaOdwVVia2eIvqKIBezDCeQTjmUtNJRpTmmx9ekAN9uCzU2SsOrpHW/lq7+mja++uX6+TOfq41//U86bzxS/9a6usUSGqpqNbzSLJcZ7lIMUfaJNQ4ldreYMJl8VOJVyGmob75+Va5q8Sterqd9/Rs69o/fqpR36JTTeMZESUNbzYz+jVE4mMI9cMhTVNn3LEaw70QeioIT2pHYC6IeMwfE98U553Y0t6XWnq3U2yP19unRT3qyGvRR6e6WWKIqSVfRu7Ww+ewQfBGHgqUJ5CODCLKmnWEHLuHValnpzj7bObFLvFMbGpbbSVhM4LHwcaMucXpNRofV1WworFsrrb5X+uX1qn/xSt3+tsv142c9TT+6+CL996teruY139UpjXEdVRtRPLRJAz6ownt3yiHJDnDlJFaDeNv2iPBth5y0p6IN1Pl1iHXvgiVa9tI/0JO++jXNvfyt0rFHSdVYo0mkWt7GBjo1OQ0nJTODHVan+E4MaIqS/Zg17QB8KF4fiRU0es7dr+UaChWnPctf+oQnaLspm/J6vSbPMmT5O3uTagEySBRxTr3SzmLw6kyZnVtNHXe2pKdeAbAnoNeoGE2iHZKO20uApOGt0o9/Il35RY299c/0syc/Q784/4m6/kn/W3e+6nJVP/81Hfvre3TC4LBWsMRWt27W8PAW3ntTZaWGRrJhtVuDKsWpHJfQkctULjuldGYvLg2AdQdL8Y8rsea95Q16zNXfkt76RumUR0n218/VRDUOMyX2BQn7ZM+BqOKYpHU4zvBTD++A5E5/747RTtNQzAIGwJcJTVQqsj81Svr7ZP84O4krWLJchkGrB05YgoTP8RaqKHMeEeCEYvaKTbrs1KexAZFEwBfO8QUkcqkU5dr4kx/rC69+pa57+9t1779+Rsfcs0onDw7q7Haqk0bqOmrriBaMjGuAt94eTk79cUk9sdRgckVxripDsyVWWC/npDo3zpuwY+s49Q8uHNC1iPjRb3mjnnP1tzXvVa+QlvPkNq9PtVJQm+uYJozFWPomV0Ke+8DIQGdCwbLC6ZTOORvAlEX7NdPvV2pTEIvjsms2m4qTpLgmsCoZArQ/KQoIxaygecvfG4+A5DE1wTn5gIQJxU3/GPutrJKo6doKKKgAHqtsikJtwjcwb22fCdvEpXBblZ4eydpCA7bk7D8nGaaVEU44ixaYA2wyb/lWzxPBF2VEnUUKTwsjiF8wp1/zx2s6sjauJVii/nZNZdWVp3UODlg5RiIAFUc9avqSGpyKkzxWucVEGZWiFMI4+x/YzyslrW05re8e0K3zFmnJ5W/Xk826vvY1LLUAj6VY7A2zVl0JY80jpxw5C/q9oVvlPFGwu0pkImTCcOWZhKYPupBzzgLR95VlAAAQAElEQVTzNftMt/fT3QHjaUWFAKR2u11451wx6F3+aFKP7OdBSr2GrCJAyF7wUY89X4NYiowlqdkcU0DQtlRxFcYEUCFgE7itvIn9JQzXFzAj82YUUq40mlzQFuCbkE4m7fZnbcwbYt0utWhsGUWhUzeXwX2NprqbmRKwSalsciQVr849nledvd1wd1WDPV3azEl+jPEM98a6r+S0eU6sdfN6dH2ItPGEFTr9rX+qp7PHC7/7YumkR0vdc5R19UulLonrGRtzppRhZEjIGHP2MTY7oSXxNl4zCAkGwgrGx8eLP8YdGBioW3q6vclhWvtA2SPWgYGkhFANjM45wJAVYLCyffFGz2NxciyNkpJ6zj1HWyBo1g8MFvskxyi7OCF2h1hJig4AgVqELRraFU5GAyd5KgYfFLwn48HOqj0w1/LMu6IAeriOxqHhQH+EmWE7kIC2UtsX+0ur36S+/WFFDV6aKVAped3X2q57eqXbB4KuJ309YPxp7zzlT7lUlWf/f9JzXqRH/d1H9NivXim98qXSsmOkOVyt+JhDRRAbRqiWlGax8qgkF8qkJaQNFO2FJFcKSzJvfMJIYLzi12SVIlC1WlUIwfSz2dLT7ZHS9HZRKpWaPgTZMutD0NjYmMzcJ4DRZt4+985yGJdLxayVAwbHLdNwOZEts6w+sr9GKZ78AJ7HBzaFJYAR4T2Kk72PGWKwVLmFMBTHKBNSMjNC2pzpy8Lde7S5c6G1Fx8HLSaGg09iEqFjOcwoM/Il60tS29I9vTrnLX+ii7/2ZT3j+p/rkut+oUt/dr2OvuIfNe89H9Cy9/6FBp73fKXHArzuLrXZHI6yj+TaTwHAWlckC7DJBzXsnpG+PF7QN2/jMM9pRsI+2sTFSMi8Wb8JneRYwPVUmHY37QCMvBtL2+1mCcCNDA+rx/ZcDGt0ZETOoSDi++JaSDwDPAHrJluGjz5a9f5ejfPyn7PhrpCXuESuHbj3yhC5l0vKcnEX+AoSD/UKXvKuuNpo2FptDDkVk8aiU/qcXDwtZV5Q7vhOfpEURIw2Y28r5z/hvXIbN3s8DxjbHGNtoiTc8TWibmn5SdLchVLfEVLvXOkIQvuHU4BNdtBiLAEvJlLEXq4bAFcZBr0CPKmV19kC5sX2LmukCqnsmVtxpsKb8XNqS65BQUPOZqUkW0nM+jlnBfr2vffe+0Gyp9356e6h2t13RfD+wz6EZk9vb2GpMpbLboBI3j51j/7lmOlNu3D2DCVHyosWqHzkEtXSlpzLsbYGukguKinzJQ0Hp00oYINva0sEKLhLk+354CSijnOOWMc5Aw9R64dAk6HFp/b0v6OSRbJOmxJLIgefzmtJKtiSy3K5VCphyXJ438TbbN+yFdJx+DnzAV+/sp6qNiOrOvd1OftCkCVFLOkuqMUzWzHhYLfFMm7/Q57FCZceM65qrI8y2w6fS+YdrFkoQnJgPyp8ljtuDRrEpXq93kjT9D3OuaecfPLJzSJzmj9+mukX5F2IL9+w+r4z2q3WHSGKGiGEIr/JxryIPMTHlu7dexpCyqGUQtXOiQsyHfvoM5VGnaHllDWwFGMoebxa1mB/otV9QXfNS7RxQbfyvi5h6iAkOf6LUZrsZ4pyFnlob4ru1LAGnRgYgKal0b5pPJEy1xKokygMoCHmsBO4RG6MjKld7lJj/lwd/dz/Lc0ZkLJcmVliSPQBvpQ2Ddq0Qq7t9v8VzKEu6qpojJeVtmsrJG3FIQA0rxjLShYTvanA8dm5JqNqyEJDPIYTS+kZMpMCO+lcpCRJWpJ+PTo6emwcx+8nfsCcP1A9LTr66NvipHxCs964Morj1E7AycTJa194YPLLs4aZksRSZ0vq/HPPBWTzdFO5W7fz/nl9uayb7UH+zDN5IXiZzn7/+/S4j/+Tnv+Zz8jbv5Po6laLg0AGKFKW7YIfCycA2Am8nLz4qPh1Moto5xMR7FSujLR5QOg9qVQtJst2DNhWroc2V8paR7938ILz6zm9uqFC9UefzAeHJfZMBAN3u5kqplMHCB399/T1EpNqWG3bR6fAKYd6YcVtQvPu7H2sACBt4oryDvBTFSFEc4Fx458IQUq9jzvnHjV//vwH7fuoOq0OiU0r/QcRL1WqL9m4cfOTWd42yrsGPzF42bKM+S/qW55d2RQJPlZunigzF6kRQWjM8gyfsqDmaiNwpC5FQclZ52jF29+r0z7+GZ3xlS/rwl/8TI+95WYt/b9flt7yTuk5L5Ue/1Tp+NOU9vRrhH2kD5G8hCXxfDPxtE/YcZaDojoJ+2KNZEp3tpfK1GjW4CFSw07VgFgsgTIAQ7HF1YvoIyl1a9gHreGUeXO1Szf3L9DIRU/WiR96r879DJPhlz+VTlshYaXTVtN6KbqoxqH46+hEgf8kV/yX8bIWA8ycMiyZHaeZfLntZzmAsaqCx1QhwvSGUocvQrmgtNXGUgrOZNW2bB/efn4I4TU6SD9/MPpduHDhNd57dtr6Trlcbk1eASCIgp0SwjQQFomH+gCECgqKUIoBuMY9o+wwsvQoLXnWpXLP/B3Zv9PNVxwlLeiRBrqV9g8o57Qp9l7tSpdaPlIJ0JogPHRsEhgth9UiuaN3T8w8wYQz6yYUXVeclJQDjyguMyFaUuzUBoissLDTJWH6VlZ7NYQFfvRb36yLPvsZPeknP9Ap//h3ip/3Aukxj5PgaczaMxFCqaomAC/+6YHNNzyGS45Di5NXAR++Ip1xlI7jkuxd2P68LGMfbMhCvtTwTGypVK4W8WazLZZY5bb85Pk3nHfz+/v7r6fwoDkbzUHr3Dn3jK1bt74pSZJx4rld0RgzGRvvrq4u7WwFLf+B3oOQDKEmFFRcrLKzWEmyjY69CKTj6Kiphh9T09fVjhrycVO5a6qGzWr6tvLRESVpKsfjfobVgg+Z8hxAsMMNuoe66KnjVfy85PCAIQE0OXs2UbENLy7ElElRqaTUx2qSnw3M1/OvvlonfOs/pde8WnoCgFtkE4J1t4fL4xivHnWFXgVXgjOpzWtGjqcLMSCBGjxR6FlfBjYzfD4E2fVJxL7Q+G5x9WKhpev1OgDMaCTZJHfO5cg2DSFcTp1nFAUH+eMPcv+aN2/eRxFMF/5ngI5zChZkginyJmIPDibLIg4bthxnnGYzu/RTKnHiVESbaknIXDFKc2ooysblhgflRwZVGR9SdXy7KrZcsizJ3l2hhWI0Xm+oXmsqxrpCpeOgYYrvJOzbEV1Gf847RU5Y0ki+Rf92MbdtUBEvNBX075kX7SOPUtrbr1ZXr5pJpBHXUtpVlv0NX6tllaBZYjmFTpO0nVgbgIlcibwdXuCQtLFDVMxV+IwtWvgSwDfg2WRmdVEEMM2qM8mzOI5vWL169Txk91dF5Rnw6UhxBjCCUB47NDT0PoTUMhAYSwYsCyf9A9NC8RmaStmLeS68HJddLbNtcaqxrAZeGF5aUuA1PrZ/KDHelgZHpVtulz79aa1525/pFx/6kDQ0KCVOdgAZr9dUKldUZi82PFYX0Oh0z9JWWCFyTPmTfrzBMyAgzHj+0yjxBsj/9SrJ/v/YxrZJNWiPDitiXxdAmzNgsx9L2BOOtesABPJY5BH8aJSpjjWuYvnK8uryMWMQ1L1SZ15qAj4grkAzbpEk1nlkxnVTi6hxJWhGYjJTw4pzQJq1WE0+jIzPPvbYY4eKghny8TOEj4INbt/ftWHDhiUkVrEHzGz2En+QQ5DqeBO4K8otbf8Msaa0KOvKI6zduHQPB7tf3qHalV/T9a9/s7715Kfou097um5+27u0/otfUfe6jbQHZjyXeABt+ykOxOzlxDaxXABAgK7wBkJq3++8uksVXltq8gBElVIB5vf97u/pcxddrOte8EJt+uv3S/Z09l/flq6/WdGmIbmNgyptHVSvrc+D2xWzd+0BjN0cfXLerwELqGNsOBudKYkoI9MEP2I/qCKRtbGkgNZAyNJabFtMbmYFrQZy2cyyfB7lbyI945yNbUYxtWjRos0I7Zg8zz9Zq9XSh2LOmVZQXsZS5RTJBzbbUUlmZXTdr/Sbt75PV51/sW6+5Fla9Ya3auBL39Dpa9frbO7KTnAVLeJwsPXXK8VNLN4sZipTYpiQii1vO/rH0qhQfzYJRxk4bA0txRWNNcYkLJjmdunVr32VTkqlI35xo9Z/5Ard/Wdv089f8BLd9vTn6MazLtSPTz5Ptbf+hfThf5b+67vStddJN9wsrVmraikoh45ZxDSi90zirFVYvCApwUfGgTHHhIgTywGvgNBAZ+CjCteh5WHCryLLI7CGvyQ+I52fkVzBVKVSecXw8PDjibKumcSJPcAh3GK5cbln+fEsNQ4YJvJtoDHS0L3f/JZO5u35xOEtOmFws44b3qqFY6PqI6/E/VovS1xt0xZwlUue9mz/zfqQKiygewjpWB0VHwDQksq8KWc2I3xbAxecq2H66Wq0tYw94RH3bdK5nLSXblur04a369E8Sa7/3Od1y4c/qh++7o/11Zddpn/5o9fqPz7wPuXbt7IM1xXYj4Lhzojpx0h3EnwBniY9ouFgUUwc2/PBf85vCKv3WuTzLGrPaPcQIj74fHNd8zPvfZVN9Ofhxi5MAUZHLSZ0lmlxh6PYBxUKAggVMSQXSQvnK+OQ4bJRcsaVsUdzMTjDSI7wTGfma6zREIpi2RySnJP9F0exzLhwuOzgS7v/2XUHK7dEmxZ3ibYFaCdeOmqBzvr939O6vm72bJ7TuVOeskyzxLazQXVHNc3PxzSvPq752DbPqf15l71Uz//Au+SqFXWzRyyTF7FnhG3BmIq+JNU4aOU2WGMyJ4P9Ql5YZ+KSbVuuRWYDHDo+U+TM8A/SmuEcwh7LyouHhoaeF0IYYy+Tjo+PCyGLuOIkATCsU9SLOYraXZd4stLCPg0cv1QZhwsrDYnEQVmD41LPnB41eEkQbes+UEANs4DcqTU4DUNK4BHQWGz3nlZKE7ROlQCQIuflgicl9Vz8RK3jYnicZ0AP7RbAKSdBSdlrmNNxHR63hEy/BmG/88//qJ5nP1sGZCVVdgRNeZtEkjDuHI6kVparCY0oSpTLS/TFRwqRjD6TNMX6vcc5xx2PDpkfIzk0eOWA8iU47cV/t1qttgmFsGWz37G85aDLgSUD3HA+InWlWvr0/6WxSlWpK8ve7jPK+8qxxodqajmvrbW63Bzu4EZGJCyOR+kB08ch1FSM4jPrpuOdIzTfEZnFUnKaRMA0mHfc/jgFy/RY4DPP1pxTTlWTg4lLIqWYygbLvpoAUNKq/n4tfvlL9KzbuAd+7Fkgdo4U9avJvjQqMUGwcE3GBHblAWvggJQAvlajrpSJojiifqB+M4+i6K5Vq1Y9ign5bkgfUs4fStw65zL8JewN38QS3HAu5HUsljMt2UBYklIsSrXaJ3Un6jlphTahrBGsynBPj9YlFd3ug37d06WbeiuKH3OOLnnVK6WjjpGcP586uQAADOdJREFUZxn38tgX8UP/KoNE8EXKdzx1iOxwlmuJiEhwRecqzGYCOLB25z7nUg2B4e2tlsYAZh3wr+bub/3SJTr7Pe/W3Msvl3q61eido5yDTNuVFJJywUHupLgUq8V2wSmDLwgp5ZBSlsfqjQHmhvIsSpJPO+eWL1u27E7j5VDz/lBj2Pjt6+u7ggvVY3LpOp6tChU5lIJ+VG0ERfY/S9HI1H3scg2Cji19XVpZTXRdT0lzX/MynfnJv9fjrr1GJ/7HZ1V97nOkxYulUIa0E8qUI5bzKmIgJNpxDlGZBwrE+EoBYJQ4DJQJzcmgQ3+KaeIz+YsvUpMXnTFqtitlbe7r0y3Lj9Q5X/is9ILnir2AVOoV15caht80MahJ9fGWSkyqNneHcRwglslx3ZLXDHIZveRpnIRtg4ODzw/O8bBNlUPUmSwPSdaPPfbYDd65x9TGR97R5iTRbLMqMxrPzb8MHnG3tGCJ1vbP0UlvfrOe8LFP6Hlcdyz80/9fespvK1u6WPUKlopNv2wTj8lxrOHOOeSRKQJIbKqMEmmcZeNzoh0HKIiEFNOWEQEwOVixPVvLkNvdL81dqDN56928aLFWLVigZS9+sZ72nauk006VunvULpeUtzM1uJyusDc0MlBSdzVWs56qFCeWxAc1Gw3F5UTO5Zzx3fdLzs1dNHfu/6XwkHb+kOYe5vu7et+/bc19p+SJ7mz4VtZOR6XEK7P/b6w5i/TKn/xUeull0m89TarMlwLAiHplf7gSxWWlJTb1VawfB5I8czLQQVbgSYktpZbAAzMzsMTMZXKFyctIBLxXLQqq+URN7BPw5RtJebeSF71c3ypVdPpff0jx2wB/mf5L/RoZHcUuNuWShsqlhkJWxxI21Mbq2V9le2PA0J55tQFoUu0WnY5uHdz8nsi5i/U/5HfIA9D0sHTZsjvKLl5Rzxr/EpXiuhwA9AAgLkv9PVga4l2si/MGpCr3MACtVOqypmLl0xhWKAVLPgRFnFwzs2qUcqrk+zAueA4YeQFHw0uL02rkY9VrpBLEu2SJ/vSqq1R+ChOgt195UlGL/nu6+zRu/5MieVsOa+uzVBGgK8eRYvaPMctxnSXXeg9x1JT8PbfffueZ8+cu+nPL+5/ikdD/lKGAtdBz2eDg+JOwIOuiSjXHBAkzo1AOKpZop46FKyybVw7qKkigCwCAI2FhJBZdH+IijFjOHTHzVKNERRVXxCZzpBCcypJK+C5fodSrUnEqni36AfoCLG8UYxUF2JziYl/nVa30KU1j2EzIr0gK0IcuICahuMTEceI5KP9H591xJ5100iF50LCx7M4z2t0VHZr5c+bM+XG50rWEbdjn05yFmKsMF1QoPcXKhHKhVBSfA5SAwlV4PczPUW6eYMJ5QvxEZiAFZWj5wpMUHUiAKLfl3cDsqeFdUWQfB2O5ImVsHu1qBZ7hK1UIwd50c8KR1WtW/06cJG+w+nvi77zzzmV3333Lgj2pOxPq+JnAxJ7wwH3fe2+99VYuy/aktkyJL+Kl5HVYMbum0wh3fbakQoeL3oY8yx0K3jNi+1DL+jNvJCbDyXgG4uCv4MX4SVn6jSfym+T/p3Ou9+ijj+ax2Fo8vE/bzb8/cuni2/r6Flzw8LVnRo1dADgzWJqaCw66f8wStGbbtm2vnrrGg3N5hP/4bbfdNlCr1X7U29ublUqlAnwWWu2dAWHp6fAP7MPSAEzmJ+MW2uSI2X8Sbw8ODr4d8D19T/n5wQ9+cGyepzf5EF4JgFtpq9W7p20Pdr1DAoAoBd3EebPZLHMH+GGs2d/uqeBOPvnkJi8nT+Dy+j20aduDPaGgWXiLT6c3y2YeQGlnb3nmzepZPgMEk9mN99577/J58+Z9cE95uuOO29/0hCc8/hZO76fVazXPIaq6fWS0b0/bH+x6hwQA16xZ81sAppwkiQeESXd396uxiF/ZG+EB3Hdv3779CNrdQbu2Kd888Wl18L2DvsUn/WQmwCv+TJ70P2O9zjjuuONWEd8jx6T64vHLj38v4OsK7DFpb+1co1bjuG/Rme8PCQBiGh6PlfCAR2bBxsfHPXukp6LM2/ZGxP39/YOA+ATofQZarFStvWn+iOrCY2FpJ0P63pFmTMbApvXr119A/FV72sHKlStPZyL+pqen55lY0JKBz9pyWNHQ4KDG63VLHhL+kAAgluoopOlshiN4rvK4y5NilHoMfsvdd999AuV77KDzMqzHJVifjTTiuobvNDl432XpBWhFmnwD3xdJL1y6dOm1e9r9Pffc8/4VK1b8At6XMREDdIqmbd6bLdI/MGD/CwfTOibrZ395v78ITScdrNbRAK04LRIvLIj1R55dnvUeddRRt27YsOF1lrennn3Wd035bP6/ShtwzV0vESxKcUAguiOkH0sWaSufTFvcCmhs1yYWLTw0i3CynoVm+awegMnxY0NDQy+n/xcWFffwA53vHnPMMX/C6Z7LQ254OFQZXQQi9n7cJ3Ihzkkapbo9JHnQq8HrQefhYRk44ogjelGWTIGmXIvXWWZQpN2bmSXUggUL/ooT8sceltgDKmBJnrV58+ZXYRW3oky7e3sQmKw/luxiAlAPfefiZG1XPdY/T3aJ2BIUeUbegGl8mgcskxZPnL4z8n4Fve6BgYE9/oPRO+644zzorAKAF0G/ZJOQsKA7ufzaW7HlcRK2k75NTEvOeH9IABCFVUdHR3coGkUUe0EAU4AA5QeUHrPHeyll39xbqQPwT0JjHoD+CcDm3jgpwER6B7AAqim2mASWb3tR68cAaf8E0uKVSqW4bzSAwDOX37GBrmjD5EkB0Uegc5rV3VPPif9ty5Yt+xH9HMl4d1i2yQmRYfFAohKsoYUcSGyC7Ki3p/0crHqHBAABV4WT7w4ZAbIdcZRSxFGQWa6E9CUo5+Yicy8/gOYC9ob21toygNEv77XjPKtVBM0CTNaPkbUyQFXkc81jWYU15GAADjr6B3CWNw4gV7PkroDmG4uKe/hZtWrVAG1eSXXb/zatT/PwWfRhcjCLZ/8swYBn3ixiCNHsNQxC2y/ue9/7XoTSF7B0mTJtdu8IAVuxLJpSLI4VM0Cgg+hk6m++/vrr5+0tEyzl77zuuuuOA3A30m9m4IJWYQlN4daPAcv6AliFlTNAYDlF/aI7K7e4LbmUfRl/NHTvLgr34sMryCAW88itW7c+E/rfh04bunYfWvAzScpOvwy6sLSWF+JQ7BEtPtP9jLeAKNFu9ZFvVMx6lLBLaKAwhbMspsTXUP8qrjXef8MNN5x69tlnb3kkCjj//PPvg84ZmzZt+jjtwVy2A/gAQubJN7BbUEwILFVRx3ihreVv52D0WgDzIkvsi2eL8J8s778N4OPf/OY3HyS8hUmXmyzoVA32w2b9KvaXPnREeUpwSLgZD0Asx2ORpLN9FiArZjlKtWuGYRSwiiXzGgD3V9dcc80J5B9F3pMXL1789nPPPXcD7fbJ0fcrb7311vNR6L3Qzc3qGUGAXpyIJ4EIQi27ACI8Gm/XU79/0aJF/1AU7MfP8ccffzm0T7vpppvOYYn+Ypbla0vlciEX68auY8bHx+yKx5Iz3s94ALKnOt1mO0thDWmuZGn8d56r/hAl9AG4Yzh4PHH58uVvfuITn3gX5fvdnXLKKb+gr2NZAj/PUtw28AGyYunPsqwAnQHR8qlHVvY3hOfsd0YeQPCss876b65knhOieOkvr7/hJUySb3IgGeU6Jq9UuvcYgA8ge8CTMx6ALGPXcdH8CpReRbEnchh5Ic9VtjQeUGExAV7EdcjvwsMWAxuALLYCE0zYcrh+9erVx7EUv2ki74AFZ55zzmejuPT0ECU9N9/8qytarfatB6zzfexoxgPwtNNOu5qb/3/dx3Hul+Ynn3zyFwDgfAD4DYCWYxHt4GH/u8pfJ38xE2OP33H3C0NTEDn99NP/+AlPeMJe34dOQeqAZM14AB4QKexlJ+wFfwdr+OeEXye8jPCZe0litvqEBGYBOCGIvQ1OOOGEd7IteAbhHr9o7G0fh0P9WQAeDlqewWOcBeAMVs7hwNrBA+DhIN3ZMT6sBGYB+LAimq0wnRKYBeB0SneW9sNKYBaADyui2QrTKYFZAE6ndGdpP6wEZgH4sCKarTCdEpgF4HRKd2ras7k7SWAWgDsJYzZ64CUwC8ADL/PZHneSwCwAdxLGbPTAS2AWgAde5rM97iSBWQDuJIzZ6IGXwCwAD7zMD98epxj5LACnEMps1oGTwCwAD5ysZ3uaQgKzAJxCKLNZB04CswA8cLKe7WkKCcwCcAqhzGYdOAnMAvDAyXq2pykkcJgAcIqRz2bNCAnMAnBGqOHwZWIWgIev7mfEyGcBOCPUcPgyMQvAw1f3M2LkswCcEWo4fJmYBeD/cN3P9OH9PwAAAP//VsOaJgAAAAZJREFUAwBe6LQSSVGIEwAAAABJRU5ErkJggg==" alt="TwitchSamaTTS logo" />
  <h1>TwitchSamaTTS<small>Microsoft Sam reads your chat &middot; 450 voices</small></h1>
</header>
<div id="voiceSetupBar" class="voice-setup-bar" hidden translate="no">
  <span>⚠ No speech voices were found.</span>
  <button id="voicesetup" data-tip="Open Voice Setup: choose whether to install the Microsoft voices and/or the Bonzi Buddy voice. Nothing is installed until you click a button there.">Open Voice Setup</button>
  <span id="voicesetupmsg"></span>
</div>
<div class="row">
  <input id="channel" type="text" placeholder="channel name or twitch.tv URL" data-tip="Type a channel name or a full twitch.tv link (popout links work too). Press Enter to start." />
  <button id="start" class="primary" data-tip="Connect to that channel and start reading its chat aloud with the selected voice.">Start</button>
  <button id="stop" data-tip="Leave the channel and stop speaking.">Stop</button>
  <button id="skip" data-tip="Stop the sentence being spoken right now and clear every message waiting in the queue.">Skip message</button>
  <button id="testchat" data-tip="Start a fake test channel that makes up random chat messages every few seconds. No Twitch account or internet needed.">Test chat</button>
</div>
<div class="row">
  <label>Language:</label><select id="language" data-tip="Only filters the Voice list below. The dice buttons and Auto voice still pick from all voices in every language."></select>
  <label>Voice:</label><select id="voice" data-tip="Pick who reads chat: 501 voices including the authentic Bonzi Buddy voice (L&amp;H TruVoice Adult Male #2, pitch 140 / speed 157) plus 401 funny versions (Deep, Chipmunk, Baby, Monster)."></select>
  <button id="dice" data-tip="Pick a random voice from all 450, funny ones included.">🎲 Random voice</button>
  <button id="funnydice" data-tip="Pick a random voice from the 401 funny versions only.">🎲 Funny voice</button>
  <button id="fxdice" data-tip="Roll a fresh random pitch and speed for the current voice. Every press gives a different combination. The voice itself does not change.">🎲 Auto pitch + speed</button>
  <div class="auto-box"><button id="auto" data-tip="Turn automatic voice switching ON or OFF. A new random voice is picked every N seconds.">Auto voice: OFF</button>
  <label>every</label><input id="interval" type="text" value="45" size="3" data-tip="Seconds between automatic voice changes (5 to 600)." /><label>sec</label></div>
</div>
<div class="row">
  <label>Speed:</label><input id="rate" type="range" min="-10" max="10" value="0" data-tip="Speech speed, from very slow to very fast. Auto FX and the FX dice can still change it per message." />
  <label>Volume:</label><input id="volume" type="range" min="0" max="100" value="100" data-tip="How loud the spoken voice is, from 0 to 100." />
  <button id="names" data-tip="Say who sent each message before reading it, like xqc says, hello chat.">Read names: OFF</button>
  <button id="fxreset" data-tip="Put pitch and speed back to normal after using the FX dice.">Reset FX</button>
  <button id="autofx" data-tip="When ON, every single message is read with its own random pitch and speed, so no two lines sound the same.">Auto FX: OFF</button>
  <button id="sound" data-tip="Turn the interface clicks and button dingles ON or OFF. This does not affect the speaking voice.">🔊 Sound: ON</button>
</div>
<div class="row">
  <button id="midiplay" data-tip="Play a random Annoying MIDI from the 23-track pack. Only one plays at a time.">🎵 Annoying MIDI</button>
  <button id="midistop" data-tip="Stop the MIDI that is playing right now.">⏹ Stop MIDI</button>
</div>
<div id="chat"></div>
<div id="status">starting...</div>
<div id="tip"></div>
<script>
const FUNNY_SUFFIXES = ['Deep', 'Chipmunk', 'Baby', 'Monster'];
function isFunnyVoice(name) {
  return FUNNY_SUFFIXES.some(s => String(name || '').endsWith(' - ' + s));
}
let allVoices = [];
let voiceLangs = {};
let lastVoicesSig = '';
let lastLangsSig = '';
let lastLang = null;
let lastCurrent = null;
let lastNames = false;

// Short synthesized interface sounds - no audio files, nothing downloaded.
let soundOn = true;
let audioCtx = null;
function getAudio() {
  if (!soundOn) return null;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch (e) { return null; }
}
function tone(freq, dur, type, vol, delay) {
  const c = getAudio();
  if (!c) return;
  const t = c.currentTime + (delay || 0);
  const o = c.createOscillator(), g = c.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(c.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
// Soft "dingle" bells whose notes come from the main melody of the
// Flintstones theme. Each press plays the next note of the tune, so pressing
// buttons a few times in a row plays a little recognizable bit of the song.
const FLINT_MELODY = [
  392.00, 261.63, 523.25, 440.00, 392.00, 261.63,                          // G  C  ^C A  G  C   "Meet the Flintstones"
  392.00, 349.23, 329.63, 329.63, 349.23, 392.00, 261.63, 293.66, 329.63,  // G  F  E  E  F  G  C  D  E  "the modern Stone Age Family"
  392.00, 261.63, 523.25, 440.00, 392.00, 261.63,                          // G  C  ^C A  G  C   "From the town of Bedrock"
  329.63, 349.23, 392.00, 261.63, 293.66                                  // E  F  G  C  D       "yabba-dabba-doo"
];
let melodyStep = 0;
function nextMelodyNote() {
  const f = FLINT_MELODY[melodyStep % FLINT_MELODY.length];
  melodyStep++;
  return f;
}
function dingle(freq, delay, vol) {
  const dur = 0.18 + Math.random() * 0.07;
  tone(freq, dur, 'sine', vol, delay || 0);
  // faint bell shimmer, slight detune so it does not sound like a plain beep
  tone(freq * 2.01, dur * 0.55, 'sine', (vol || 0.04) * 0.22, delay || 0);
}
function sfx(kind) {
  const f = nextMelodyNote();
  if (kind === 'tick') dingle(f, 0, 0.02);
  else if (kind === 'dice') dingle(f, 0, 0.032);
  else if (kind === 'start' || kind === 'on') dingle(f, 0, 0.035);
  else dingle(f, 0, 0.03);
}

// ---- Annoying MIDI player -------------------------------------------------
// The browser fetches and parses a MIDI; the engine plays the parsed notes on
// the real Windows MIDI synthesizer with a new random GM instrument each time.
function midiVLQ(b, p) {
  let v = 0, x;
  do { x = b[p.p++]; v = (v << 7) | (x & 0x7f); } while ((x & 0x80) && p.p < b.length);
  return v;
}
function parseMidi(b) {
  const p = { p: 0 };
  const tag = (i, n) => String.fromCharCode.apply(null, b.slice(i, i + n));
  const u16 = () => { const v = (b[p.p] << 8) | b[p.p + 1]; p.p += 2; return v; };
  const u32 = () => { const v = ((b[p.p] << 24) | (b[p.p + 1] << 16) | (b[p.p + 2] << 8) | b[p.p + 3]) >>> 0; p.p += 4; return v; };
  if (tag(0, 4) !== 'MThd') throw new Error('not a MIDI file');
  p.p = 4;
  const hlen = u32();
  u16();
  const tracks = u16();
  let div = u16();
  if (div & 0x8000) div = 480;
  p.p = 8 + hlen;
  const tempos = [{ tick: 0, mpq: 500000 }];
  const held = new Map();
  const notes = [];
  for (let t = 0; t < tracks; t++) {
    if (p.p + 8 > b.length || tag(p.p, 4) !== 'MTrk') break;
    p.p += 4;
    const len = u32();
    const end = Math.min(p.p + len, b.length);
    let tick = 0, running = null;
    while (p.p < end) {
      tick += midiVLQ(b, p);
      let status = b[p.p];
      if (status === 0xff) {
        p.p++;
        const type = b[p.p++];
        const l = midiVLQ(b, p);
        if (type === 0x51 && l >= 3) tempos.push({ tick, mpq: (b[p.p] << 16) | (b[p.p + 1] << 8) | b[p.p + 2] });
        p.p += l;
        continue;
      }
      if (status & 0x80) { p.p++; if (status < 0xf0) running = status; }
      else status = running;
      if (status === 0xf0 || status === 0xf7) { p.p += midiVLQ(b, p); continue; }
      if (status == null || status >= 0xf0) { p.p++; continue; }
      const hi = status & 0xf0, ch = status & 0x0f;
      const d1 = b[p.p++];
      const d2 = (hi === 0xc0 || hi === 0xd0) ? 0 : b[p.p++];
      const key = ch + ':' + d1;
      if (hi === 0x90 && d2 > 0) held.set(key, { tick, note: d1, vel: d2 });
      else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        const n = held.get(key);
        if (n) { held.delete(key); notes.push({ start: n.tick, end: tick, note: n.note, vel: n.vel }); }
      }
    }
    p.p = end;
  }
  for (const n of held.values()) notes.push({ start: n.tick, end: n.tick + div / 4, note: n.note, vel: n.vel });
  tempos.sort((a, z) => a.tick - z.tick);
  function timeAt(tick) {
    let s = 0;
    for (let i = 0; i < tempos.length; i++) {
      const seg = tempos[i];
      const next = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
      if (tick <= next) return s + Math.max(0, tick - seg.tick) / div * (seg.mpq / 1e6);
      s += (next - seg.tick) / div * (seg.mpq / 1e6);
    }
    return s;
  }
  const events = [];
  for (const n of notes) {
    events.push({ t: timeAt(n.start), status: 0x90, note: n.note, vel: n.vel });
    events.push({ t: timeAt(n.end), status: 0x80, note: n.note, vel: 0 });
  }
  events.sort((a, z) => a.t - z.t || a.status - z.status);
  return { events: events.slice(0, 6400) };
}
let midiSeq = 0;
async function playRandomMidi() {
  const seq = ++midiSeq;
  try {
    const j = await (await fetch('/midi')).json();
    const bin = atob(j.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = parseMidi(bytes);
    if (seq !== midiSeq) return; // a newer click or Stop superseded this one
    await fetch('/midiplay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: parsed.events })
    });
  } catch (e) {}
}
// Hover help bubbles for every control.
const tipEl = document.getElementById('tip');
function showTip(el) {
  const t = el.getAttribute('data-tip');
  if (!t) return;
  tipEl.textContent = t;
  tipEl.classList.add('show');
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  // Prefer below the control so the popup never covers what is being hovered.
  let y = r.bottom + 10;
  if (y + h > window.innerHeight - 6) y = r.top - h - 10;
  x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
  y = Math.max(6, Math.min(y, window.innerHeight - h - 6));
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}
function hideTip() { tipEl.classList.remove('show'); }
document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', () => showTip(el));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('focus', () => showTip(el));
  el.addEventListener('blur', hideTip);
});

// The Language dropdown is a browsing filter only. It never changes which
// voices the dice button or the automatic rotation can pick from.
function filteredVoices() {
  const lang = document.getElementById('language').value;
  if (lang === '__all__') return allVoices;
  if (lang === '__funny__') return allVoices.filter(isFunnyVoice);
  return allVoices.filter(v => voiceLangs[v] === lang);
}
function fillLanguages() {
  const sel = document.getElementById('language');
  const remembered = sel.value;
  const names = Array.from(new Set(Object.values(voiceLangs))).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '';
  const all = document.createElement('option'); all.value = '__all__'; all.textContent = 'All languages (' + allVoices.length + ')';
  sel.appendChild(all);
  const funny = document.createElement('option'); funny.value = '__funny__'; funny.textContent = 'Funny voices (' + allVoices.filter(isFunnyVoice).length + ')';
  sel.appendChild(funny);
  for (const l of names) { const o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); }
  sel.value = (remembered === '__all__' || remembered === '__funny__' || names.includes(remembered)) ? remembered : '__all__';
  lastLang = sel.value;
}
function fillVoices(preferred) {
  const sel = document.getElementById('voice');
  const list = filteredVoices();
  sel.innerHTML = '';
  if (preferred && !list.includes(preferred)) {
    const note = document.createElement('option');
    note.textContent = '(currently: ' + preferred + ')';
    note.value = ''; note.disabled = true; note.selected = true;
    sel.appendChild(note);
  }
  for (const v of list) { const o = document.createElement('option'); o.textContent = v; o.value = v; sel.appendChild(o); }
  if (preferred && list.includes(preferred)) sel.value = preferred;
}
async function api(cmd, value) {
  try { await fetch('/cmd', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({cmd, value})}); }
  catch(e) { document.getElementById('status').textContent = 'Connection to engine lost: ' + e; }
}
async function refresh() {
  try {
    const s = await (await fetch('/status')).json();
    document.getElementById('status').textContent =
      (s.connected ? 'Connected to #' + s.channel : 'Not connected') +
      ' | Voice: ' + s.currentVoice + (s.speaking ? ' | SPEAKING' : ' | idle') +
      (s.autoVoice ? ' | Auto voice ON (' + s.autoInterval + 's)' : '') +
      ' | queued: ' + s.queueLen;
    const vsBar = document.getElementById('voiceSetupBar');
    vsBar.hidden = !s.voiceSetupNeeded;
    document.getElementById('voicesetupmsg').textContent =
      s.voiceSetupError ||
      (s.voiceSetupResult ? s.voiceSetupResult.message : '');
    const langSel = document.getElementById('language');
    const voicesSig = s.voices.join('|');
    const langsSig = JSON.stringify(s.voiceLanguages || {});
    const voicesChanged = voicesSig !== lastVoicesSig;
    const langsChanged = langsSig !== lastLangsSig;
    if (voicesChanged) { lastVoicesSig = voicesSig; allVoices = s.voices.slice(); }
    if (langsChanged) { lastLangsSig = langsSig; voiceLangs = s.voiceLanguages || {}; fillLanguages(); }
    let rebuild = voicesChanged || langsChanged;
    if (langSel.value !== lastLang) { lastLang = langSel.value; rebuild = true; }
    if (s.currentVoice !== lastCurrent) {
      lastCurrent = s.currentVoice;
      rebuild = true;
      // If the dice or auto voice jumped to another language, reveal it.
      if (langSel.value !== '__all__' && !filteredVoices().includes(s.currentVoice)) {
        langSel.value = '__all__'; lastLang = '__all__';
      }
    }
    if (rebuild) fillVoices(s.currentVoice);
    const ab = document.getElementById('auto');
    ab.textContent = 'Auto voice: ' + (s.autoVoice ? 'ON' : 'OFF');
    ab.className = s.autoVoice ? 'on' : '';
    lastNames = !!s.names;
    const nb = document.getElementById('names');
    nb.textContent = 'Read names: ' + (lastNames ? 'ON' : 'OFF');
    nb.className = lastNames ? 'on' : '';
    const fxOn = typeof s.pitchFx === 'number' && s.pitchFx >= 0;
    const fb = document.getElementById('fxdice');
    fb.textContent = fxOn
      ? '🎲 FX: pitch ' + (s.pitchFx > 0 ? '+' : '') + s.pitchFx + ' / speed ' + (s.rate > 0 ? '+' : '') + s.rate
      : '🎲 Auto pitch + speed';
    fb.className = fxOn ? 'on' : '';
    const af = document.getElementById('autofx');
    af.textContent = s.autoFx
      ? 'Auto FX: ON' + (s.lastFx ? ' (' + (s.lastFx.pitch > 0 ? '+' : '') + s.lastFx.pitch + ' / ' + (s.lastFx.speed > 0 ? '+' : '') + s.lastFx.speed + ')' : '')
      : 'Auto FX: OFF';
    af.className = s.autoFx ? 'on' : '';
    const mstop = document.getElementById('midistop');
    mstop.className = s.midiPlaying ? 'on' : '';
    document.getElementById('rate').value = s.rate;
    document.getElementById('volume').value = s.volume;
    const chat = document.getElementById('chat');
    const html = s.recent.map(m => '<div class="msg"><span>' + m.t + '</span><b>' + esc(m.who) + ':</b> ' + esc(m.text) + '</div>').join('');
    if (chat.innerHTML !== html) { chat.innerHTML = html; chat.scrollTop = chat.scrollHeight; }
  } catch(e) {}
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
document.getElementById('start').onclick = () => api('start', document.getElementById('channel').value);
document.getElementById('stop').onclick = () => api('stop');
document.getElementById('skip').onclick = () => api('skip');
document.getElementById('testchat').onclick = () => api('test');
document.getElementById('voicesetup').onclick = () => api('voicesetup');
document.getElementById('voice').onchange = e => api('voice', e.target.value);
document.getElementById('language').onchange = () => fillVoices(lastCurrent); // filter only; does not change voice
document.getElementById('dice').onclick = () => api('random');
document.getElementById('funnydice').onclick = () => api('funnyrandom');
document.getElementById('fxdice').onclick = () => api('fx');
document.getElementById('fxreset').onclick = () => api('fxreset');
document.getElementById('autofx').onclick = () => api('autofx');
document.getElementById('auto').onclick = () => { api('interval', document.getElementById('interval').value); api('auto'); };
document.getElementById('rate').oninput = e => api('rate', e.target.value);
document.getElementById('volume').oninput = e => api('volume', e.target.value);
document.getElementById('names').onclick = () => api('names', lastNames ? 'off' : 'on');
document.getElementById('midiplay').onclick = () => playRandomMidi();
document.getElementById('midistop').onclick = () => { midiSeq++; api('midistop'); };
document.getElementById('channel').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('start').click(); });

// Track toggle state locally so rapid clicks still get the right ON/OFF cue
// (the green class only repaints on the next status poll).
const toggleState = {
  auto: document.getElementById('auto').className.indexOf('on') >= 0,
  names: document.getElementById('names').className.indexOf('on') >= 0,
  autofx: document.getElementById('autofx').className.indexOf('on') >= 0
};

// Interface sounds: rising chime for ON, falling for OFF, rattle for dice.
document.addEventListener('click', e => {
  const b = e.target.closest ? e.target.closest('button') : null;
  if (!b || b.id === 'sound') return;
  if (b.id === 'start' || b.id === 'testchat') sfx('start');
  else if (b.id === 'stop') sfx('stop');
  else if (b.id === 'skip') sfx('reset');
  else if (b.id === 'dice' || b.id === 'funnydice' || b.id === 'fxdice') sfx('dice');
  else if (b.id === 'fxreset') sfx('reset');
  else if (b.id === 'auto' || b.id === 'names' || b.id === 'autofx') {
    const wasOn = toggleState[b.id];
    sfx(wasOn ? 'off' : 'on');
    toggleState[b.id] = !wasOn;
  }
  else if (b.id === 'midiplay') sfx('dice');
  else if (b.id === 'midistop') sfx('stop');
  else sfx('click');
});
document.getElementById('sound').onclick = () => {
  const b = document.getElementById('sound');
  if (soundOn) { sfx('off'); soundOn = false; b.textContent = '🔇 Sound: OFF'; }
  else { soundOn = true; b.textContent = '🔊 Sound: ON'; sfx('on'); }
};
['rate','volume','voice','language','interval'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => sfx('tick'));
});
setInterval(refresh, 600); refresh();
</script></body></html>`;

function startPanel() {
  let lastPanelPing = Date.now();
  const server = http.createServer((req, res) => {
    lastPanelPing = Date.now(); // any request from the panel counts as "window open"
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PANEL_HTML);
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        channel: channel || '',
        connected: !!(ws && ws.readyState === WebSocket.OPEN) || !!testTimer,
        speaking, queueLen: queue.length,
        currentVoice, voices: voiceNames, voiceLanguages,
        autoVoice, autoInterval, rate: curRate, volume: curVolume,
        pitchFx: curPitchFx, autoFx, lastFx,
        names: options.names,
        midiPlaying: midiProcs.size > 0,
        censorTerms: blanketEntries.length + standaloneEntries.length,
        voiceSetupNeeded, voiceSetupError,
        voiceSetupOpen: !!(voiceSetupProc && voiceSetupProc.exitCode === null),
        voiceSetupResult: voiceSetupLastResult,
        recent: recent.slice(-40)
      }));
      return;
    }
    if (req.url === '/midi') {
      const pick = MIDI_TRACKS[Math.floor(Math.random() * MIDI_TRACKS.length)];
      const data = loadMidiAsset(pick[0]);
      if (!data) { res.writeHead(404); res.end('midi not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ name: pick[1], file: pick[0], data: data.toString('base64') }));
      return;
    }
    if (req.url === '/midiplay' && req.method === 'POST') {
      const gen = midiStopGen; // stale if Stop arrives while this body streams in
      let body = '';
      req.on('data', c => { body += c; if (body.length > 512000) req.destroy(); });
      req.on('end', () => {
        let stale = false;
        try {
          const j = JSON.parse(body);
          stale = gen !== midiStopGen;
          if (!stale) {
            killMidiPlayback();
            const program = Math.floor(Math.random() * 128);
            const lines = (j.events || []).map(e =>
              Math.round(e.t * 1000) + ' ' + e.status + ' ' + e.note + ' ' + e.vel).join('\n');
            const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TwitchSam');
            fs.mkdirSync(dir, { recursive: true });
            const evPath = path.join(dir, 'midi-events.txt');
            fs.writeFileSync(evPath, lines);
            const proc = spawn(midiHelper, [evPath, String(program)], { stdio: 'ignore', windowsHide: true });
            midiProcs.add(proc);
            proc.on('exit', () => { midiProcs.delete(proc); });
          }
        } catch (e) { console.log('[midi] ' + e); }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(stale ? 'stale' : 'ok');
      });
      return;
    }
    if (req.url === '/cmd' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.cmd === 'start') {
            if (!startListening(j.value)) console.log('[gui] invalid channel: ' + j.value);
          } else if (j.cmd === 'stop') stopListening();
          else if (j.cmd === 'auto') runCommand('/auto');
          else if (j.cmd === 'interval') {
            const n = parseInt(j.value, 10);
            if (!isNaN(n) && n >= 5 && n <= 600) { autoInterval = n; if (autoVoice) setAutoVoice(true); }
          } else if (j.cmd === 'voice') runCommand('/voice ' + j.value);
          else if (j.cmd === 'rate') runCommand('/rate ' + j.value);
          else if (j.cmd === 'volume') runCommand('/volume ' + j.value);
          else if (j.cmd === 'names') runCommand('/names ' + j.value);
          else if (j.cmd === 'fx') runCommand('/fx');
          else if (j.cmd === 'fxreset') runCommand('/fx reset');
          else if (j.cmd === 'autofx') runCommand('/autofx');
          else if (j.cmd === 'test') runCommand('/test');
          else if (j.cmd === 'voicesetup') openVoiceSetup('Opened from the control panel.');
          else if (j.cmd === 'midistop') stopMidiPlayback();
          else runCommand('/' + j.cmd);
        } catch {}
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(options.port, '127.0.0.1', () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    console.log('Control panel: ' + url);
    openPanelWindow(url);
  });

  // If the panel window is closed, its polling stops - exit with it.
  setInterval(() => {
    if (Date.now() - lastPanelPing > 20000) shutdown(0);
  }, 5000);
}

function openPanelWindow(url) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const browser = candidates.find(p => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'TwitchSam-panel-profile');
  if (browser) {
    try {
      const child = spawn(browser, [
        '--app=' + url, '--window-size=560,760', '--no-first-run',
        '--no-default-browser-check', '--user-data-dir=' + profile,
        '--disable-features=Translate,TranslateUI', '--disable-translate'
      ], { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    } catch {}
  }
  // fallback: system default browser (no cmd window)
  try { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}
