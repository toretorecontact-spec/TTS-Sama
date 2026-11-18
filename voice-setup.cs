// voice-setup.cs - optional voice installer / diagnostic window for TTS-Sama.
//
// Shown automatically when sapi4-tts.exe reports that no speech engines were
// found. It never asks for administrator rights just to open: the two install
// buttons start a separate elevated copy of this same program, so UAC appears
// only when the user explicitly chooses to install something.
//
// C# 5 compatible (compiled with .NET Framework 4 csc.exe, /platform:x86).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class VoiceSetup
{
    private const string GuidMicrosoftEngine = "{E0725551-286F-11d0-8E73-00A0C9083363}";
    private const string GuidMicrosoftLegacy = "{2a46E4C0-4EDA-101B-931A-00AA0047BA4F}";
    private const string GuidTruVoice = "{CA141FD0-AC7F-11D1-97A3-0060082730FF}";
    private const string GuidTtsEnumerator = "{D67C0280-C743-11cd-80E5-00AA003E4B50}";
    private const string GuidMMAudioDest = "{CB96B400-C743-11cd-80E5-00AA003E4B50}";
    private const string GuidAudioDestFile = "{D4623720-E4B9-11CF-8D56-00A0C9034A7E}";

    public static readonly string[] PortableFiles = new string[] {
        "SPEECH.DLL", "MSTTSSYN.dll", "tv_enua.dll",
        "tvenuax.dll", "msvcp50.dll", "msvcirt.dll"
    };

    public static string DataDir
    {
        get
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(local)) local = Path.GetTempPath();
            return Path.Combine(local, "TwitchSam");
        }
    }

    public static string PortableDir
    {
        get
        {
            string env = Environment.GetEnvironmentVariable("TS_SAPI4_DIR");
            if (!string.IsNullOrEmpty(env)) return env;
            return Path.Combine(DataDir, "sapi4");
        }
    }

    public static string MarkerPath
    {
        get { return Path.Combine(DataDir, "voice-setup-result.json"); }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        bool microsoft = args.Any(a => a == "--install-microsoft" || a == "--install-both");
        bool bonzi = args.Any(a => a == "--install-bonzi" || a == "--install-both");

        if (microsoft || bonzi)
        {
            try
            {
                string temp = Path.Combine(Path.GetTempPath(),
                    "TwitchSam-VoiceSetup-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(temp);
                ExtractPayload("EngineBin", temp);

                string portable = Path.Combine(temp, "portable");
                Directory.CreateDirectory(portable);
                ExtractPayload("PortableBin", portable);

                List<string> notes = new List<string>();
                EnsureSapi4Runtime(temp, notes);
                if (microsoft) InstallMicrosoft(portable, notes);
                if (bonzi) InstallBonzi(temp, portable, notes);

                string action = microsoft && bonzi ? "both" : (microsoft ? "microsoft" : "bonzi");
                WriteResult(true, action, string.Join("; ", notes.ToArray()), false);
                return 0;
            }
            catch (Exception ex)
            {
                string action = microsoft && bonzi ? "both" : (microsoft ? "microsoft" : "bonzi");
                WriteResult(false, action, FriendlyError(ex), false);
                return 1;
            }
        }

        string lastError = "";
        foreach (string a in args)
        {
            if (!string.IsNullOrEmpty(a) && !a.StartsWith("--")) lastError = a;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(lastError));
        return 0;
    }

    // ------------------------------------------------------------- payload files
    // The DLL payloads are shipped next to this EXE (and extracted from the
    // main app's SEA assets) rather than embedded as .NET resources. A small
    // unsigned tool with multi-megabyte embedded binary resources looks like a
    // dropper to static AV engines, which caused false positives on the RAR.
    private static string PayloadFileName(string resource)
    {
        return resource == "EngineBin" ? "engine-slim.bin" : "voice-setup-portable.bin";
    }

    private static byte[] ReadPayload(string resource)
    {
        string fileName = PayloadFileName(resource);
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string[] candidates = new string[] {
            Path.Combine(baseDir, fileName),
            Path.Combine(DataDir, fileName),
            Path.Combine(PortableDir, fileName),
            Path.Combine(DataDir, "sapi4", fileName)
        };
        foreach (string p in candidates)
        {
            if (File.Exists(p)) return File.ReadAllBytes(p);
        }

        // Backwards compatibility with older builds that embedded the payload.
        try
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            {
                if (s != null)
                {
                    using (MemoryStream ms = new MemoryStream())
                    {
                        s.CopyTo(ms);
                        return ms.ToArray();
                    }
                }
            }
        }
        catch {}

        throw new FileNotFoundException("Missing voice payload " + fileName + ". Keep it next to VoiceSetup.exe.", fileName);
    }

    // Both payloads use the small TSE1 container:
    //   "TSE1" | int count | (int nameLen, bytes name, int dataLen, bytes data)...
    public static void ExtractPayloadPublic(string resource, string destDir)
    {
        ExtractPayload(resource, destDir);
    }

    private static void ExtractPayload(string resource, string destDir)
    {
        Directory.CreateDirectory(destDir);
        byte[] bin = ReadPayload(resource);
        using (MemoryStream ms = new MemoryStream(bin))
        using (BinaryReader br = new BinaryReader(ms))
        {
            string magic = Encoding.ASCII.GetString(br.ReadBytes(4));
            if (magic != "TSE1") throw new InvalidDataException("Invalid voice payload (" + resource + ").");
            int count = br.ReadInt32();
            for (int i = 0; i < count; i++)
            {
                int nameLen = br.ReadInt32();
                string name = Encoding.UTF8.GetString(br.ReadBytes(nameLen));
                int dataLen = br.ReadInt32();
                byte[] data = br.ReadBytes(dataLen);
                string outPath = Path.Combine(destDir, Path.GetFileName(name));
                File.WriteAllBytes(outPath, data);
            }
        }
    }

    // ------------------------------------------------------------- installing
    // Install by copying the bundled DLLs and writing the small set of COM
    // class keys the speech app actually uses. No regsvr32.exe, rundll32.exe,
    // advpack.dll INF section, legacy spchapi.exe, or dynamic LoadLibrary /
    // GetProcAddress of DllRegisterServer is used: those are common malware
    // patterns and none of them are needed by the bundled DLLs.

    private static void RegisterComClass(string clsid, string dll)
    {
        string subKey = @"CLSID\" + clsid + @"\InprocServer32";
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.ClassesRoot, RegistryView.Registry32))
        using (RegistryKey key = root.CreateSubKey(subKey))
        {
            if (key == null) return;
            key.SetValue("", dll, RegistryValueKind.String);
            key.SetValue("ThreadingModel", "Apartment", RegistryValueKind.String);
        }
    }

    private static void InstallMicrosoft(string portable, List<string> notes)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string root = Path.GetPathRoot(windows);
        if (string.IsNullOrEmpty(root)) root = "C:\\";
        string dest = Path.Combine(root, "SpeechEngines", "TTS");
        Directory.CreateDirectory(dest);

        string src = Path.Combine(portable, "MSTTSSYN.dll");
        if (!File.Exists(src)) throw new FileNotFoundException("MSTTSSYN.dll is missing from the voice payload.", src);

        string dll = Path.Combine(dest, "MSTTSSYN.dll");
        File.Copy(src, dll, true);

        // MSTTSSYN.dll exposes DllGetClassObject, not DllRegisterServer, so the
        // two engine class keys are written directly instead of using regsvr32.
        RegisterComClass(GuidMicrosoftEngine, dll);
        RegisterComClass(GuidMicrosoftLegacy, dll);

        using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Voice\TextToSpeech\Engine"))
        {
            if (key != null)
            {
                key.SetValue("MSTTSSyn", GuidMicrosoftEngine, RegistryValueKind.String);
                key.SetValue("MSTTS", GuidMicrosoftLegacy, RegistryValueKind.String);
            }
        }
        notes.Add("Microsoft Sam / Mary / Mike installed");
    }

    private static void InstallBonzi(string engineTemp, string portable, List<string> notes)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string dest = Path.Combine(windows, "lhsp", "tv");
        Directory.CreateDirectory(dest);

        string[] files = new string[] {
            "tv_enua.dll", "tvenuax.dll", "msvcp50.dll", "msvcirt.dll",
            "tv_enua.hlp", "andmoipa.ttf"
        };
        foreach (string f in files)
        {
            string from = Path.Combine(portable, f);
            if (!File.Exists(from)) from = Path.Combine(engineTemp, f);
            if (File.Exists(from)) File.Copy(from, Path.Combine(dest, f), true);
        }

        string dll = Path.Combine(dest, "tv_enua.dll");
        string ax = Path.Combine(dest, "tvenuax.dll");
        if (!File.Exists(dll) || !File.Exists(ax))
            throw new InvalidOperationException("The Bonzi Buddy voice files could not be installed.");

        // The speech app creates this engine class directly from tv_enua.dll.
        // Write the InprocServer32 key ourselves instead of loading the DLL and
        // calling DllRegisterServer dynamically, which looks like a dropper.
        RegisterComClass(GuidTruVoice, dll);

        using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Voice\TextToSpeech\Engine"))
        {
            if (key != null) key.SetValue("TruVoiceAmEnglish", GuidTruVoice, RegistryValueKind.String);
        }
        notes.Add("Bonzi Buddy / L&H TruVoice installed");
    }

    private static void EnsureSapi4Runtime(string engineTemp, List<string> notes)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string speechDir = Path.Combine(windows, "speech");
        Directory.CreateDirectory(speechDir);

        using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\SpeechAPI"))
        {
            if (key != null) key.SetValue("InstallDir", speechDir, RegistryValueKind.String);
        }

        string[] files = new string[] {
            "SPEECH.DLL", "SPCHTEL.DLL", "XLISTEN.DLL", "XTEL.DLL",
            "XVOICE.DLL", "VDICT.DLL", "VTEXT.DLL", "VCMSHL.DLL",
            "XCOMMAND.DLL", "WRAPSAPI.DLL", "MSVCRT.DLL"
        };
        foreach (string f in files)
        {
            string from = Path.Combine(engineTemp, f);
            if (File.Exists(from)) File.Copy(from, Path.Combine(speechDir, f), true);
        }

        if (!File.Exists(Path.Combine(speechDir, "speech.dll")))
            throw new InvalidOperationException("The SAPI 4 runtime files could not be installed.");

        // Register only the SAPI 4 classes the speech helper enumerates or uses.
        string speechDll = Path.Combine(speechDir, "SPEECH.DLL");
        RegisterComClass(GuidTtsEnumerator, speechDll);
        RegisterComClass(GuidMMAudioDest, speechDll);
        RegisterComClass(GuidAudioDestFile, speechDll);

        notes.Add("SAPI 4 runtime ready");
    }

    // ------------------------------------------------------------- result marker
    private static string Json(string s)
    {
        if (s == null) return "";
        return s.Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n");
    }

    private static void WriteResult(bool ok, string action, string message, bool retry)
    {
        Directory.CreateDirectory(DataDir);
        string json = "{\"ok\":" + (ok ? "true" : "false") +
                      ",\"retry\":" + (retry ? "true" : "false") +
                      ",\"action\":\"" + Json(action) + "\"" +
                      ",\"message\":\"" + Json(message) + "\"" +
                      ",\"ts\":" + DateTime.UtcNow.Ticks + "}";
        File.WriteAllText(MarkerPath, json, new UTF8Encoding(false));
    }

    internal class Result
    {
        public bool Ok;
        public bool Retry;
        public long Ts;
        public string Action = "";
        public string Message = "";
    }

    private static Result ReadResult()
    {
        try
        {
            string text = File.ReadAllText(MarkerPath, Encoding.UTF8);
            Result r = new Result();
            r.Ok = text.Contains("\"ok\":true");
            r.Retry = text.Contains("\"retry\":true");
            r.Ts = BetweenNumber(text, "\"ts\":");
            r.Action = Between(text, "\"action\":\"", "\"");
            r.Message = Between(text, "\"message\":\"", "\"");
            return r;
        }
        catch
        {
            return null;
        }
    }

    private static string Between(string text, string start, string end)
    {
        int a = text.IndexOf(start, StringComparison.Ordinal);
        if (a < 0) return "";
        a += start.Length;
        int b = text.IndexOf(end, a);
        if (b < 0) b = text.Length;
        return text.Substring(a, b - a).Replace("\\\"", "\"").Replace("\\n", "\n").Replace("\\r", "");
    }

    private static long BetweenNumber(string text, string start)
    {
        int a = text.IndexOf(start, StringComparison.Ordinal);
        if (a < 0) return 0;
        a += start.Length;
        int b = a;
        while (b < text.Length && text[b] >= '0' && text[b] <= '9') b++;
        long n;
        if (b == a || !long.TryParse(text.Substring(a, b - a), out n)) return 0;
        return n;
    }

    private static string FriendlyError(Exception ex)
    {
        if (ex is UnauthorizedAccessException) return "Windows denied access. The install buttons need administrator rights.";
        if (ex is SecurityException) return "Windows blocked the install. Allow the UAC prompt and try again.";
        return ex.Message;
    }
}

// ------------------------------------------------------------------- UI form
internal class SetupForm : Form
{
    private readonly string lastError;
    private TextBox log;
    private Button repairButton;

    public SetupForm(string lastError)
    {
        this.lastError = lastError;
        Text = "TTS-Sama - Voice Setup";
        Size = new Size(660, 600);
        MinimumSize = new Size(560, 500);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(28, 28, 32);
        ForeColor = Color.Gainsboro;
        Font = new Font("Segoe UI", 9F);

        Panel top = new Panel();
        top.Dock = DockStyle.Top;
        top.Height = 236;
        Controls.Add(top);

        Label title = new Label();
        title.Text = "No speech voices were found";
        title.Font = new Font("Segoe UI", 15F, FontStyle.Bold);
        title.ForeColor = Color.White;
        title.Location = new Point(14, 10);
        title.Size = new Size(610, 30);
        title.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        top.Controls.Add(title);

        Label intro = new Label();
        intro.Text =
            "The portable voice files could not load on this PC. Choose what you want to install.\n" +
            "Nothing is installed unless you click a button. Install buttons ask for administrator rights.";
        intro.Location = new Point(14, 45);
        intro.Size = new Size(610, 48);
        intro.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        intro.ForeColor = Color.FromArgb(190, 190, 198);
        top.Controls.Add(intro);

        FlowLayoutPanel buttons = new FlowLayoutPanel();
        buttons.Location = new Point(10, 100);
        buttons.Size = new Size(618, 122);
        buttons.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        buttons.WrapContents = true;
        buttons.AutoScroll = true;
        buttons.BackColor = Color.FromArgb(28, 28, 32);
        top.Controls.Add(buttons);

        buttons.Controls.Add(MakeButton("Click here to install\nthe Microsoft voices", 210, 48,
            "install-microsoft", delegate { RunElevated("Microsoft voices", "--install-microsoft"); }));
        buttons.Controls.Add(MakeButton("Click here to install\nthe Bonzi Buddy voice", 210, 48,
            "install-bonzi", delegate { RunElevated("Bonzi Buddy voice", "--install-bonzi"); }));
        buttons.Controls.Add(MakeButton("Install both", 120, 48,
            "install-both", delegate { RunElevated("both voice packs", "--install-both"); }));
        repairButton = MakeButton("Repair portable files\n(no admin)", 170, 48,
            "repair", RepairPortable);
        buttons.Controls.Add(repairButton);
        buttons.Controls.Add(MakeButton("Retry speech engine", 150, 48,
            "retry", RetryEngine));

        log = new TextBox();
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        log.Dock = DockStyle.Fill;
        log.BackColor = Color.FromArgb(16, 16, 18);
        log.ForeColor = Color.FromArgb(210, 210, 216);
        log.BorderStyle = BorderStyle.None;
        log.Font = new Font("Consolas", 9F);
        log.Text = BuildDiagnostics();
        Controls.Add(log);

        Shown += delegate { log.SelectionStart = 0; log.ScrollToCaret(); };
    }

    private Button MakeButton(string text, int width, int height, string tag, EventHandler click)
    {
        Button b = new Button();
        b.Text = text;
        b.Width = width;
        b.Height = height;
        b.Tag = tag;
        b.BackColor = SystemColors.Control;
        b.ForeColor = Color.Black;
        b.FlatStyle = FlatStyle.System;
        b.Click += click;
        return b;
    }

    private string BuildDiagnostics()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("--- This PC ---");
        sb.AppendLine("OS: " + Environment.OSVersion.VersionString);
        sb.AppendLine("64-bit OS: " + Environment.Is64BitOperatingSystem +
                      "   |   64-bit process: " + (IntPtr.Size == 8));
        sb.AppendLine(".NET Framework: " + Environment.Version);
        sb.AppendLine();
        sb.AppendLine("--- Portable voice files ---");
        sb.AppendLine(VoiceSetup.PortableDir);
        foreach (string f in VoiceSetup.PortableFiles)
        {
            bool ok = File.Exists(Path.Combine(VoiceSetup.PortableDir, f));
            sb.AppendLine("  " + (ok ? "[OK]      " : "[MISSING] ") + f);
        }
        sb.AppendLine();
        sb.AppendLine("--- Registered 32-bit speech engines ---");
        try
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32))
            using (RegistryKey key = root.OpenSubKey(@"SOFTWARE\Voice\TextToSpeech\Engine"))
            {
                if (key == null) sb.AppendLine("  (none)");
                else
                {
                    foreach (string name in key.GetValueNames())
                        sb.AppendLine("  " + name + " = " + key.GetValue(name));
                }
            }
        }
        catch (Exception ex)
        {
            sb.AppendLine("  Could not read registry: " + ex.Message);
        }

        if (!string.IsNullOrEmpty(lastError))
        {
            sb.AppendLine();
            sb.AppendLine("--- Error from speech engine ---");
            sb.AppendLine(lastError);
        }
        return sb.ToString();
    }

    private void AppendLog(string text)
    {
        log.AppendText(Environment.NewLine + "--- " + DateTime.Now.ToString("HH:mm:ss") + " ---" +
                       Environment.NewLine + text + Environment.NewLine);
        log.SelectionStart = log.TextLength;
        log.ScrollToCaret();
    }

    private void RunElevated(string label, string flag)
    {
        long started = DateTime.UtcNow.Ticks - 10000; // ignore an older result file
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(Application.ExecutablePath, flag);
            psi.UseShellExecute = true;
            psi.Verb = "runas";
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Process p = Process.Start(psi);
            if (p == null) throw new InvalidOperationException("Could not start the installer.");
            Cursor = Cursors.WaitCursor;
            p.WaitForExit();
            Cursor = Cursors.Default;

            VoiceSetup.Result r = ReadResultSafe();
            if (r != null && r.Ts >= started && r.Ok)
            {
                AppendLog(label + " installed successfully." + Environment.NewLine + r.Message);
                MessageBox.Show(this, label + " installed.\n\nClick Retry speech engine to reload it.",
                    "Voice Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                string msg = r == null ? "The installer did not report back." : r.Message;
                AppendLog(label + " failed: " + msg);
                MessageBox.Show(this, "Could not install " + label + ".\n\n" + msg,
                    "Voice Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        catch (Exception ex)
        {
            Cursor = Cursors.Default;
            AppendLog(label + " cancelled or failed: " + ex.Message);
            MessageBox.Show(this,
                "Installation was cancelled or blocked.\n\nIf a UAC prompt appeared, allow it and try again.\n\n" + ex.Message,
                "Voice Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private VoiceSetup.Result ReadResultSafe()
    {
        // VoiceSetup.ReadResult is private; read the same marker here via reflection-free
        // duplicate so the nested class can stay private.
        try
        {
            string text = File.ReadAllText(VoiceSetup.MarkerPath, Encoding.UTF8);
            VoiceSetup.Result r = new VoiceSetup.Result();
            r.Ok = text.Contains("\"ok\":true");
            r.Retry = text.Contains("\"retry\":true");
            r.Ts = FieldNumber(text, "ts");
            r.Action = Field(text, "action");
            r.Message = Field(text, "message");
            return r;
        }
        catch
        {
            return null;
        }
    }

    private static string Field(string json, string name)
    {
        string key = "\"" + name + "\":\"";
        int a = json.IndexOf(key, StringComparison.Ordinal);
        if (a < 0) return "";
        a += key.Length;
        int b = json.IndexOf("\"", a);
        if (b < 0) b = json.Length;
        return json.Substring(a, b - a)
                   .Replace("\\\"", "\"")
                   .Replace("\\n", "\n")
                   .Replace("\\r", "");
    }

    private static long FieldNumber(string json, string name)
    {
        string key = "\"" + name + "\":";
        int a = json.IndexOf(key, StringComparison.Ordinal);
        if (a < 0) return 0;
        a += key.Length;
        int b = a;
        while (b < json.Length && json[b] >= '0' && json[b] <= '9') b++;
        long n;
        if (b == a || !long.TryParse(json.Substring(a, b - a), out n)) return 0;
        return n;
    }

    private void RepairPortable(object sender, EventArgs e)
    {
        try
        {
            VoiceSetup.ExtractPayloadPublic("PortableBin", VoiceSetup.PortableDir);
            AppendLog("Portable voice files restored to:\n" + VoiceSetup.PortableDir);
            WriteRetryMarker();
            MessageBox.Show(this, "Portable voice files restored.\n\nClick Retry speech engine.",
                "Voice Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            AppendLog("Repair failed: " + ex.Message);
        }
    }

    private void RetryEngine(object sender, EventArgs e)
    {
        WriteRetryMarker();
        Close();
    }

    private static void WriteRetryMarker()
    {
        Directory.CreateDirectory(VoiceSetup.DataDir);
        string json = "{\"ok\":true,\"retry\":true,\"action\":\"retry\"," +
                      "\"message\":\"User requested a retry\",\"ts\":" + DateTime.UtcNow.Ticks + "}";
        File.WriteAllText(VoiceSetup.MarkerPath, json, new UTF8Encoding(false));
    }
}
