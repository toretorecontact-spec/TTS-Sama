// TTS-Sama build helper: mark the Windows EXE as a GUI-subsystem program.
// Node's node.exe is a console app, so double-clicking a SEA build pops a cmd
// window. Flipping the PE Subsystem field to IMAGE_SUBSYSTEM_WINDOWS_GUI (2)
// stops Windows from allocating that console - the app is a panel in Edge
// anyway and never needs one.
'use strict';
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('usage: node patch-gui.js <exe>'); process.exit(1); }
const b = fs.readFileSync(file);
if (b.toString('ascii', 0, 2) !== 'MZ') throw new Error('not a PE image');
const pe = b.readUInt32LE(0x3c);
if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('bad PE signature');
const opt = pe + 24;
const magic = b.readUInt16LE(opt);
if (magic !== 0x10b && magic !== 0x20b) throw new Error('unsupported optional header');
const field = opt + 68; // Subsystem lives at +68 in both PE32 and PE32+.
const before = b.readUInt16LE(field);
if (before === 2) { console.log('already GUI subsystem'); process.exit(0); }
b.writeUInt16LE(2, field);
fs.writeFileSync(file, b);
console.log(`patched PE subsystem ${before} -> 2 (GUI)`);
