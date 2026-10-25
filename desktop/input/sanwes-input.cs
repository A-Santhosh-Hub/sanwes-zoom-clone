// SanWe's input helper (Game Hub). The SanWe's server starts this program when the streamer lets a viewer play, and sends it one text command per line.
// It turns them into real keyboard and mouse input (SendInput, hardware scan codes, which games read) and into virtual Xbox 360 controllers (ViGEmBus).
// It only runs while the streamer has someone playing, and it is deliberately limited:
//   - it can be told to act only while ONE window (the shared game) is in front: otherwise every command is dropped and any held key is let go;
//   - it never types Windows keys, Alt+Tab, Alt+F4, Ctrl+Esc, Print Screen, power/sleep keys unless the streamer switched "system keys" on;
//   - the Xbox "Guide" button is never sent;
//   - the streamer can cut everything off with an emergency hotkey or the pill's Stop button, even if the page or the server has hung.
// Compiled with the .NET Framework compiler that ships with Windows (C# 5): desktop\input\build-input.bat
//
// Commands (stdin, one per line, numbers in decimal)               Replies (stdout)
//   KD <scancode> <ext>   key down      KU <scancode> <ext>  key up      READY <vigem 0|1>      started
//   MR <dx> <dy>          mouse moves by dx,dy                           FG <0|1>               the game window is in front (1) or not (0)
//   MA <x> <y>            mouse to x,y (0..65535 across the target)      FB <slot> <big> <small> rumble asked for by the game (0..255)
//   MB <button> <0|1>     0 left 1 right 2 middle 3 back 4 forward       ERR <text>             something went wrong
//   MW <delta>            wheel (120 = one notch, + is away from you)    PONG <id>              answer to PING
//   MH <delta>            sideways wheel                                 PANIC <hotkey|button>  the streamer cut everything off
//   PD <slot> <buttons> <lt> <rt> <lx> <ly> <rx> <ry>   gamepad 0..3 state (XUSB button bits, triggers 0..255, sticks -32768..32767)
//   PX <slot>             remove a virtual gamepad
//   RA                    let go of every key, button and gamepad
//   TW <hwnd>             the window the players control: MA maps onto it, and (unless TG 0) keys/mouse only act while it is in front (0 = none)
//   TG <0|1>              1 (default): act only while the TW window is in front; 0: act whatever is in front
//   TR <left> <top> <width> <height>   the screen area MA maps onto (physical pixels)
//   SYS <0|1>             allow Windows keys, Alt+Tab, Alt+F4 ...
//   HK                    register the emergency hotkey (first free of Ctrl+Alt+Shift+F12, Q, X): replies HK <name> or HK none
//   HUD <text>            show the "who is playing" pill on this PC (always on top, never takes focus, hidden from screen capture); HUD alone hides it
//   LISTWIN               the program windows you could share/control: WIN <hwnd> <pid> <title> ... WINEND
//   SCREENS               the screens: SCR <index> <left> <top> <width> <height> <primary 0|1> ... SCREND
//   PING <id>             STAT      Q (quit)
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.Xbox360;

static class Win
{
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr h, IntPtr lp);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
}

// The small pill on the streamer's screen. It also owns the window the emergency hotkey is registered on.
class Hud : Form
{
    const int WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000, WM_HOTKEY = 0x0312;
    readonly Label text = new Label();
    readonly Button stop = new Button();
    public Action<string> OnPanic;
    public Hud()
    {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(29, 31, 35); Opacity = 0.96; Text = "SanWe's Game Hub";
        float s = DeviceDpi / 96f;
        Size = new Size((int)(620 * s), (int)(44 * s));
        text.ForeColor = Color.FromArgb(242, 243, 245); text.Font = new Font("Segoe UI", 10f); text.AutoEllipsis = true; text.TextAlign = ContentAlignment.MiddleLeft;
        text.SetBounds((int)(14 * s), 0, (int)(470 * s), Height);
        stop.Text = "Stop all"; stop.FlatStyle = FlatStyle.Flat; stop.BackColor = Color.FromArgb(217, 48, 37); stop.ForeColor = Color.White; stop.FlatAppearance.BorderSize = 0;
        stop.Font = new Font("Segoe UI Semibold", 10f); stop.SetBounds((int)(500 * s), (int)(6 * s), (int)(110 * s), (int)(32 * s));
        stop.TabStop = false; stop.Click += delegate { if (OnPanic != null) OnPanic("button"); };
        Controls.Add(text); Controls.Add(stop);
        Rectangle wa = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(wa.Left + (wa.Width - Width) / 2, wa.Top + (int)(8 * s));
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE; return cp; } }
    protected override void SetVisibleCore(bool v) { if (!IsHandleCreated) { CreateHandle(); } base.SetVisibleCore(v); }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && OnPanic != null) OnPanic("hotkey");
        base.WndProc(ref m);
    }
    public void SetText(string s)
    {
        if (string.IsNullOrEmpty(s)) { Hide(); return; }
        text.Text = "Game Hub: " + s;
        if (!Visible) { Show(); }
        Win.SetWindowDisplayAffinity(Handle, 0x11); // not part of the stream or of recordings (older Windows: shows black there)
        TopMost = true;
    }
}

static class Program
{
    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_EXTENDEDKEY = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_SCANCODE = 8;
    const uint MOUSEEVENTF_MOVE = 0x1, MOUSEEVENTF_WHEEL = 0x800, MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_VIRTUALDESK = 0x4000, MOUSEEVENTF_ABSOLUTE = 0x8000;
    static readonly uint[] BtnDown = { 0x2, 0x8, 0x20, 0x80, 0x80 }, BtnUp = { 0x4, 0x10, 0x40, 0x100, 0x100 };
    const ushort PAD_MASK = 0xF3FF; // every Xbox button except Guide (0x0400) and the two unused bits
    static readonly string[] HotNames = { "Ctrl+Alt+Shift+F12", "Ctrl+Alt+Shift+Q", "Ctrl+Alt+Shift+X" };
    static readonly uint[] HotKeys = { 0x7B, 0x51, 0x58 };

    static readonly object Sync = new object();
    static readonly TextWriter Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
    static readonly HashSet<int> HeldKeys = new HashSet<int>();   // scancode | ext << 8
    static readonly HashSet<int> HeldBtns = new HashSet<int>();
    static IntPtr target = IntPtr.Zero;
    static int tl, tt, tw, th;          // TR rectangle (0 width = the main screen)
    static bool allowSys, lastFg = true, gate = true;
    static ViGEmClient client;
    static readonly IXbox360Controller[] pads = new IXbox360Controller[4];
    static readonly int[] fbLast = new int[4];
    static int fgReports;
    static Hud hud;
    static readonly ManualResetEvent uiReady = new ManualResetEvent(false);

    static void Say(string s) { lock (Out) { Out.WriteLine(s); } }

    static int Main()
    {
        try { if (!Win.SetProcessDpiAwarenessContext(new IntPtr(-4))) Win.SetProcessDPIAware(); } catch { try { Win.SetProcessDPIAware(); } catch { } }
        Thread ui = new Thread(UiMain); ui.SetApartmentState(ApartmentState.STA); ui.IsBackground = true; ui.Start();
        uiReady.WaitOne(5000);
        bool vigem = ProbeVigem();
        Say("READY " + (vigem ? 1 : 0));
        Thread watch = new Thread(Watch); watch.IsBackground = true; watch.Start();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length > 400) continue;
            try { if (!Handle(line)) break; }
            catch (Exception e) { Say("ERR " + e.GetType().Name + ": " + e.Message.Replace('\n', ' ')); }
        }
        lock (Sync) { ReleaseAll(true); }
        try { if (hud != null && hud.IsHandleCreated) hud.Invoke(new Action(delegate { Win.UnregisterHotKey(hud.Handle, 1); Application.ExitThread(); })); } catch { }
        return 0;
    }

    // The pill and the hotkey live on their own thread with a message loop.
    static void UiMain()
    {
        Application.EnableVisualStyles();
        hud = new Hud();
        hud.OnPanic = Panic;
        IntPtr h = hud.Handle; // creates the (hidden) window
        uiReady.Set();
        Application.Run();
    }
    static void Panic(string why)
    {
        lock (Sync) { ReleaseInputs(); NeutralPads(); }
        Say("PANIC " + why);
    }
    static string RegisterHotkey()
    {
        for (int i = 0; i < HotNames.Length; i++)
            if (Win.RegisterHotKey(hud.Handle, 1, 0x1 | 0x2 | 0x4 | 0x4000, HotKeys[i])) return HotNames[i];
        return "none";
    }

    static bool ProbeVigem()
    {
        try { client = new ViGEmClient(); return true; }
        catch (Exception e) { Say("ERR vigem: " + e.Message.Replace('\n', ' ')); return false; }
    }

    // ---------------------------------------------------------------- the window rule
    static bool FrontOk()
    {
        if (target == IntPtr.Zero || !gate) return true;
        if (!Win.IsWindow(target) || Win.IsIconic(target)) return false;
        IntPtr fg = Win.GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        if (fg == target) return true;
        uint a, b; Win.GetWindowThreadProcessId(fg, out a); Win.GetWindowThreadProcessId(target, out b);
        return a != 0 && a == b;
    }
    static void Watch()
    {
        for (;;)
        {
            Thread.Sleep(150);
            lock (Sync)
            {
                bool ok = FrontOk();
                if (ok != lastFg)
                {
                    lastFg = ok;
                    Say("FG " + (ok ? 1 : 0));
                    if (!ok) ReleaseInputs(); // do not leave keys pressed in a game that is no longer in front
                }
            }
        }
    }

    // ---------------------------------------------------------------- keys
    static bool Held(int sc, bool ext) { return HeldKeys.Contains(sc | (ext ? 0x100 : 0)); }
    static bool KeyAllowed(int sc, bool ext)
    {
        if (!ext)
        {
            bool main = sc >= 0x01 && sc <= 0x58, f13 = sc >= 0x64 && sc <= 0x6E; // F13..F23 are harmless and used by the tests
            if (!main && !f13) return false;
        }
        else
        {
            switch (sc)
            {
                case 0x1C: case 0x1D: case 0x35: case 0x38: case 0x47: case 0x48: case 0x49: case 0x4B: case 0x4D: case 0x4F: case 0x50: case 0x51: case 0x52: case 0x53: break;
                case 0x5B: case 0x5C: case 0x5D: if (!allowSys) return false; break; // Windows keys, menu key
                default: return false;                                                    // print screen, power, sleep, media and browser keys ...
            }
        }
        if (!allowSys)
        {
            bool alt = Held(0x38, false) || Held(0x38, true), ctrl = Held(0x1D, false) || Held(0x1D, true);
            if (alt && !ext && (sc == 0x0F || sc == 0x3E || sc == 0x01 || sc == 0x39)) return false; // Alt+Tab, Alt+F4, Alt+Esc, Alt+Space
            if (ctrl && !ext && sc == 0x01) return false;                                            // Ctrl+Esc, Ctrl+Shift+Esc
        }
        return true;
    }
    static void SendKey(int sc, bool ext, bool up)
    {
        Win.INPUT[] a = new Win.INPUT[1];
        a[0].type = INPUT_KEYBOARD;
        a[0].u.ki.wScan = (ushort)sc;
        a[0].u.ki.dwFlags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
        Win.SendInput(1, a, Marshal.SizeOf(typeof(Win.INPUT)));
    }
    static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        Win.INPUT[] a = new Win.INPUT[1];
        a[0].type = INPUT_MOUSE;
        a[0].u.mi.dx = dx; a[0].u.mi.dy = dy; a[0].u.mi.mouseData = data; a[0].u.mi.dwFlags = flags;
        Win.SendInput(1, a, Marshal.SizeOf(typeof(Win.INPUT)));
    }

    // ---------------------------------------------------------------- let go of everything
    static void ReleaseInputs() // keys and mouse buttons (virtual gamepads are not tied to the window rule)
    {
        foreach (int k in new List<int>(HeldKeys)) SendKey(k & 0xFF, (k & 0x100) != 0, true);
        HeldKeys.Clear();
        foreach (int b in new List<int>(HeldBtns)) SendMouse(BtnUp[b], 0, 0, b >= 3 ? (uint)(b - 2) : 0);
        HeldBtns.Clear();
    }
    static void NeutralPads()
    {
        for (int i = 0; i < pads.Length; i++) if (pads[i] != null) { try { pads[i].ResetReport(); pads[i].SubmitReport(); } catch { } }
    }
    static void ReleaseAll(bool dispose)
    {
        ReleaseInputs(); NeutralPads();
        if (!dispose) return;
        for (int i = 0; i < pads.Length; i++) if (pads[i] != null) { try { pads[i].Disconnect(); } catch { } pads[i] = null; }
        if (client != null) { try { client.Dispose(); } catch { } client = null; }
    }

    // ---------------------------------------------------------------- lists for the page
    static string Clean(string s)
    {
        StringBuilder b = new StringBuilder();
        foreach (char c in s) { if (c >= ' ' && c != 0x7F) b.Append(c); }
        string r = b.ToString().Trim();
        return r.Length > 90 ? r.Substring(0, 90) : r;
    }
    static void ListWindows()
    {
        List<string> rows = new List<string>();
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        Win.EnumWindows(delegate (IntPtr h, IntPtr lp)
        {
            if (!Win.IsWindowVisible(h)) return true;
            if (Win.GetWindow(h, 4) != IntPtr.Zero) return true;                         // owned windows (dialogs)
            int ex = Win.GetWindowLong(h, -20);
            if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) return true;                    // tool windows
            int cloaked; if (Win.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden app windows
            int len = Win.GetWindowTextLength(h); if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 1); Win.GetWindowText(h, sb, sb.Capacity);
            string title = Clean(sb.ToString()); if (title.Length == 0 || title == "Program Manager") return true;
            uint pid; Win.GetWindowThreadProcessId(h, out pid); if (pid == self) return true;
            Win.RECT r; if (!Win.GetWindowRect(h, out r) || r.Right - r.Left < 100 || r.Bottom - r.Top < 60) return true;
            rows.Add("WIN " + h.ToInt64() + " " + pid + " " + title);
            return true;
        }, IntPtr.Zero);
        rows.Add("WINEND");
        Say(string.Join("\n", rows.ToArray()));
    }
    static void ListScreens()
    {
        List<string> rows = new List<string>();
        Screen[] all = Screen.AllScreens;
        for (int i = 0; i < all.Length; i++)
        {
            Rectangle b = all[i].Bounds;
            rows.Add("SCR " + i + " " + b.Left + " " + b.Top + " " + b.Width + " " + b.Height + " " + (all[i].Primary ? 1 : 0));
        }
        rows.Add("SCREND");
        Say(string.Join("\n", rows.ToArray()));
    }

    // ---------------------------------------------------------------- commands
    static int I(string s) { int v; return int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0; }
    static long L(string s) { long v; return long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v) ? v : 0; }

    static bool Handle(string line)
    {
        string t = line.Trim();
        // commands that talk to the pill's thread are handled before the input lock is taken (the hotkey handler takes that lock)
        if (t == "HUD" || t.StartsWith("HUD "))
        {
            string text = Clean(t.Length > 3 ? t.Substring(3) : "");
            try { hud.BeginInvoke(new Action(delegate { hud.SetText(text); })); } catch { }
            return true;
        }
        if (t == "HK") { string name = "none"; try { hud.Invoke(new Action(delegate { name = RegisterHotkey(); })); } catch { } Say("HK " + name); return true; }
        if (t == "LISTWIN") { ListWindows(); return true; }
        if (t == "SCREENS") { ListScreens(); return true; }

        string[] p = t.Split(' ');
        string c = p[0];
        lock (Sync)
        {
            switch (c)
            {
                case "Q": return false;
                case "PING": Say("PONG " + (p.Length > 1 ? p[1] : "")); return true;
                case "STAT": Say("STAT keys=" + HeldKeys.Count + " buttons=" + HeldBtns.Count + " front=" + (FrontOk() ? 1 : 0) + " vigem=" + (client != null ? 1 : 0) + " sys=" + (allowSys ? 1 : 0)); return true;
                case "TW": target = new IntPtr(L(p.Length > 1 ? p[1] : "0")); ReleaseInputs(); lastFg = FrontOk(); Say("FG " + (lastFg ? 1 : 0)); return true;
                case "TR": tl = I(p[1]); tt = I(p[2]); tw = I(p[3]); th = I(p[4]); return true;
                case "TG": gate = !(p.Length > 1 && p[1] == "0"); ReleaseInputs(); lastFg = FrontOk(); Say("FG " + (lastFg ? 1 : 0)); return true;
                case "SYS": allowSys = p.Length > 1 && p[1] == "1"; return true;
                case "RA": ReleaseAll(false); return true;
                case "PX": { int s = I(p[1]); if (s >= 0 && s < 4 && pads[s] != null) { try { pads[s].Disconnect(); } catch { } pads[s] = null; } return true; }
                case "PD": Pad(p); return true;
            }
            // keyboard and mouse: only while the shared window is in front
            if (!FrontOk()) { if (fgReports++ % 50 == 0) Say("FG 0"); return true; }
            switch (c)
            {
                case "KD":
                {
                    int sc = I(p[1]); bool ext = p.Length > 2 && p[2] == "1";
                    if (!KeyAllowed(sc, ext)) return true;
                    SendKey(sc, ext, false); HeldKeys.Add(sc | (ext ? 0x100 : 0)); return true;
                }
                case "KU":
                {
                    int sc = I(p[1]); bool ext = p.Length > 2 && p[2] == "1";
                    if (!Held(sc, ext)) return true;
                    SendKey(sc, ext, true); HeldKeys.Remove(sc | (ext ? 0x100 : 0)); return true;
                }
                case "MR": SendMouse(MOUSEEVENTF_MOVE, Clamp(I(p[1]), 3000), Clamp(I(p[2]), 3000), 0); return true;
                case "MA": Absolute(I(p[1]), I(p[2])); return true;
                case "MB":
                {
                    int b = I(p[1]); if (b < 0 || b > 4) return true;
                    bool down = p.Length > 2 && p[2] == "1";
                    if (down == HeldBtns.Contains(b)) return true;
                    SendMouse(down ? BtnDown[b] : BtnUp[b], 0, 0, b >= 3 ? (uint)(b - 2) : 0);
                    if (down) HeldBtns.Add(b); else HeldBtns.Remove(b);
                    return true;
                }
                case "MW": SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)Clamp(I(p[1]), 2400))); return true;
                case "MH": SendMouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)Clamp(I(p[1]), 2400))); return true;
            }
        }
        return true;
    }
    static int Clamp(int v, int m) { return v < -m ? -m : v > m ? m : v; }

    static void Absolute(int nx, int ny)
    {
        int l, t, w, h;
        if (target != IntPtr.Zero) { Win.RECT r; if (!Win.GetWindowRect(target, out r)) return; l = r.Left; t = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top; }
        else if (tw > 0 && th > 0) { l = tl; t = tt; w = tw; h = th; }
        else { l = 0; t = 0; w = Win.GetSystemMetrics(0); h = Win.GetSystemMetrics(1); }
        if (w < 2 || h < 2) return;
        nx = nx < 0 ? 0 : nx > 65535 ? 65535 : nx; ny = ny < 0 ? 0 : ny > 65535 ? 65535 : ny;
        double px = l + nx / 65535.0 * (w - 1), py = t + ny / 65535.0 * (h - 1);
        int vx = Win.GetSystemMetrics(76), vy = Win.GetSystemMetrics(77), vw = Win.GetSystemMetrics(78), vh = Win.GetSystemMetrics(79);
        if (vw < 2 || vh < 2) return;
        int ax = (int)Math.Round((px - vx) * 65535.0 / (vw - 1)), ay = (int)Math.Round((py - vy) * 65535.0 / (vh - 1));
        SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0);
    }

    static void Pad(string[] p)
    {
        int s = I(p[1]); if (s < 0 || s > 3 || p.Length < 9) return;
        if (client == null) return;
        if (pads[s] == null)
        {
            IXbox360Controller pad = client.CreateXbox360Controller();
            pad.AutoSubmitReport = false;
            int slot = s;
            pad.FeedbackReceived += delegate (object sender, Xbox360FeedbackReceivedEventArgs e)
            {
                int v = (e.LargeMotor << 8) | e.SmallMotor;
                if (v == fbLast[slot]) return;
                fbLast[slot] = v; Say("FB " + slot + " " + e.LargeMotor + " " + e.SmallMotor);
            };
            pad.Connect();
            pads[s] = pad;
        }
        IXbox360Controller g = pads[s];
        g.SetButtonsFull((ushort)(I(p[2]) & PAD_MASK));
        g.SetSliderValue(Xbox360Slider.LeftTrigger, (byte)Math.Max(0, Math.Min(255, I(p[3]))));
        g.SetSliderValue(Xbox360Slider.RightTrigger, (byte)Math.Max(0, Math.Min(255, I(p[4]))));
        g.SetAxisValue(Xbox360Axis.LeftThumbX, (short)Math.Max(-32768, Math.Min(32767, I(p[5]))));
        g.SetAxisValue(Xbox360Axis.LeftThumbY, (short)Math.Max(-32768, Math.Min(32767, I(p[6]))));
        g.SetAxisValue(Xbox360Axis.RightThumbX, (short)Math.Max(-32768, Math.Min(32767, I(p[7]))));
        g.SetAxisValue(Xbox360Axis.RightThumbY, (short)Math.Max(-32768, Math.Min(32767, I(p[8]))));
        g.SubmitReport();
    }
}
