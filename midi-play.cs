using System;
using System.IO;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

// TTS-Sama - plays a pre-parsed note list on the Windows General MIDI
// synthesizer. The host picks a random GM program and passes it as arg 2.
class MidiPlay {
  [DllImport("winmm.dll")]
  static extern int midiOutOpen(out IntPtr h, uint dev, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")]
  static extern int midiOutShortMsg(IntPtr h, uint msg);
  [DllImport("winmm.dll")]
  static extern int midiOutClose(IntPtr h);
  [DllImport("winmm.dll")]
  static extern int midiOutReset(IntPtr h);
  static int Main(string[] args) {
    // Stop mode: silence every voice still ringing on the shared synth.
    if (args.Length >= 1 && args[0] == "stop") {
      IntPtr hs;
      if (midiOutOpen(out hs, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, 0) == 0) {
        for (int ch = 0; ch < 16; ch++) {
          midiOutShortMsg(hs, (uint)(0xB0 | ch | (123 << 8)));
          midiOutShortMsg(hs, (uint)(0xB0 | ch | (120 << 8)));
        }
        midiOutReset(hs);
        midiOutClose(hs);
      }
      return 0;
    }
    if (args.Length < 2) return 1;
    int program = int.Parse(args[1], CultureInfo.InvariantCulture);
    if (program < 0 || program > 127) program = 0;
    string[] lines = File.ReadAllLines(args[0]);
    IntPtr h;
    // MIDI_MAPPER opens the system default: Microsoft GS Wavetable Synth.
    if (midiOutOpen(out h, 0xFFFFFFFF, IntPtr.Zero, IntPtr.Zero, 0) != 0) return 2;
    // Clear anything still ringing from a previous track before we begin.
    for (int ch = 0; ch < 16; ch++) {
      midiOutShortMsg(h, (uint)(0xB0 | ch | (123 << 8)));
      midiOutShortMsg(h, (uint)(0xB0 | ch | (120 << 8)));
    }
    for (int ch = 0; ch < 16; ch++) {
      midiOutShortMsg(h, (uint)(0xC0 | ch | (program << 8)));
    }
    Stopwatch sw = Stopwatch.StartNew();
    for (int i = 0; i < lines.Length; i++) {
      string[] p = lines[i].Split(' ');
      if (p.Length < 4) continue;
      double ms = double.Parse(p[0], CultureInfo.InvariantCulture);
      int status = int.Parse(p[1], CultureInfo.InvariantCulture);
      int note = int.Parse(p[2], CultureInfo.InvariantCulture);
      int vel = int.Parse(p[3], CultureInfo.InvariantCulture);
      while (sw.Elapsed.TotalMilliseconds < ms) Thread.Sleep(1);
      midiOutShortMsg(h, (uint)(status | (note << 8) | (vel << 16)));
    }
    midiOutReset(h);
    midiOutClose(h);
    return 0;
  }
}
