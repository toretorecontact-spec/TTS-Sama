using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TTSSama.Setup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args.Length > 0 && string.Equals(args[0], "/uninstall", StringComparison.OrdinalIgnoreCase))
            {
                Application.Run(new UninstallForm());
                return;
            }

            Application.Run(new SetupForm(args));
        }
    }

    internal sealed class SetupForm : Form
    {
        private const string AppName = "TTS-Sama";
        private const string Version = "1.0.0";
        private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\TTS-Sama";

        private readonly string[] _args;
        private readonly string _logPath;

        private TextBox _pathBox;
        private Button _browseButton;
        private CheckBox _desktopCheck;
        private CheckBox _launchCheck;
        private ProgressBar _progress;
        private Label _status;
        private Button _installButton;
        private Button _cancelButton;
        private Button _launchButton;
        private BackgroundWorker _worker;
        private string _target;

        public SetupForm(string[] args)
        {
            _args = args ?? new string[0];
            _logPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TwitchSam",
                "setup.log");

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath));
                File.WriteAllText(_logPath, "TTS-Sama Setup log - " + DateTime.Now.ToString("s") + Environment.NewLine);
            }
            catch
            {
            }

            BuildUi();
            ParseArgs();
        }

        private void BuildUi()
        {
            Text = "TTS-Sama Setup";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            ClientSize = new Size(520, 420);
            BackColor = Color.FromArgb(30, 30, 32);
            Font = new Font("Segoe UI", 9F);

            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 104;
            header.BackColor = Color.FromArgb(24, 24, 26);
            header.Paint += HeaderPaint;
            Controls.Add(header);

            Label title = new Label();
            title.Text = "TTS-Sama";
            title.Location = new Point(24, 20);
            title.Size = new Size(472, 34);
            title.ForeColor = Color.White;
            title.BackColor = Color.Transparent;
            title.Font = new Font("Segoe UI", 20F, FontStyle.Bold);
            header.Controls.Add(title);

            Label sub = new Label();
            sub.Text = "Reads chat aloud with local voices";
            sub.Location = new Point(26, 60);
            sub.Size = new Size(472, 24);
            sub.ForeColor = Color.FromArgb(190, 190, 196);
            sub.BackColor = Color.Transparent;
            sub.Font = new Font("Segoe UI", 10F);
            header.Controls.Add(sub);

            GroupBox destGroup = new GroupBox();
            destGroup.Text = "Destination folder";
            destGroup.Location = new Point(24, 124);
            destGroup.Size = new Size(472, 74);
            destGroup.ForeColor = Color.FromArgb(220, 220, 224);
            Controls.Add(destGroup);

            _pathBox = new TextBox();
            _pathBox.Location = new Point(14, 28);
            _pathBox.Size = new Size(350, 25);
            _pathBox.ReadOnly = true;
            _pathBox.BackColor = Color.FromArgb(48, 48, 52);
            _pathBox.ForeColor = Color.White;
            _pathBox.BorderStyle = BorderStyle.FixedSingle;
            destGroup.Controls.Add(_pathBox);

            _browseButton = MakeButton("Browse...", 372, 27, 86, false);
            destGroup.Controls.Add(_browseButton);
            _browseButton.Click += BrowseClick;

            _desktopCheck = new CheckBox();
            _desktopCheck.Text = "Create desktop shortcut";
            _desktopCheck.Checked = true;
            _desktopCheck.Location = new Point(26, 212);
            _desktopCheck.Size = new Size(240, 24);
            _desktopCheck.ForeColor = Color.FromArgb(220, 220, 224);
            Controls.Add(_desktopCheck);

            _launchCheck = new CheckBox();
            _launchCheck.Text = "Launch TTS-Sama when finished";
            _launchCheck.Checked = true;
            _launchCheck.Location = new Point(26, 238);
            _launchCheck.Size = new Size(320, 24);
            _launchCheck.ForeColor = Color.FromArgb(220, 220, 224);
            Controls.Add(_launchCheck);

            Label note = new Label();
            note.Text = "Installs the app and the local speech engine.\r\nWindows may ask for permission once.";
            note.Location = new Point(26, 272);
            note.Size = new Size(468, 38);
            note.ForeColor = Color.FromArgb(170, 170, 176);
            Controls.Add(note);

            _progress = new ProgressBar();
            _progress.Location = new Point(24, 318);
            _progress.Size = new Size(472, 14);
            _progress.Style = ProgressBarStyle.Continuous;
            Controls.Add(_progress);

            _status = new Label();
            _status.Text = "Ready to install";
            _status.Location = new Point(24, 340);
            _status.Size = new Size(472, 22);
            _status.ForeColor = Color.FromArgb(200, 200, 206);
            Controls.Add(_status);

            _installButton = MakeButton("Install", 352, 374, 70, true);
            _installButton.Click += InstallClick;
            Controls.Add(_installButton);

            _launchButton = MakeButton("Launch", 428, 374, 68, false);
            _launchButton.Visible = false;
            _launchButton.Click += LaunchClick;
            Controls.Add(_launchButton);

            _cancelButton = MakeButton("Cancel", 276, 374, 70, false);
            _cancelButton.Click += CancelClick;
            Controls.Add(_cancelButton);

            _worker = new BackgroundWorker();
            _worker.WorkerReportsProgress = true;
            _worker.WorkerSupportsCancellation = true;
            _worker.DoWork += WorkerDoWork;
            _worker.ProgressChanged += WorkerProgressChanged;
            _worker.RunWorkerCompleted += WorkerCompleted;
        }

        private Button MakeButton(string text, int x, int y, int w, bool primary)
        {
            Button b = new Button();
            b.Text = text;
            b.Location = new Point(x, y);
            b.Size = new Size(w, 28);
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = 1;
            b.FlatAppearance.BorderColor = primary ? Color.FromArgb(138, 92, 246) : Color.FromArgb(100, 100, 106);
            b.BackColor = primary ? Color.FromArgb(108, 70, 210) : Color.FromArgb(52, 52, 56);
            b.ForeColor = Color.White;
            return b;
        }

        private void HeaderPaint(object sender, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(138, 92, 246)))
            {
                g.FillRectangle(brush, 0, 0, 5, 104);
            }
            using (Pen pen = new Pen(Color.FromArgb(60, 60, 66)))
            {
                g.DrawLine(pen, 0, 103, 520, 103);
            }
        }

        private void ParseArgs()
        {
            _target = GetDefaultInstallPath();
            foreach (string arg in _args)
            {
                if (arg.StartsWith("/path:", StringComparison.OrdinalIgnoreCase) && arg.Length > 6)
                {
                    _target = arg.Substring(6).Trim('"');
                }
                else if (string.Equals(arg, "/dryrun", StringComparison.OrdinalIgnoreCase))
                {
                    _target = Path.Combine(Path.GetTempPath(), "TTS-Sama-DryRun");
                    _desktopCheck.Checked = false;
                    _launchCheck.Checked = false;
                }
            }
            _pathBox.Text = _target;
        }

        private static string GetDefaultInstallPath()
        {
            string root = Environment.GetEnvironmentVariable("ProgramW6432");
            if (string.IsNullOrEmpty(root))
            {
                root = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            }
            return Path.Combine(root, AppName);
        }

        private void BrowseClick(object sender, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Choose the install folder";
                dlg.SelectedPath = _target;
                dlg.ShowNewFolderButton = true;
                if (dlg.ShowDialog(this) == DialogResult.OK)
                {
                    _target = dlg.SelectedPath;
                    _pathBox.Text = _target;
                }
            }
        }

        private void InstallClick(object sender, EventArgs e)
        {
            if (_worker.IsBusy)
            {
                return;
            }
            _installButton.Enabled = false;
            _browseButton.Enabled = false;
            _desktopCheck.Enabled = false;
            _launchCheck.Enabled = false;
            _progress.Value = 0;
            _status.Text = "Starting...";
            _worker.RunWorkerAsync();
        }

        private void CancelClick(object sender, EventArgs e)
        {
            if (_worker.IsBusy)
            {
                _worker.CancelAsync();
                _status.Text = "Cancelling...";
                return;
            }
            Close();
        }

        private void LaunchClick(object sender, EventArgs e)
        {
            LaunchApp();
        }

        private void WorkerDoWork(object sender, DoWorkEventArgs e)
        {
            BackgroundWorker w = (BackgroundWorker)sender;
            try
            {
                bool dryRun = HasArg("/dryrun");
                Step(w, e, "Preparing files...", 5);
                string temp = ExtractEngine();
                if (e.Cancel) return;

                Step(w, e, "Installing application files...", 20);
                InstallAppFiles(_target);
                if (e.Cancel) return;

                if (!dryRun)
                {
                    Step(w, e, "Installing local speech runtime...", 45);
                    EnsureSapi4Runtime(temp);
                    if (e.Cancel) return;

                    Step(w, e, "Installing TruVoice speech engine...", 68);
                    EnsureTruVoice(temp);
                    if (e.Cancel) return;

                    Step(w, e, "Creating shortcuts...", 86);
                    CreateShortcuts(_target, _desktopCheck.Checked);
                    RegisterUninstall(_target);
                }

                Step(w, e, "Finishing...", 96);
                if (_launchCheck.Checked && !dryRun)
                {
                    LaunchApp();
                }
                Step(w, e, dryRun ? "Dry run complete." : "Installation complete.", 100);
                e.Result = true;
            }
            catch (Exception ex)
            {
                Log("ERROR: " + ex.ToString());
                e.Result = ex;
            }
        }

        private bool HasArg(string name)
        {
            foreach (string arg in _args)
            {
                if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void Step(BackgroundWorker w, DoWorkEventArgs e, string text, int percent)
        {
            if (e.Cancel) return;
            w.ReportProgress(percent, text);
        }

        private void WorkerProgressChanged(object sender, ProgressChangedEventArgs e)
        {
            _progress.Value = Math.Max(0, Math.Min(100, e.ProgressPercentage));
            _status.Text = e.UserState as string ?? "Working...";
            Log(_status.Text);
        }

        private void WorkerCompleted(object sender, RunWorkerCompletedEventArgs e)
        {
            _browseButton.Enabled = true;
            _cancelButton.Text = "Close";

            if (e.Result is Exception)
            {
                Exception ex = (Exception)e.Result;
                _status.Text = "Installation failed.";
                MessageBox.Show(this,
                    ex.Message + Environment.NewLine + Environment.NewLine + "Details were written to:" + Environment.NewLine + _logPath,
                    "TTS-Sama Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return;
            }

            if (e.Cancelled)
            {
                _status.Text = "Installation cancelled.";
                return;
            }

            _installButton.Enabled = false;
            _launchButton.Visible = true;
            _status.Text = "Done. You can close this window.";
        }

        private void InstallAppFiles(string target)
        {
            Directory.CreateDirectory(target);
            byte[] app = ReadResource("AppExe");
            File.WriteAllBytes(Path.Combine(target, "TTS-Sama.exe"), app);

            string setupSrc = Assembly.GetExecutingAssembly().Location;
            string setupDst = Path.Combine(target, "Uninstall TTS-Sama.exe");
            if (!string.Equals(Path.GetFullPath(setupSrc), Path.GetFullPath(setupDst), StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(setupSrc, setupDst, true);
            }

            string readme = Path.Combine(target, "README.txt");
            File.WriteAllText(readme,
                "TTS-Sama " + Version + Environment.NewLine +
                Environment.NewLine +
                "Double-click TTS-Sama.exe to open the control panel." + Environment.NewLine +
                "Type a channel name or a twitch.tv URL, then click Start." + Environment.NewLine +
                Environment.NewLine +
                "The Bonzi Buddy voice is installed into Windows during setup and works offline." + Environment.NewLine +
                "The chat connection itself still needs an internet connection." + Environment.NewLine +
                Environment.NewLine +
                "To uninstall, run 'Uninstall TTS-Sama.exe' from this folder or use Apps & features." + Environment.NewLine,
                Encoding.UTF8);
        }

        private static byte[] ReadResource(string name)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null) throw new InvalidOperationException("Missing embedded resource: " + name);
                using (MemoryStream ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    return ms.ToArray();
                }
            }
        }

        private string ExtractEngine()
        {
            string temp = Path.Combine(Path.GetTempPath(), "TTS-Sama-Setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            Log("Engine temp: " + temp);

            byte[] bin = ReadResource("EngineBin");
            using (MemoryStream ms = new MemoryStream(bin))
            using (BinaryReader br = new BinaryReader(ms))
            {
                string magic = Encoding.ASCII.GetString(br.ReadBytes(4));
                if (magic != "TSE1") throw new InvalidDataException("Invalid engine payload.");
                int count = br.ReadInt32();
                for (int i = 0; i < count; i++)
                {
                    int nameLen = br.ReadInt32();
                    string name = Encoding.UTF8.GetString(br.ReadBytes(nameLen));
                    int dataLen = br.ReadInt32();
                    byte[] data = br.ReadBytes(dataLen);
                    string outPath = Path.Combine(temp, Path.GetFileName(name));
                    File.WriteAllBytes(outPath, data);
                }
            }
            return temp;
        }

        private void EnsureSapi4Runtime(string temp)
        {
            string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string speechDir = Path.Combine(win, "speech");
            string speechDll = Path.Combine(speechDir, "speech.dll");

            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\SpeechAPI"))
            {
                if (key != null) key.SetValue("InstallDir", speechDir, RegistryValueKind.String);
            }

            if (!File.Exists(speechDll))
            {
                string inf = Path.Combine(temp, "SPCHAPI.INF");
                if (File.Exists(inf))
                {
                    Log("LaunchINFSectionEx SPCHAPI.INF");
                    RunHidden("rundll32.exe", "advpack.dll,LaunchINFSectionEx \"" + inf + "\",DefaultInstall,,4,N");
                    WaitFor(() => File.Exists(speechDll), 8000);
                }

                if (!File.Exists(speechDll))
                {
                    string exe = Path.Combine(temp, "spchapi.exe");
                    if (File.Exists(exe))
                    {
                        Log("Fallback spchapi.exe /q");
                        RunHidden(exe, "/q");
                        WaitFor(() => File.Exists(speechDll), 8000);
                    }
                }
            }

            if (!File.Exists(speechDll))
            {
                throw new InvalidOperationException("Could not install the SAPI 4 speech runtime.");
            }
        }

        private void EnsureTruVoice(string temp)
        {
            string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string dest = Path.Combine(win, "lhsp", "tv");
            string dll = Path.Combine(dest, "tv_enua.dll");
            string ax = Path.Combine(dest, "tvenuax.dll");

            if (!File.Exists(dll) || !File.Exists(ax))
            {
                string inf = Path.Combine(temp, "tv_enua.inf");
                if (File.Exists(inf))
                {
                    Log("LaunchINFSectionEx tv_enua.inf");
                    RunHidden("rundll32.exe", "advpack.dll,LaunchINFSectionEx \"" + inf + "\",DefaultInstall,,4,N");
                    WaitFor(() => File.Exists(dll) && File.Exists(ax), 8000);
                }
            }

            if (!File.Exists(dll) || !File.Exists(ax))
            {
                Log("Fallback manual TruVoice install");
                Directory.CreateDirectory(dest);
                string[] files = new string[] { "tv_enua.dll", "tvenuax.dll", "msvcp50.dll", "msvcirt.dll", "tv_enua.hlp", "andmoipa.ttf" };
                foreach (string f in files)
                {
                    string src = Path.Combine(temp, f);
                    if (File.Exists(src)) File.Copy(src, Path.Combine(dest, f), true);
                }
                RunHidden(Regsvr32Path(), "/s \"" + dll + "\"");
                RunHidden(Regsvr32Path(), "/s \"" + ax + "\"");
            }

            if (!File.Exists(dll) || !File.Exists(ax))
            {
                throw new InvalidOperationException("Could not install the TruVoice speech engine.");
            }

            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Voice\TextToSpeech\Engine"))
            {
                if (key != null)
                {
                    key.SetValue("TruVoiceAmEnglish", "{CA141FD0-AC7F-11D1-97A3-0060082730FF}", RegistryValueKind.String);
                }
            }
        }

        private static string Regsvr32Path()
        {
            string sysx86 = Environment.GetFolderPath(Environment.SpecialFolder.SystemX86);
            if (!string.IsNullOrEmpty(sysx86))
            {
                string p = Path.Combine(sysx86, "regsvr32.exe");
                if (File.Exists(p)) return p;
            }
            string p2 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "regsvr32.exe");
            return p2;
        }

        private static int RunHidden(string file, string arguments)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(file, arguments);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    if (p == null) return -1;
                    p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(30000)) return -2;
                    return p.ExitCode;
                }
            }
            catch (Exception ex)
            {
                // Log from instance methods only; static helper cannot access _logPath.
                Debug.WriteLine(ex.Message);
                return -3;
            }
        }

        private static void WaitFor(Func<bool> condition, int milliseconds)
        {
            int elapsed = 0;
            while (elapsed < milliseconds && !condition())
            {
                Thread.Sleep(100);
                elapsed += 100;
            }
        }

        private static void CreateShortcuts(string target, bool desktop)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
            string folder = Path.Combine(programs, AppName);
            Directory.CreateDirectory(folder);

            string appExe = Path.Combine(target, "TTS-Sama.exe");
            string uninstallExe = Path.Combine(target, "Uninstall TTS-Sama.exe");

            MakeShortcut(shell, Path.Combine(folder, "TTS-Sama.lnk"), appExe, "", target, "Read chat aloud");
            MakeShortcut(shell, Path.Combine(folder, "Uninstall TTS-Sama.lnk"), uninstallExe, "/uninstall", target, "Uninstall TTS-Sama");
            if (desktop)
            {
                string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
                MakeShortcut(shell, Path.Combine(desktopDir, "TTS-Sama.lnk"), appExe, "", target, "Read chat aloud");
            }
        }

        private static void MakeShortcut(object shell, string linkPath, string target, string arguments, string workDir, string description)
        {
            object sc = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
            SetCom(sc, "TargetPath", target);
            SetCom(sc, "Arguments", arguments);
            SetCom(sc, "WorkingDirectory", workDir);
            SetCom(sc, "IconLocation", target + ",0");
            SetCom(sc, "Description", description);
            sc.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }

        private static void SetCom(object obj, string property, object value)
        {
            obj.GetType().InvokeMember(property, BindingFlags.SetProperty, null, obj, new object[] { value });
        }

        private static void RegisterUninstall(string target)
        {
            using (RegistryKey key = Registry.LocalMachine.CreateSubKey(UninstallKey))
            {
                if (key == null) return;
                key.SetValue("DisplayName", AppName, RegistryValueKind.String);
                key.SetValue("DisplayVersion", Version, RegistryValueKind.String);
                key.SetValue("Publisher", "TTS-Sama", RegistryValueKind.String);
                key.SetValue("InstallLocation", target, RegistryValueKind.String);
                key.SetValue("UninstallString", "\"" + Path.Combine(target, "Uninstall TTS-Sama.exe") + "\" /uninstall", RegistryValueKind.String);
                key.SetValue("DisplayIcon", Path.Combine(target, "TTS-Sama.exe") + ",0", RegistryValueKind.String);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                try
                {
                    FileInfo fi = new FileInfo(Path.Combine(target, "TTS-Sama.exe"));
                    if (fi.Exists) key.SetValue("EstimatedSize", (int)(fi.Length / 1024), RegistryValueKind.DWord);
                }
                catch
                {
                }
            }
        }

        private static void LaunchApp()
        {
            try
            {
                string root = Environment.GetEnvironmentVariable("ProgramW6432");
                if (string.IsNullOrEmpty(root)) root = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                string exe = Path.Combine(root, AppName, "TTS-Sama.exe");
                if (!File.Exists(exe))
                {
                    exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), AppName, "TTS-Sama.exe");
                }
                if (File.Exists(exe))
                {
                    ProcessStartInfo psi = new ProcessStartInfo(exe);
                    psi.UseShellExecute = true;
                    Process.Start(psi);
                }
            }
            catch
            {
            }
        }

        private void Log(string message)
        {
            try
            {
                File.AppendAllText(_logPath, DateTime.Now.ToString("HH:mm:ss") + " " + message + Environment.NewLine);
            }
            catch
            {
            }
        }
    }

    internal sealed class UninstallForm : Form
    {
        public UninstallForm()
        {
            Text = "Uninstall TTS-Sama";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ClientSize = new Size(420, 180);
            BackColor = Color.FromArgb(30, 30, 32);
            Font = new Font("Segoe UI", 9F);

            Label label = new Label();
            label.Text = "Remove TTS-Sama from this computer?\r\n\r\nThe shared Windows speech engines will be left installed.";
            label.Location = new Point(24, 24);
            label.Size = new Size(372, 70);
            label.ForeColor = Color.White;
            Controls.Add(label);

            Button yes = new Button();
            yes.Text = "Uninstall";
            yes.Location = new Point(216, 122);
            yes.Size = new Size(84, 28);
            yes.FlatStyle = FlatStyle.Flat;
            yes.BackColor = Color.FromArgb(108, 70, 210);
            yes.ForeColor = Color.White;
            yes.FlatAppearance.BorderColor = Color.FromArgb(138, 92, 246);
            yes.Click += YesClick;
            Controls.Add(yes);

            Button no = new Button();
            no.Text = "Cancel";
            no.Location = new Point(308, 122);
            no.Size = new Size(84, 28);
            no.FlatStyle = FlatStyle.Flat;
            no.BackColor = Color.FromArgb(52, 52, 56);
            no.ForeColor = Color.White;
            no.FlatAppearance.BorderColor = Color.FromArgb(100, 100, 106);
            no.Click += delegate { Close(); };
            Controls.Add(no);
        }

        private void YesClick(object sender, EventArgs e)
        {
            try
            {
                string target = null;
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\TTS-Sama"))
                {
                    if (key != null) target = key.GetValue("InstallLocation") as string;
                }

                if (!string.IsNullOrEmpty(target) && target.IndexOf("TTS-Sama", StringComparison.OrdinalIgnoreCase) >= 0 && Directory.Exists(target))
                {
                    Directory.Delete(target, true);
                }

                string programs = Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms);
                string folder = Path.Combine(programs, "TTS-Sama");
                if (Directory.Exists(folder)) Directory.Delete(folder, true);

                string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
                string desktopLink = Path.Combine(desktopDir, "TTS-Sama.lnk");
                if (File.Exists(desktopLink)) File.Delete(desktopLink);

                Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\TTS-Sama", false);
                MessageBox.Show(this, "TTS-Sama was removed.", "Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not remove all files: " + ex.Message, "Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            Close();
        }
    }
}
