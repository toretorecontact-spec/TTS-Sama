// sapi4-tts.cs - Microsoft Sam (SAPI4) speech helper for TwitchSamaTTS.
//
// Drives the SAPI4 engine directly through its COM interfaces (same sequence
// as the Microsoft Speech SDK 4.0 samples):
//   1. CoCreateInstance(CLSID_TTSEnumerator) -> ITTSEnumW
//   2. CoCreateInstance(CLSID_MMAudioDest)   -> IAudioMultiMediaDevice, DeviceNumSet(WAVE_MAPPER)
//   3. Enum modes via raw pointers, pick "Sam"
//   4. Enum.Select(modeID, &ITTSCentral, audioObj)
//   5. Central->TextData(...) with NATIVE fake notify sinks
//
// IMPORTANT: managed CCW sinks crash (0xC0000005 inside clr.dll) when the
// engine calls them back. So the notify sinks are hand-built native COM
// objects: x86 machine-code thunks in VirtualAlloc'd RWX memory. Completion
// is detected by polling flags that the thunks write.
//
// Protocol (stdin, one JSON object per line):
//   {"op":"list"}                    -> {"op":"modes",...}
//   {"op":"speak","text":"...","rate":1.0,"volume":1.0}
//                                    -> {"op":"ready"} when playback finished
//   {"op":"stop"}                    -> {"op":"stopped"}
//   {"op":"quit"}                    -> exits
// Startup line: {"op":"modes","modes":[...],"selected":"<modeID>"} or {"op":"error",...}
//
// Must be built 32-bit:
//   C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /platform:x86
//     /out:sapi4-tts.exe /r:System.Web.Extensions.dll sapi4-tts.cs

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// ---------------------------------------------------------------- GUIDs
internal static class Sapi4Guids {
  public static readonly Guid CLSID_TTSEnumerator     = new Guid("D67C0280-C743-11cd-80E5-00AA003E4B50");
  public static readonly Guid CLSID_MicrosoftEngine   = new Guid("E0725551-286F-11D0-8E73-00A0C9083363");
  public static readonly Guid CLSID_TruVoiceEngine    = new Guid("CA141FD0-AC7F-11D1-97A3-0060082730FF");
  public static readonly Guid CLSID_MMAudioDest       = new Guid("CB96B400-C743-11cd-80E5-00AA003E4B50");
  public static readonly Guid CLSID_AudioDestFile     = new Guid("D4623720-E4B9-11CF-8D56-00A0C9034A7E");
  public static readonly Guid IID_IAudioMultiMediaDevice = new Guid("B68AD320-C743-11cd-80E5-00AA003E4B50");
  public static readonly Guid IID_IAudioFile          = new Guid("FD7C2320-3D6D-11B9-C000-FED6CBA3B1A9");
  public static readonly Guid IID_ITTSEnumW           = new Guid("6B837B20-4A47-101B-931A-00AA0047BA4F");
  public static readonly Guid IID_ITTSCentralW        = new Guid("28016060-4A47-101B-931A-00AA0047BA4F");
  public static readonly Guid IID_ITTSAttributesW     = new Guid("1287A280-4A47-101B-931A-00AA0047BA4F");
  public static readonly Guid IID_ITTSNotifySinkW     = new Guid("C0FA8F40-4A46-101B-931A-00AA0047BA4F");
  public static readonly Guid IID_ITTSBufNotifySink   = new Guid("E4963D40-C743-11cd-80E5-00AA003E4B50");
  public static readonly Guid SamModeId               = new Guid("C5C35D60-DA44-11d1-B1F1-0000F803E456");
  // Authentic Bonzi Buddy voice, read from Bonzi.acs: L&H TruVoice "Adult
  // Male #2, American English (TruVoice)", speaker Sidney.
  public static readonly Guid BonziModeId             = new Guid("CA141FD0-AC7F-11D1-97A3-006008273001");
  public const uint BONZI_PITCH = 140;
  public const uint BONZI_SPEED = 157;
}

// ------------------------------------------------ direct-COM engine loader
// SAPI 4 normally finds engines through HKLM registry entries. Loading the
// bundled DLLs by hand and calling DllGetClassObject avoids all registration,
// so a plain extracted folder works on a fresh Windows PC with no admin.
internal static class PortableCom {
  private static readonly List<IntPtr> libs = new List<IntPtr>();
  private static string dir;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr LoadLibrary(string path);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
  private static extern IntPtr GetProcAddress(IntPtr h, string name);
  [DllImport("ole32.dll")]
  private static extern int CoInitialize(IntPtr reserved);

  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  private delegate int DllGetClassObject(ref Guid clsid, ref Guid iid, out IntPtr ppv);

  [ComImport, Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IClassFactory {
    [PreserveSig] int CreateInstance(IntPtr outer, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int LockServer([MarshalAs(UnmanagedType.Bool)] bool fLock);
  }

  public static string Dir {
    get {
      if (dir != null) return dir;
      string d = Environment.GetEnvironmentVariable("TS_SAPI4_DIR");
      if (string.IsNullOrEmpty(d)) d = AppDomain.CurrentDomain.BaseDirectory;
      dir = d;
      return dir;
    }
  }

  public static bool Available {
    get {
      string[] needed = new string[] { "SPEECH.DLL", "MSTTSSYN.dll", "tv_enua.dll", "msvcp50.dll", "msvcirt.dll" };
      foreach (string f in needed) {
        if (!File.Exists(Path.Combine(Dir, f))) return false;
      }
      return true;
    }
  }

  private static IntPtr Load(string name) {
    string p = Path.Combine(Dir, name);
    IntPtr h = LoadLibrary(p);
    if (h == IntPtr.Zero) throw new Exception("LoadLibrary " + name + " failed: " + Marshal.GetLastWin32Error());
    libs.Add(h);
    return h;
  }

  public static IntPtr Create(string dllName, Guid clsid, Guid iid) {
    CoInitialize(IntPtr.Zero); // S_FALSE is fine when the thread is already initialised
    if (dllName == "tv_enua.dll") {
      // TruVoice's C++ runtime must be loaded from the same folder first.
      Load("msvcp50.dll");
      Load("msvcirt.dll");
    }
    IntPtr h = Load(dllName);
    IntPtr proc = GetProcAddress(h, "DllGetClassObject");
    if (proc == IntPtr.Zero) throw new Exception(dllName + " has no DllGetClassObject");
    DllGetClassObject get = (DllGetClassObject)Marshal.GetDelegateForFunctionPointer(proc, typeof(DllGetClassObject));
    Guid iidFactory = new Guid("00000001-0000-0000-C000-000000000046");
    IntPtr factoryPtr;
    int hr = get(ref clsid, ref iidFactory, out factoryPtr);
    if (hr != 0 || factoryPtr == IntPtr.Zero) throw new Exception("DllGetClassObject " + dllName + ": 0x" + hr.ToString("X8"));
    IClassFactory factory = (IClassFactory)Marshal.GetObjectForIUnknown(factoryPtr);
    IntPtr obj;
    hr = factory.CreateInstance(IntPtr.Zero, ref iid, out obj);
    Marshal.ReleaseComObject(factory);
    if (hr != 0 || obj == IntPtr.Zero) throw new Exception("CreateInstance " + dllName + ": 0x" + hr.ToString("X8"));
    return obj;
  }
}

// ---------------------------------------------------------------- structs
[StructLayout(LayoutKind.Sequential)]
internal struct SDATA { public IntPtr pData; public uint dwSize; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct LANGUAGEW {
  public ushort LanguageID;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szDialect;
}

internal static class Sapi4Consts {
  public const int NAMELEN = 262;
  public const uint WAVE_MAPPER = 0xFFFFFFFF;
  public const uint CHARSET_TEXT = 0;
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct TTSMODEINFOW {
  public Guid gEngineID;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = Sapi4Consts.NAMELEN)] public string szMfgName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = Sapi4Consts.NAMELEN)] public string szProductName;
  public Guid gModeID;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = Sapi4Consts.NAMELEN)] public string szModeName;
  public LANGUAGEW language;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = Sapi4Consts.NAMELEN)] public string szSpeaker;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = Sapi4Consts.NAMELEN)] public string szStyle;
  public ushort wGender;
  public ushort wAge;
  public uint dwFeatures;
  public uint dwInterfaces;
  public uint dwEngineFeatures;
}

// ---------------------------------------------------------------- COM interfaces (call direction: us -> engine)
[ComImport, Guid("6B837B20-4A47-101B-931A-00AA0047BA4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITTSEnumWPtr {
  [PreserveSig] int Next(uint celt, IntPtr rgelt, IntPtr pceltFetched);
  [PreserveSig] int Skip(uint celt);
  [PreserveSig] int Reset();
  [PreserveSig] int Clone(out ITTSEnumWPtr ppEnum);
  [PreserveSig] int Select([In] Guid gModeID, out IntPtr ppITTSCentral, [MarshalAs(UnmanagedType.IUnknown)] object pUnkAudio);
}

[ComImport, Guid("28016060-4A47-101B-931A-00AA0047BA4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITTSCentralW {
  [PreserveSig] int Inject([MarshalAs(UnmanagedType.LPWStr)] string pszTag);
  [PreserveSig] int ModeGet(IntPtr pModeInfo);
  [PreserveSig] int Phoneme(uint eCharacterSet, uint dwFlags, SDATA dText, ref SDATA pdPhoneme);
  [PreserveSig] int PosnGet(out ulong pqwTimeStamp);
  [PreserveSig] int TextData(uint eCharacterSet, uint dwFlags, SDATA dText, IntPtr pNotifyInterface, [In] Guid riid);
  [PreserveSig] int ToFileTime(out ulong pqwTimeStamp, IntPtr pFT);
  [PreserveSig] int AudioPause();
  [PreserveSig] int AudioResume();
  [PreserveSig] int AudioReset();
  [PreserveSig] int Register(IntPtr pNotifyInterface, [In] Guid riid, out uint pdwKey);
  [PreserveSig] int UnRegister(uint dwKey);
}

[ComImport, Guid("1287A280-4A47-101B-931A-00AA0047BA4F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITTSAttributesW {
  [PreserveSig] int PitchGet(out ushort pwPitch);
  [PreserveSig] int PitchSet(ushort wPitch);
  [PreserveSig] int RealTimeGet(out uint pdwRealTime);
  [PreserveSig] int RealTimeSet(uint dwRealTime);
  [PreserveSig] int SpeedGet(out uint pdwSpeed);
  [PreserveSig] int SpeedSet(uint dwSpeed);
  [PreserveSig] int VolumeGet(out uint pdwVolume);
  [PreserveSig] int VolumeSet(uint dwVolume);
}

[ComImport, Guid("B68AD320-C743-11cd-80E5-00AA003E4B50"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioMultiMediaDevice {
  [PreserveSig] int CustomMessage(uint uMsg, SDATA dData);
  [PreserveSig] int DeviceNumGet(out uint pdwDeviceNum);
  [PreserveSig] int DeviceNumSet(uint dwDeviceNum);
}

// File audio destination. L&H TruVoice refuses CLSID_MMAudioDest with
// AUDERR_WAVEFORMATNOTSUPPORTED (0x80040202), but works through this path -
// the same one tetyys.com uses. Synthesis goes to a WAV as fast as possible,
// then we play that file locally.
[ComImport, Guid("FD7C2320-3D6D-11B9-C000-FED6CBA3B1A9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioFile {
  [PreserveSig] int Register(IntPtr pSink);
  [PreserveSig] int Set([MarshalAs(UnmanagedType.LPWStr)] string pszFile, uint dwID);
  [PreserveSig] int Add([MarshalAs(UnmanagedType.LPWStr)] string pszFile, uint dwID);
  [PreserveSig] int Flush();
  [PreserveSig] int RealTimeSet(ushort wTime);
  [PreserveSig] int RealTimeGet(out ushort pwTime);
}

// ------------------------------------------------ native fake COM notify sinks
// Engine->us callbacks. Hand-built x86 stdcall thunks; flags written to a
// dedicated area at Region+8192 (never overlaps code).
internal static class NativeSinks {
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAlloc(IntPtr addr, UIntPtr size, uint type, uint protect);
  const uint MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, PAGE_EXECUTE_READWRITE = 0x40;

  // flag offsets (relative to Region+8192): 0=TextDataDone, 4=AudioStart, 8=AudioStop, 12=TextDataStarted
  public static IntPtr Region;
  public static IntPtr ModeObj, BufObj;
  public static uint ModeKey;

  public static void Init() {
    Region = VirtualAlloc(IntPtr.Zero, (UIntPtr)16384, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (Region == IntPtr.Zero) throw new Exception("VirtualAlloc failed");
    // ITTSNotifySinkW: QI, AddRef, Release, AttribChanged(8), AudioStart(12), AudioStop(12), Visual(24)
    ModeObj = BuildSink(Region, 0, 0xC0FA8F40u, new uint[] { 8, 12, 12, 24 }, true);
    // ITTSBufNotifySink: QI, AddRef, Release, TextDataDone(16), TextDataStarted(12), BookMark(16), WordPosition(16)
    BufObj = BuildSink(Region, 4096, 0xE4963D40u, new uint[] { 16, 12, 16, 16 }, false);
    ClearFlags();
  }

  static byte[] FlagThunk(IntPtr flagAddr, uint retBytes) {
    var c = new List<byte>();
    c.AddRange(new byte[] { 0xC7, 0x05 }); c.AddRange(BitConverter.GetBytes(flagAddr.ToInt32()));
    c.AddRange(BitConverter.GetBytes(1u));
    c.AddRange(new byte[] { 0x33, 0xC0 });
    c.AddRange(new byte[] { 0xC2 }); c.AddRange(BitConverter.GetBytes((ushort)retBytes));
    return c.ToArray();
  }

  static byte[] S_OK_Thunk(uint retBytes) {
    var c = new List<byte>();
    c.AddRange(new byte[] { 0x33, 0xC0 });
    c.AddRange(new byte[] { 0xC2 }); c.AddRange(BitConverter.GetBytes((ushort)retBytes));
    return c.ToArray();
  }

  static byte[] AddRef_Thunk() { return new byte[] { 0xB8, 0x01, 0x00, 0x00, 0x00, 0xC2, 0x04, 0x00 }; }

  // QI: accept iid whose first dword == iidMatch, or all-zero iid (IUnknown). stdcall ret 12.
  static byte[] QI_Thunk(uint iidMatch) {
    var c = new List<byte>();
    c.AddRange(new byte[] { 0x8B, 0x44, 0x24, 0x08 });              // mov eax,[esp+8]  (riid)
    c.AddRange(new byte[] { 0x81, 0x38 }); c.AddRange(BitConverter.GetBytes(iidMatch)); // cmp dword [eax], iidMatch
    c.AddRange(new byte[] { 0x74, 0x0B });                          // je accept
    c.AddRange(new byte[] { 0x83, 0x38, 0x00 });                    // cmp dword [eax],0
    c.AddRange(new byte[] { 0x75, 0x15 });                          // jne fail
    c.AddRange(new byte[] { 0x83, 0x78, 0x04, 0x00 });              // cmp dword [eax+4],0
    c.AddRange(new byte[] { 0x75, 0x0F });                          // jne fail
    // accept:
    c.AddRange(new byte[] { 0x8B, 0x54, 0x24, 0x0C });              // mov edx,[esp+12] (ppv)
    c.AddRange(new byte[] { 0x8B, 0x44, 0x24, 0x04 });              // mov eax,[esp+4]  (this)
    c.AddRange(new byte[] { 0x89, 0x02 });                          // mov [edx],eax
    c.AddRange(new byte[] { 0x33, 0xC0 });                          // xor eax,eax
    c.AddRange(new byte[] { 0xC2, 0x0C, 0x00 });                    // ret 12
    // fail:
    c.AddRange(new byte[] { 0xB8, 0x02, 0x40, 0x00, 0x80 });        // mov eax,0x80004002
    c.AddRange(new byte[] { 0xC2, 0x0C, 0x00 });                    // ret 12
    return c.ToArray();
  }

  static IntPtr BuildSink(IntPtr basePage, int pageOff, uint iidMatch, uint[] retSizes, bool isModeSink) {
    IntPtr codeBase = (IntPtr)(basePage.ToInt64() + pageOff);
    var codes = new List<byte[]>();
    codes.Add(QI_Thunk(iidMatch));
    codes.Add(AddRef_Thunk());
    codes.Add(AddRef_Thunk());
    if (isModeSink) {
      codes.Add(S_OK_Thunk(retSizes[0]));                                        // AttribChanged
      codes.Add(FlagThunk((IntPtr)(basePage.ToInt64() + 8192 + 4), retSizes[1])); // AudioStart
      codes.Add(FlagThunk((IntPtr)(basePage.ToInt64() + 8192 + 8), retSizes[2])); // AudioStop
      codes.Add(S_OK_Thunk(retSizes[3]));                                        // Visual
    } else {
      codes.Add(FlagThunk((IntPtr)(basePage.ToInt64() + 8192 + 0), retSizes[0]));  // TextDataDone
      codes.Add(FlagThunk((IntPtr)(basePage.ToInt64() + 8192 + 12), retSizes[1])); // TextDataStarted
      codes.Add(S_OK_Thunk(retSizes[2]));                                         // BookMark
      codes.Add(S_OK_Thunk(retSizes[3]));                                         // WordPosition
    }
    var addresses = new List<IntPtr>();
    int pos = 0;
    foreach (byte[] code in codes) {
      IntPtr at = (IntPtr)(codeBase.ToInt64() + pos);
      for (int k = 0; k < code.Length; k++) Marshal.WriteByte((IntPtr)(codeBase.ToInt64() + pos + k), code[k]);
      addresses.Add(at);
      pos += code.Length;
      while (pos % 4 != 0) { Marshal.WriteByte((IntPtr)(codeBase.ToInt64() + pos), 0x90); pos++; }
    }
    IntPtr vtable = (IntPtr)(codeBase.ToInt64() + pos);
    for (int i = 0; i < addresses.Count; i++)
      Marshal.WriteIntPtr((IntPtr)(vtable.ToInt64() + i * IntPtr.Size), addresses[i]);
    IntPtr obj = (IntPtr)(vtable.ToInt64() + addresses.Count * IntPtr.Size);
    Marshal.WriteIntPtr(obj, vtable);
    return obj;
  }

  public static uint Flag(int off) { return (uint)Marshal.ReadInt32((IntPtr)(Region.ToInt64() + 8192 + off)); }
  public static void ClearFlags() {
    for (int i = 0; i < 16; i += 4) Marshal.WriteInt32((IntPtr)(Region.ToInt64() + 8192 + i), 0);
  }
}

// ------------------------------------------------ message pump
[StructLayout(LayoutKind.Sequential)]
internal struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

internal static class Pump {
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);
  public const uint PM_REMOVE = 1;

  // Pump messages until the TextDataDone flag is set. Returns false on timeout.
  public static bool UntilDone(int timeoutMs) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    MSG m;
    while (sw.ElapsedMilliseconds < timeoutMs) {
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, PM_REMOVE)) {
        TranslateMessage(ref m);
        DispatchMessage(ref m);
      }
      if (NativeSinks.Flag(0) != 0) return true;
      Thread.Sleep(5);
    }
    return false;
  }

  // Pump briefly (used after AudioReset to let the engine unwind).
  public static void ForMs(int ms) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    MSG m;
    while (sw.ElapsedMilliseconds < ms) {
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, PM_REMOVE)) {
        TranslateMessage(ref m);
        DispatchMessage(ref m);
      }
      Thread.Sleep(5);
    }
  }
}

// ---------------------------------------------------------------- engine wrapper
internal sealed class Sapi4Engine {
  private ITTSEnumWPtr enumMs;
  private ITTSEnumWPtr enumTru;
  private bool portable;
  private object audioObj;
  private IAudioFile audioFile;
  private bool fileDestination;
  private string wavPath;
  private SoundPlayer player;
  private ITTSCentralW centralW;
  private ITTSAttributesW attrsW;
  private uint defaultSpeed = 150, defaultVolume = 0xFFFFFFFF;
  private ushort defaultPitch = 100;
  private int speedBase = -1; // >0 forces an absolute speed instead of defaultSpeed * rate
  private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 1 << 26 };

  public List<Dictionary<string, object>> Modes { get; private set; }
  public string SelectedModeId { get; private set; }
  public string SelectedModeName { get; private set; }
  public int DefaultPitch { get { return (int)defaultPitch; } }
  public int SpeedBase { get { return speedBase; } set { speedBase = value; } }

  private static void CollectModes(ITTSEnumWPtr e, List<TTSMODEINFOW> list) {
    if (e == null) return;
    e.Reset();
    int size = Marshal.SizeOf(typeof(TTSMODEINFOW));
    IntPtr buf = Marshal.AllocHGlobal(size);
    IntPtr fetched = Marshal.AllocHGlobal(4);
    try {
      for (;;) {
        Marshal.WriteInt32(fetched, 0);
        int hr = e.Next(1, buf, fetched);
        if (hr != 0) break;
        if (Marshal.ReadInt32(fetched) == 0) break;
        list.Add((TTSMODEINFOW)Marshal.PtrToStructure(buf, typeof(TTSMODEINFOW)));
        if (list.Count > 200) break;
      }
    } finally {
      Marshal.FreeHGlobal(buf);
      Marshal.FreeHGlobal(fetched);
    }
  }

  public void Init() {
    NativeSinks.Init();

    // audio destination (real-time for normal voices, file for TruVoice)
    EnsureAudio(false);

    // Enumerate modes. When the bundled DLLs are present we load both engines
    // directly, which needs no registry entries and no administrator rights.
    portable = PortableCom.Available;
    var list = new List<TTSMODEINFOW>();
    if (portable) {
      IntPtr msPtr = PortableCom.Create("MSTTSSYN.dll", Sapi4Guids.CLSID_MicrosoftEngine, Sapi4Guids.IID_ITTSEnumW);
      IntPtr tvPtr = PortableCom.Create("tv_enua.dll", Sapi4Guids.CLSID_TruVoiceEngine, Sapi4Guids.IID_ITTSEnumW);
      enumMs = (ITTSEnumWPtr)Marshal.GetObjectForIUnknown(msPtr);
      enumTru = (ITTSEnumWPtr)Marshal.GetObjectForIUnknown(tvPtr);
      CollectModes(enumMs, list);
      CollectModes(enumTru, list);
    } else {
      var speech = Activator.CreateInstance(Type.GetTypeFromCLSID(Sapi4Guids.CLSID_TTSEnumerator));
      enumMs = (ITTSEnumWPtr)speech;
      CollectModes(enumMs, list);
    }
    if (list.Count == 0) throw new Exception("no SAPI4 modes found");

    Modes = new List<Dictionary<string, object>>();
    foreach (var m in list) {
      // The "(for Telephone)" modes fail to select (AUDERR_WAVEDEVICEBUSY
      // 0x80040203) on this system, so don't offer them at all.
      string modeName = Clean(m.szModeName);
      if (!string.IsNullOrEmpty(modeName) &&
          modeName.IndexOf("for Telephone", StringComparison.OrdinalIgnoreCase) >= 0) continue;
      var d = new Dictionary<string, object>();
      d["modeId"] = m.gModeID.ToString("B");
      d["modeName"] = Clean(m.szModeName);
      d["productName"] = Clean(m.szProductName);
      d["mfg"] = Clean(m.szMfgName);
      d["speaker"] = Clean(m.szSpeaker);
      d["lang"] = m.language.LanguageID;
      Modes.Add(d);
    }

    // pick Sam mode
    TTSMODEINFOW sel = default(TTSMODEINFOW);
    bool found = false;
    foreach (var m in list) {
      string modeName = m.szModeName == null ? "" : m.szModeName.TrimEnd('\0');
      string speaker = m.szSpeaker == null ? "" : m.szSpeaker.TrimEnd('\0');
      if (modeName.Equals("Sam", StringComparison.OrdinalIgnoreCase) || speaker.Equals("Sam", StringComparison.OrdinalIgnoreCase)) { sel = m; found = true; break; }
    }
    if (!found) {
      foreach (var m in list) {
        string modeName = m.szModeName == null ? "" : m.szModeName.TrimEnd('\0');
        if (modeName.IndexOf("sam", StringComparison.OrdinalIgnoreCase) >= 0) { sel = m; found = true; break; }
      }
    }
    if (!found) sel = list[0]; // fall back to first mode

    Activate(sel.gModeID, sel.szModeName);
  }

  private static string NewWavPath() {
    return Path.Combine(Path.GetTempPath(), "ts-sapi4-" + Guid.NewGuid().ToString("N") + ".wav");
  }

  // TruVoice modes only work with CLSID_AudioDestFile. Everything else keeps
  // the fast real-time MMAudioDest path. Recreate the object on every switch:
  // an audio object is bound to the engine that Select() gave it.
  private void EnsureAudio(bool forFile) {
    if (audioObj != null && fileDestination == forFile) return;
    if (audioObj != null) {
      try { Marshal.ReleaseComObject(audioObj); } catch { }
      audioObj = null; audioFile = null;
      GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
    }
    if (forFile) {
      Guid cls = Sapi4Guids.CLSID_AudioDestFile, iid = Sapi4Guids.IID_IAudioFile;
      object obj;
      if (portable) {
        obj = Marshal.GetObjectForIUnknown(PortableCom.Create("SPEECH.DLL", cls, iid));
      } else {
        int hrCreate = CoCreateInstance(ref cls, IntPtr.Zero, 1, ref iid, out obj);
        if (hrCreate != 0) throw new Exception("create AudioDestFile: 0x" + hrCreate.ToString("X8"));
      }
      audioObj = obj;
      audioFile = (IAudioFile)obj;
      wavPath = NewWavPath();
      int hr = audioFile.Set(wavPath, 1);
      if (hr != 0) throw new Exception("AudioFile.Set: 0x" + hr.ToString("X8"));
      hr = audioFile.RealTimeSet(0xFFFF); // TTSATTR_MAXREALTIME
      if (hr != 0) throw new Exception("AudioFile.RealTimeSet: 0x" + hr.ToString("X8"));
    } else {
      Guid cls = Sapi4Guids.CLSID_MMAudioDest, iid = Sapi4Guids.IID_IAudioMultiMediaDevice;
      object obj;
      if (portable) {
        obj = Marshal.GetObjectForIUnknown(PortableCom.Create("SPEECH.DLL", cls, iid));
      } else {
        int hrCreate = CoCreateInstance(ref cls, IntPtr.Zero, 1, ref iid, out obj);
        if (hrCreate != 0) throw new Exception("create MMAudioDest: 0x" + hrCreate.ToString("X8"));
      }
      var amm = (IAudioMultiMediaDevice)obj;
      int hr = amm.DeviceNumSet(Sapi4Consts.WAVE_MAPPER);
      if (hr != 0) throw new Exception("DeviceNumSet: 0x" + hr.ToString("X8"));
      audioObj = obj;
      wavPath = null;
    }
    fileDestination = forFile;
  }

  private static bool IsTruVoice(Guid modeId) {
    return modeId.ToString("B").StartsWith("{ca141fd0-", StringComparison.OrdinalIgnoreCase);
  }

  // Select a mode and (re)wire attributes + mode sink. Called for initial
  // selection and for {"op":"select"} voice switches.
  public void Activate(Guid modeId, string displayName) {
    speedBase = -1; // a voice switch restores that voice's natural speed
    // Release the previous voice first: it keeps holding the wave device,
    // and a re-Select would fail with AUDERR_WAVEDEVICEBUSY (0x80040203).
    if (centralW != null) {
      try { centralW.AudioReset(); } catch { }
      Pump.ForMs(100);
      try { Marshal.ReleaseComObject(centralW); } catch { }
      centralW = null;
      GC.Collect();
      GC.WaitForPendingFinalizers();
      GC.Collect();
    }
    attrsW = null;
    EnsureAudio(IsTruVoice(modeId));
    ITTSEnumWPtr e = (IsTruVoice(modeId) && enumTru != null) ? enumTru : enumMs;
    e.Reset();
    IntPtr centralPtr;
    int hr = e.Select(modeId, out centralPtr, audioObj);
    if (hr != 0 || centralPtr == IntPtr.Zero)
      throw new Exception("Select(" + displayName + "): 0x" + hr.ToString("X8"));
    centralW = (ITTSCentralW)Marshal.GetObjectForIUnknown(centralPtr);

    SelectedModeId = modeId.ToString("B");
    SelectedModeName = Clean(displayName);

    try { attrsW = (ITTSAttributesW)centralW; } catch { attrsW = null; }
    if (attrsW != null) {
      uint s, v;
      ushort p;
      if (attrsW.SpeedGet(out s) == 0 && s > 0) defaultSpeed = s;
      if (attrsW.VolumeGet(out v) == 0 && v > 0) defaultVolume = v;
      if (attrsW.PitchGet(out p) == 0 && p > 0) defaultPitch = p;
    }

    if (!fileDestination) {
      // File voices are driven by the WAV file, and their callbacks corrupt
      // this helper's hand-built notify thunks - so they get no sinks.
      uint key;
      hr = centralW.Register(NativeSinks.ModeObj, Sapi4Guids.IID_ITTSNotifySinkW, out key);
      if (hr != 0) throw new Exception("Register(modeSink): 0x" + hr.ToString("X8"));
      NativeSinks.ModeKey = key;
    }
  }

  // Switch voice by fuzzy name match against the mode list. Returns true on success.
  public bool SelectByName(string name, out string err) {
    err = null;
    if (string.IsNullOrEmpty(name)) { err = "no name given"; return false; }
    string wanted = name.Trim();
    foreach (var d in Modes) {
      string modeName = d.ContainsKey("modeName") ? (d["modeName"] == null ? "" : d["modeName"].ToString()) : "";
      string speaker = d.ContainsKey("speaker") ? (d["speaker"] == null ? "" : d["speaker"].ToString()) : "";
      if (modeName.Equals(wanted, StringComparison.OrdinalIgnoreCase) || speaker.Equals(wanted, StringComparison.OrdinalIgnoreCase)) {
        Activate(new Guid(((string)d["modeId"]).Trim('{', '}')), modeName);
        return true;
      }
    }
    foreach (var d in Modes) {
      string modeName = d.ContainsKey("modeName") ? (d["modeName"] == null ? "" : d["modeName"].ToString()) : "";
      string speaker = d.ContainsKey("speaker") ? (d["speaker"] == null ? "" : d["speaker"].ToString()) : "";
      if (modeName.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0 ||
          speaker.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) {
        Activate(new Guid(((string)d["modeId"]).Trim('{', '}')), modeName);
        return true;
      }
    }
    err = "no voice mode matching \"" + wanted + "\"";
    return false;
  }

  // Select an exact mode by ID (used by Bonzi Buddy, whose authentic voice is
  // a specific L&H TruVoice mode rather than a fuzzy name match).
  public bool SelectById(Guid id, out string err) {
    err = null;
    foreach (var d in Modes) {
      if (!d.ContainsKey("modeId") || d["modeId"] == null) continue;
      Guid candidate;
      if (!Guid.TryParse(((string)d["modeId"]).Trim('{', '}'), out candidate)) continue;
      if (candidate != id) continue;
      Activate(id, (string)d["modeName"]);
      return true;
    }
    err = "voice mode " + id.ToString("B") + " is not available";
    return false;
  }

  private static string Clean(string s) { return string.IsNullOrEmpty(s) ? s : s.TrimEnd('\0').Trim(); }

  public void SetAttributes(double rate, double volume, int pitch) {
    if (attrsW == null) return;
    if (rate <= 0) rate = 1.0;
    if (volume < 0) volume = 0; if (volume > 1) volume = 1;
    int baseSpeed = speedBase > 0 ? speedBase : (int)defaultSpeed;
    uint target = (uint)Math.Min(uint.MaxValue - 1, Math.Max(1, baseSpeed * rate));
    attrsW.SpeedSet(target);
    attrsW.VolumeSet((uint)Math.Min(uint.MaxValue, Math.Max(0, (double)defaultVolume * volume)));
    if (pitch >= 0 && pitch <= 65535) {
      int hr = attrsW.PitchSet((ushort)pitch);
      if (hr != 0) {
        // Some modes do not expose pitch control - fall back to its default.
        attrsW.PitchSet(defaultPitch);
      }
    } else {
      attrsW.PitchSet(defaultPitch);
    }
  }

  public void Stop() {
    if (player != null) { try { player.Stop(); } catch { } player = null; }
    try { centralW.AudioReset(); } catch { }
    NativeSinks.ClearFlags();
    Pump.ForMs(150);
  }

  // Real-time voices finish when TextDataDone fires. File voices finish when
  // the WAV stops growing (synthesis happens at maximum speed).
  private bool WaitForSynthesis(int timeoutMs) {
    if (!fileDestination) return Pump.UntilDone(timeoutMs);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    long last = -1;
    int stable = 0;
    MSG m;
    while (sw.ElapsedMilliseconds < timeoutMs) {
      while (Pump.PeekMessage(out m, IntPtr.Zero, 0, 0, Pump.PM_REMOVE)) {
        Pump.TranslateMessage(ref m);
        Pump.DispatchMessage(ref m);
      }
      try {
        if (File.Exists(wavPath)) {
          long len = new FileInfo(wavPath).Length;
          if (len > 44 && len == last) {
            if (++stable >= 4 && sw.ElapsedMilliseconds > 200) return true;
          } else {
            stable = 0;
            last = len;
          }
        }
      } catch { }
      Thread.Sleep(25);
    }
    return false;
  }

  // Speak synchronously: returns true when synthesis completed.
  public bool Speak(string text, double rate, double volume) { return Speak(text, rate, volume, -1); }
  public bool Speak(string text, double rate, double volume, int pitch) {
    if (string.IsNullOrEmpty(text)) return true;
    SetAttributes(rate, volume, pitch);
    if (player != null) { try { player.Stop(); } catch { } player = null; }
    if (fileDestination) {
      if (audioFile == null) throw new Exception("audio file destination not ready");
      try { File.Delete(wavPath); } catch { }
      wavPath = NewWavPath();
      int hrSet = audioFile.Set(wavPath, 1);
      if (hrSet != 0) throw new Exception("AudioFile.Set: 0x" + hrSet.ToString("X8"));
    }
    NativeSinks.ClearFlags();
    byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
    IntPtr p = Marshal.AllocHGlobal(bytes.Length);
    bool done;
    try {
      Marshal.Copy(bytes, 0, p, bytes.Length);
      SDATA d; d.pData = p; d.dwSize = (uint)bytes.Length;
      IntPtr sink = fileDestination ? IntPtr.Zero : NativeSinks.BufObj;
      int hr = centralW.TextData(Sapi4Consts.CHARSET_TEXT, 0, d, sink, Sapi4Guids.IID_ITTSBufNotifySink);
      if (hr != 0) throw new Exception("TextData: 0x" + hr.ToString("X8"));
      done = WaitForSynthesis(120000);
      if (fileDestination) {
        int hrFlush = audioFile.Flush();
        if (hrFlush != 0) throw new Exception("AudioFile.Flush: 0x" + hrFlush.ToString("X8"));
        player = new SoundPlayer(wavPath);
        player.Load();
        player.PlaySync();
      }
      return done;
    } finally {
      Marshal.FreeHGlobal(p);
      if (fileDestination && player != null) {
        player = null;
        try { File.Delete(wavPath); } catch { }
      }
      NativeSinks.ClearFlags();
    }
  }

  public string ToJson(object o) { return json.Serialize(o); }

  [DllImport("ole32.dll")]
  private static extern int CoCreateInstance(ref Guid clsid, IntPtr pUnkOuter, uint clsctx, ref Guid iid,
                                             [MarshalAs(UnmanagedType.IUnknown)] out object obj);
}

// ---------------------------------------------------------- funny variants
// Each real voice gets four goofy twins. The effects use each engine's own
// pitch and speed controls, so they stay as fast as the original voices.
internal sealed class FunnyEffect {
  public string Suffix;
  public int Sapi4Pitch;    // 50..200 (100 = normal)
  public int EspeakPitch;   // 0..99  (50 = normal)
  public string SsmlPitch;  // SAPI5 prosody offset
  public double SpeedMul;   // multiplies the current speed slider

  public FunnyEffect(string suffix, int sapi4, int espeak, string ssml, double speed) {
    Suffix = suffix; Sapi4Pitch = sapi4; EspeakPitch = espeak; SsmlPitch = ssml; SpeedMul = speed;
  }
}

// ---------------------------------------------------- extra fast voices
// Windows SAPI5 voices (already installed) plus the bundled eSpeak NG engine.
// eSpeak uses formant synthesis like Sam, so it is just as fast, and hearing
// English chat read by an Italian/Japanese/Klingon voice is very funny.
internal sealed class ExtraVoices {
  // id, friendly label. All of these were verified against the bundled data.
  private static readonly string[][] EspeakVoices = new string[][] {
    new string[] { "en-us-nyc", "New York" },
    new string[] { "en-us", "American" },
    new string[] { "en-us+f3", "American Female" },
    new string[] { "en-us+f4", "American Female 2" },
    new string[] { "en-us+m3", "American Deep Male" },
    new string[] { "en-gb", "British" },
    new string[] { "en-gb+f3", "British Female" },
    new string[] { "en-gb-x-rp", "Posh British" },
    new string[] { "en-gb-scotland", "Scottish" },
    new string[] { "en-gb-x-gbcwmd", "West Midlands" },
    new string[] { "en-gb-x-gbclan", "Lancaster" },
    new string[] { "en-029", "Caribbean English" },
    new string[] { "en", "English Default" },
    new string[] { "en+f3", "English Female" },
    new string[] { "en+m3", "English Deep Male" },
    new string[] { "it", "Italian" },
    new string[] { "es", "Spanish" },
    new string[] { "es-419", "Latin American Spanish" },
    new string[] { "fr-fr", "French" },
    new string[] { "fr-be", "Belgian French" },
    new string[] { "de", "German" },
    new string[] { "ru", "Russian" },
    new string[] { "ja", "Japanese" },
    new string[] { "ko", "Korean" },
    new string[] { "cmn", "Mandarin Chinese" },
    new string[] { "pt-br", "Brazilian Portuguese" },
    new string[] { "pt", "Portuguese" },
    new string[] { "nl", "Dutch" },
    new string[] { "sv", "Swedish" },
    new string[] { "pl", "Polish" },
    new string[] { "tr", "Turkish" },
    new string[] { "ar", "Arabic" },
    new string[] { "he", "Hebrew" },
    new string[] { "hi", "Hindi" },
    new string[] { "id", "Indonesian" },
    new string[] { "vi", "Vietnamese" },
    new string[] { "el", "Greek" },
    new string[] { "hu", "Hungarian" },
    new string[] { "ro", "Romanian" },
    new string[] { "uk", "Ukrainian" },
    new string[] { "fa", "Persian" },
    new string[] { "da", "Danish" },
    new string[] { "fi", "Finnish" },
    new string[] { "is", "Icelandic" },
    new string[] { "nb", "Norwegian" },
    new string[] { "cs", "Czech" },
    new string[] { "sk", "Slovak" },
    new string[] { "sl", "Slovenian" },
    new string[] { "hr", "Croatian" },
    new string[] { "sr", "Serbian" },
    new string[] { "bs", "Bosnian" },
    new string[] { "bg", "Bulgarian" },
    new string[] { "sq", "Albanian" },
    new string[] { "ca", "Catalan" },
    new string[] { "eu", "Basque" },
    new string[] { "ga", "Irish Gaelic" },
    new string[] { "gd", "Scottish Gaelic" },
    new string[] { "cy", "Welsh" },
    new string[] { "mt", "Maltese" },
    new string[] { "af", "Afrikaans" },
    new string[] { "sw", "Swahili" },
    new string[] { "la", "Latin" },
    new string[] { "eo", "Esperanto" },
    new string[] { "jbo", "Lojban" },
    new string[] { "qya", "Quenya (Elvish)" },
    new string[] { "sjn", "Sindarin (Elvish)" },
    new string[] { "piqd", "Klingon" },
    new string[] { "qdb", "Lang Belta" },
    new string[] { "haw", "Hawaiian" },
    new string[] { "mi", "Maori" },
    new string[] { "grc", "Ancient Greek" },
  };

  private static readonly FunnyEffect[] FunnyEffects = new FunnyEffect[] {
    new FunnyEffect("Deep",      55,  12, "-85Hz",  0.60),
    new FunnyEffect("Chipmunk", 195,  92, "+120Hz", 1.50),
    new FunnyEffect("Baby",     180,  82, "+90Hz",  0.85),
    new FunnyEffect("Monster",   50,   0, "-120Hz", 1.20),
  };

  private SpeechSynthesizer s5;
  private Sapi4Engine eng;
  private string espeakExe;
  private Process playing;
  private bool active;
  private int pitchOverride = -1; // -1 = off; otherwise a normalized -100..100 offset (0 = normal pitch)
  private string selectedName = "";
  public List<Dictionary<string, object>> Modes = new List<Dictionary<string, object>>();

  public bool Active { get { return active; } }
  public string SelectedName { get { return selectedName; } }

  public void Init() {
    string exe = Environment.GetEnvironmentVariable("TS_ESPEAK_EXE");
    if (!string.IsNullOrEmpty(exe) && File.Exists(exe)) {
      espeakExe = exe;
      string data = Path.Combine(Path.GetDirectoryName(exe), "espeak-ng-data");
      if (Directory.Exists(data)) Environment.SetEnvironmentVariable("ESPEAK_DATA_PATH", data);
      foreach (string[] v in EspeakVoices) AddMode("eSpeak - " + v[1], "espeak", v[0]);
    }
    try {
      s5 = new SpeechSynthesizer();
      foreach (var vi in s5.GetInstalledVoices()) {
        if (vi == null || !vi.Enabled) continue;
        string name = vi.VoiceInfo.Name;
        if (!string.IsNullOrEmpty(name)) AddMode("Windows - " + name, "sapi5", name);
      }
    } catch { s5 = null; }
  }

  private void AddMode(string display, string provider, string id) {
    var d = new Dictionary<string, object>();
    d["modeName"] = display;
    d["provider"] = provider;
    d["voiceId"] = id;
    Modes.Add(d);
  }

  // Add four goofy twins of every installed voice, including the SAPI4 ones.
  public void AddFunnyVariants(Sapi4Engine engine) {
    eng = engine;
    var bases = new List<Dictionary<string, object>>(Modes);
    if (eng != null) bases.InsertRange(0, eng.Modes);
    foreach (var b in bases) {
      string baseName = b.ContainsKey("modeName") && b["modeName"] != null ? b["modeName"].ToString() : "";
      if (string.IsNullOrEmpty(baseName)) continue;
      string provider = b.ContainsKey("provider") ? b["provider"].ToString() : "sapi4";
      foreach (FunnyEffect fx in FunnyEffects) {
        var d = new Dictionary<string, object>();
        d["modeName"] = baseName + " - " + fx.Suffix;
        d["provider"] = provider;
        if (b.ContainsKey("voiceId")) d["voiceId"] = b["voiceId"];
        if (b.ContainsKey("modeId")) d["modeId"] = b["modeId"];
        d["baseName"] = baseName;
        d["funny"] = true;
        d["pitch"] = fx.Sapi4Pitch;
        d["espeakPitch"] = fx.EspeakPitch;
        d["ssmlPitch"] = fx.SsmlPitch;
        d["speedMul"] = fx.SpeedMul;
        Modes.Add(d);
      }
    }
  }

  // The authentic Bonzi Buddy voice, read straight from Bonzi.acs: L&H
  // TruVoice mode {CA141FD0-...3001} ("Adult Male #2, American English"),
  // pitch 140, speed 157. Added after the funny twins so it stays a
  // standalone browsable voice instead of one of the four generated twins.
  public void AddBonziVoice(Sapi4Engine engine) {
    eng = engine;
    var d = new Dictionary<string, object>();
    d["modeName"] = "Bonzi Buddy";
    d["provider"] = "sapi4";
    d["modeId"] = Sapi4Guids.BonziModeId.ToString("B");
    d["funny"] = true;
    d["pitch"] = (int)Sapi4Guids.BONZI_PITCH;
    d["speed"] = (int)Sapi4Guids.BONZI_SPEED;
    Modes.Add(d);
  }

  private static bool IsFunny(Dictionary<string, object> d) {
    return d.ContainsKey("funny") && d["funny"] != null && (bool)d["funny"];
  }

  private static string EscapeXml(string s) {
    if (string.IsNullOrEmpty(s)) return "";
    return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
            .Replace("\"", "&quot;").Replace("'", "&apos;");
  }

  private Dictionary<string, object> FindSelected() {
    foreach (var d in Modes)
      if (((string)d["modeName"]).Equals(selectedName, StringComparison.OrdinalIgnoreCase)) return d;
    return null;
  }

  public bool SelectByName(string name, out string err) {
    err = null;
    if (string.IsNullOrEmpty(name)) { err = "no name given"; return false; }
    foreach (var d in Modes)
      if (((string)d["modeName"]).Equals(name.Trim(), StringComparison.OrdinalIgnoreCase)) { Activate(d); return true; }
    // A plain name like "Sam" must not fuzzy-match a funny twin such as
    // "Sam - Deep" - only search the twins when one was named explicitly.
    bool wantsFunny = name.IndexOf(" - ") >= 0;
    foreach (var d in Modes) {
      if (!wantsFunny && IsFunny(d)) continue;
      if (((string)d["modeName"]).IndexOf(name.Trim(), StringComparison.OrdinalIgnoreCase) >= 0) { Activate(d); return true; }
    }
    err = "no extra voice matching \"" + name + "\"";
    return false;
  }

  private void Activate(Dictionary<string, object> d) {
    string provider = (string)d["provider"];
    string voiceId = d.ContainsKey("voiceId") && d["voiceId"] != null ? (string)d["voiceId"] : "";
    if (provider == "sapi5" && s5 != null) {
      try { s5.SelectVoice(voiceId); } catch { }
    }
    if (provider == "sapi4" && eng != null) {
      string err;
      if (d.ContainsKey("modeId") && d["modeId"] != null) {
        try { eng.SelectById(new Guid(((string)d["modeId"]).Trim('{', '}')), out err); } catch { }
      } else if (IsFunny(d) && d.ContainsKey("baseName")) {
        try { eng.SelectByName((string)d["baseName"], out err); } catch { }
      }
      // A preset can pin an authentic absolute speed (Bonzi: 157).
      eng.SpeedBase = d.ContainsKey("speed") && d["speed"] != null ? Convert.ToInt32(d["speed"]) : -1;
    }
    selectedName = (string)d["modeName"];
    pitchOverride = -1; // choosing a voice returns it to its normal pitch
    active = true;
  }

  public void Deactivate() { active = false; }

  // "Auto pitch + speed" dice: a normalized pitch offset shared by every engine.
  // -1 clears it; -100..100 where 0 is the voice's normal pitch.
  public void SetPitchOverride(int v) {
    if (v < -100 || v > 100) v = -1;
    pitchOverride = v;
  }
  private static int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

  public void Speak(string text, double rate, double volume) { Speak(text, rate, volume, -1); }

  // msgPitch >= 0 is a one-off pitch for this message only (Auto FX toggle).
  // Otherwise the persistent pitch from the FX dice is used, if any.
  public void Speak(string text, double rate, double volume, int msgPitch) {
    Dictionary<string, object> mode = FindSelected();
    if (mode == null || string.IsNullOrEmpty(text)) return;
    string provider = (string)mode["provider"];
    bool funny = IsFunny(mode);
    int fxPitch = msgPitch >= 0 ? msgPitch : pitchOverride;
    bool fx = fxPitch >= 0;
    double speedMul = funny && mode.ContainsKey("speedMul") && mode["speedMul"] != null
                      ? (double)mode["speedMul"] : 1.0;
    double effRate = rate * speedMul;

    if (provider == "sapi4" && eng != null) {
      int pitch = fx ? Clamp(100 + fxPitch, 50, 200)
                     : (funny ? (int)mode["pitch"] : -1);
      eng.Speak(text, effRate, volume, pitch);
      return;
    }
    if (provider == "sapi5" && s5 != null) {
      int r = (int)Math.Round(Math.Log(Math.Max(0.05, effRate), 2.0) * 10.0);
      if (r < -10) r = -10; if (r > 10) r = 10;
      s5.Rate = r;
      s5.Volume = (int)Math.Round(Math.Max(0.0, Math.Min(1.0, volume)) * 100.0);
      if (funny || fx) {
        string p = fx ? ((fxPitch >= 0 ? "+" : "") + (fxPitch * 2) + "Hz")
                      : (string)mode["ssmlPitch"];
        string ssml = "<speak version=\"1.0\" xml:lang=\"en-US\" xmlns=\"http://www.w3.org/2001/10/Synthesis\">" +
                      "<prosody pitch=\"" + p + "\">" +
                      EscapeXml(text) + "</prosody></speak>";
        s5.SpeakSsml(ssml);
      } else {
        s5.Speak(text);
      }
      return;
    }
    if (provider == "espeak" && !string.IsNullOrEmpty(espeakExe)) {
      int speed = (int)Math.Round(175.0 * Math.Max(0.1, Math.Min(4.0, effRate)));
      int amp = (int)Math.Round(100.0 * Math.Max(0.0, Math.Min(1.0, volume)));
      int pitch = fx ? Clamp(50 + fxPitch, 0, 99)
                     : (funny ? (int)mode["espeakPitch"] : 50);
      string tmp = Path.Combine(Path.GetTempPath(), "ts-espeak-" + Guid.NewGuid().ToString("N") + ".txt");
      try {
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        var psi = new ProcessStartInfo();
        psi.FileName = espeakExe;
        psi.Arguments = "-v " + (string)mode["voiceId"] + " -s " + speed + " -a " + amp +
                        " -p " + pitch + " -f \"" + tmp + "\"";
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        playing = Process.Start(psi);
        playing.WaitForExit();
      } finally {
        playing = null;
        try { File.Delete(tmp); } catch { }
      }
    }
  }

  public void Stop() {
    try { if (s5 != null) s5.SpeakAsyncCancelAll(); } catch { }
    try { if (eng != null) eng.Stop(); } catch { }
    try { if (playing != null && !playing.HasExited) playing.Kill(); } catch { }
  }
}

// ---------------------------------------------------------------- main
internal static class Program {
  private static void Emit(Sapi4Engine eng, Dictionary<string, object> obj) {
    string s = eng != null ? eng.ToJson(obj)
                           : new JavaScriptSerializer { MaxJsonLength = 1 << 26 }.Serialize(obj);
    Console.WriteLine(s);
    Console.Out.Flush();
  }

  private static Dictionary<string, object> BuildModes(Sapi4Engine eng, ExtraVoices extra) {
    var all = new List<Dictionary<string, object>>(eng.Modes);
    all.AddRange(extra.Modes);
    return new Dictionary<string, object> {
      { "op", "modes" },
      { "selected", eng.SelectedModeId },
      { "selectedName", extra.Active ? extra.SelectedName : eng.SelectedModeName },
      { "defaultPitch", eng.DefaultPitch },
      { "modes", all }
    };
  }

  [STAThread]
  private static int Main(string[] args) {
    Sapi4Engine eng = null;
    ExtraVoices extra = new ExtraVoices();
    try {
      eng = new Sapi4Engine();
      eng.Init();
      extra.Init();
      extra.AddFunnyVariants(eng);
      extra.AddBonziVoice(eng);
      // Open with Bonzi Buddy instead of plain Sam, unless the host asks for
      // another voice explicitly.
      string presetErr;
      extra.SelectByName("Bonzi Buddy", out presetErr);
    } catch (Exception ex) {
      Emit(null, new Dictionary<string, object> { { "op", "error" }, { "stage", "init" }, { "message", ex.Message } });
      return 1;
    }

    Emit(eng, BuildModes(eng, extra));

    // CLI convenience: --test "text"
    var argList = new List<string>(args);
    int argIdx = argList.IndexOf("--test");
    if (argIdx >= 0 && argIdx + 1 < argList.Count) {
      try {
        bool ok = true;
        if (extra.Active) extra.Speak(argList[argIdx + 1], 1.0, 1.0);
        else ok = eng.Speak(argList[argIdx + 1], 1.0, 1.0);
        Emit(eng, new Dictionary<string, object> { { "op", "ready" }, { "done", ok } });
        return ok ? 0 : 2;
      } catch (Exception ex) {
        Emit(eng, new Dictionary<string, object> { { "op", "error" }, { "stage", "speak" }, { "message", ex.Message } });
        return 1;
      }
    }
    if (argList.Contains("--list")) return 0;

    // stdin protocol loop
    try {
      Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
    } catch { }
    string line;
    while ((line = Console.ReadLine()) != null) {
      if (line.Trim().Length == 0) continue;
      Dictionary<string, object> cmd;
      try { cmd = new JavaScriptSerializer { MaxJsonLength = 1 << 26 }.Deserialize<Dictionary<string, object>>(line); }
      catch { Emit(eng, new Dictionary<string, object> { { "op", "error" }, { "stage", "parse" }, { "message", "bad JSON" } }); continue; }
      if (cmd == null) continue;
      string op = cmd.ContainsKey("op") ? cmd["op"].ToString() : "";
      try {
        if (op == "quit") return 0;
        else if (op == "stop") {
          if (extra.Active) extra.Stop(); else eng.Stop();
          Emit(eng, new Dictionary<string, object> { { "op", "stopped" } });
        }
        else if (op == "pitch") {
          int v = cmd.ContainsKey("value") && cmd["value"] != null ? Convert.ToInt32(cmd["value"]) : -1;
          extra.SetPitchOverride(v);
          Emit(eng, new Dictionary<string, object> { { "op", "pitch" }, { "value", v } });
        }
        else if (op == "speak") {
          string text = cmd.ContainsKey("text") && cmd["text"] != null ? cmd["text"].ToString() : "";
          double rate = cmd.ContainsKey("rate") && cmd["rate"] != null ? Convert.ToDouble(cmd["rate"], System.Globalization.CultureInfo.InvariantCulture) : 1.0;
          double volume = cmd.ContainsKey("volume") && cmd["volume"] != null ? Convert.ToDouble(cmd["volume"], System.Globalization.CultureInfo.InvariantCulture) : 1.0;
          int pitch = cmd.ContainsKey("pitch") && cmd["pitch"] != null ? Convert.ToInt32(cmd["pitch"]) : -1;
          bool ok = true;
          if (extra.Active) extra.Speak(text, rate, volume, pitch);
          else ok = eng.Speak(text, rate, volume, pitch);
          Emit(eng, new Dictionary<string, object> { { "op", "ready" }, { "done", ok } });
        }
        else if (op == "list") { Emit(eng, BuildModes(eng, extra)); }
        else if (op == "select") {
          string name = cmd.ContainsKey("name") && cmd["name"] != null ? cmd["name"].ToString() : "";
          string err;
          if (name.Trim().Length == 0) {
            // empty name: just report the current selection + available modes
            Emit(eng, BuildModes(eng, extra));
          } else if (extra.SelectByName(name, out err)) {
            Emit(eng, new Dictionary<string, object> {
              { "op", "selected" }, { "modeId", "" }, { "name", extra.SelectedName }
            });
          } else if (eng.SelectByName(name, out err)) {
            extra.Deactivate();
            Emit(eng, new Dictionary<string, object> {
              { "op", "selected" }, { "modeId", eng.SelectedModeId }, { "name", eng.SelectedModeName }
            });
          } else {
            Emit(eng, new Dictionary<string, object> {
              { "op", "error" }, { "stage", "select" },
              { "message", err },
              { "modes", eng.Modes }
            });
          }
        }
        else Emit(eng, new Dictionary<string, object> { { "op", "error" }, { "stage", "op" }, { "message", "unknown op: " + op } });
      } catch (Exception ex) {
        Emit(eng, new Dictionary<string, object> { { "op", "error" }, { "stage", op }, { "message", ex.Message } });
      }
    }
    return 0;
  }
}
