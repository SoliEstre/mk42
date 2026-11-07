using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Mark42.Hub;

/// <summary>
/// 통합 창 하나: WebView2(사용자 데이터 <c>&lt;home&gt;\hub-webview2</c> — Edge 프로필·계정과 무관)에 데몬의 통합 창 화면을 띄워요.
/// 이 창 안에서는 그 화면의 출처(같은 포트의 127.0.0.1)만 열고, 다른 http(s) 링크는 기본 브라우저로 넘기고, 나머지는 막아요.
/// 화면이 <c>window.close()</c>를 부르면(더 새 통합 창에 밀림 4409, 데몬이 다시 떠서 토큰이 지남 4401) 창을 닫아요.
/// </summary>
internal sealed class HubForm : Form
{
    /// <summary>창 제목(작업 표시줄·Alt+Tab에서 한 이름) — UI 언어를 따라요(<see cref="Strings.HubTitle"/>)</summary>
    public static string Title => Strings.HubTitle;
    public const string WebViewFolderName = "hub-webview2";

    private readonly string _home;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly object _gate = new();
    private Uri _hub;
    private Uri? _pending;      // 창이 준비되기 전에 넘어온 주소(가장 마지막 것)
    private bool _ready;
    private volatile bool _closing;

    public HubForm(HubArgs args)
    {
        _home = args.Home;
        _hub = args.Url;
        Text = Title;
        Icon = HubIcon.Create();
        MinimumSize = HubPlacement.MinSize;
        StartPosition = FormStartPosition.Manual;
        var saved = HubPlacement.Load(_home);
        Bounds = HubPlacement.Fit(saved, Screen.AllScreens.Select(s => s.WorkingArea).ToList(), Screen.PrimaryScreen!.WorkingArea);
        if (saved?.Maximized == true) WindowState = FormWindowState.Maximized;
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
        Shown += (_, _) => HubHostMarker.Write(_home);
        FormClosing += (_, _) =>
        {
            _closing = true;
            SavePlacement();
        };
        FormClosed += (_, _) => HubHostMarker.Delete(_home);
    }

    /// <summary>
    /// 제목 표시줄을 Mk42 색으로(VS Code Mark42 창과 같은 빨간 판 #7a1018 + 금색 글자 #f7cd5c, daemon MK42_COLORS). Windows 11
    /// DWM 속성이라 그 전 버전에서는 조용히 무시돼요.
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int caption = ColorRef(0x7a, 0x10, 0x18), text = ColorRef(0xf7, 0xcd, 0x5c);
        DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref caption, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref text, sizeof(int));
    }

    /// <summary>COLORREF = 0x00BBGGRR</summary>
    internal static int ColorRef(int r, int g, int b) => r | (g << 8) | (b << 16);

    private const int DWMWA_BORDER_COLOR = 34, DWMWA_CAPTION_COLOR = 35, DWMWA_TEXT_COLOR = 36;
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);

    /// <summary>창이 닫히기 시작하면(이 뒤로 넘어온 주소는 받지 않아요)</summary>
    public bool Closing => _closing;

    private async Task InitAsync()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_home, WebViewFolderName));
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or COMException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            MessageBox.Show(this, Strings.WebViewFailed(ex.Message), Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            Close();
            return;
        }
        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.NavigationStarting += (_, e) =>
        {
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target)) { e.Cancel = true; return; }
            if (HubUrl.SameOrigin(_hub, target)) return;
            e.Cancel = true;
            if (HubUrl.IsExternalWebLink(target)) OpenExternal(target);
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) && HubUrl.IsExternalWebLink(target)) OpenExternal(target);
        };
        // 폴더 선택(통합 창 «폴더 등록»·클론 위치): 화면에 기능 표시를 넣고, 같은 출처에서 온 요청에만 대화상자를 띄워 답해요
        try { await core.AddScriptToExecuteOnDocumentCreatedAsync(HostBridge.MarkerScript); }
        catch (Exception ex) when (ex is COMException or InvalidOperationException) { }
        core.WebMessageReceived += (_, e) => OnWebMessage(core, e);
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.WindowCloseRequested += (_, _) => BeginInvoke(Close);
        // 제목은 늘 «Mk42 통합 창»/«Mk42 Hub»(작업 표시줄·Alt+Tab에서 한 이름)
        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                // WebView2 전체가 죽음: 이 창은 더 쓸 수 없어요. 닫고 다음 «통합 창 열기»에서 새로 떠요.
                _ready = false;
                BeginInvoke(Close);
            }
            else if (e.ProcessFailedKind is CoreWebView2ProcessFailedKind.RenderProcessExited or CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                BeginInvoke(() => { try { _web.CoreWebView2?.Reload(); } catch (Exception ex) when (ex is COMException or InvalidOperationException) { } });
            }
        };
        Uri start;
        lock (_gate)
        {
            start = _pending ?? _hub;
            _pending = null;
            _hub = start;
            _ready = true;
        }
        Go(start);
    }

    /// <summary>
    /// 다음 실행이 넘긴 주소(<see cref="HubInstance"/>, 받는 스레드에서 불려요): 그 주소로 다시 불러오고 창을 앞으로. 닫히는 중이면 false
    /// (보낸 쪽이 새 창을 띄워요).
    /// </summary>
    public bool ShowUrl(Uri url)
    {
        if (_closing || IsDisposed) return false;
        lock (_gate)
        {
            if (!_ready)
            {
                _pending = url; // InitAsync가 이걸로 시작해요
                if (!IsHandleCreated) return true;
            }
        }
        try
        {
            BeginInvoke(() =>
            {
                if (_closing || IsDisposed) return;
                bool ready;
                lock (_gate)
                {
                    ready = _ready;
                    if (ready) _hub = url;
                }
                if (ready) Go(url);
                BringToFront(this);
            });
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            return false;
        }
    }

    /// <summary>
    /// 주소로 불러와요. 해시(<c>#token=…&amp;w=…</c>)만 다른 같은 문서면 Navigate는 hashchange뿐이라 화면이 옛 토큰·창 번호를 계속
    /// 써요 — 그때는 주소를 바꾸고 다시 불러와요(기록은 한 칸 그대로라 <c>window.close()</c>가 계속 돼요).
    /// </summary>
    private void Go(Uri url)
    {
        try
        {
            var core = _web.CoreWebView2;
            if (core is null) return;
            if (Uri.TryCreate(core.Source, UriKind.Absolute, out var current) && HubUrl.SameDocument(current, url))
                _ = core.ExecuteScriptAsync($"location.replace({JsonSerializer.Serialize(url.OriginalString)});location.reload();");
            else
                core.Navigate(url.OriginalString);
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException or ArgumentException) { }
    }

    /// <summary>
    /// 앞으로 가져와요. 띄운 쪽(데몬)이 앞 창 권한이 없어서 그냥 SetForegroundWindow는 막혀요 — 지금 앞 창의 입력 스레드에 잠깐 붙어서
    /// 가져와요(HPP 클라이언트 TaskbarHotkey와 같은 방법). 그래도 안 되면 작업 표시줄 단추가 깜박여요.
    /// </summary>
    private static void BringToFront(Form f)
    {
        if (f.WindowState == FormWindowState.Minimized) f.WindowState = FormWindowState.Normal;
        f.Show();
        nint target = f.Handle, fg = GetForegroundWindow();
        uint fgThread = fg == 0 ? 0 : GetWindowThreadProcessId(fg, out _), me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        try
        {
            BringWindowToTop(target);
            SetForegroundWindow(target);
        }
        finally
        {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
        f.Activate();
    }

    private bool _picking;

    /// <summary>화면의 폴더 선택 요청(<see cref="HostBridge"/>): 통합 창 출처에서 온 것만, 한 번에 하나.</summary>
    private void OnWebMessage(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out var source) || !HubUrl.SameOrigin(_hub, source)) return;
        string json;
        try { json = e.WebMessageAsJson; }
        catch (ArgumentException) { return; }
        if (HostBridge.ParsePickFolder(json) is not { } req) return;
        if (_picking) { Reply(null); return; }
        _picking = true;
        BeginInvoke(() =>
        {
            string? path = null;
            try
            {
                using var dlg = new FolderBrowserDialog
                {
                    Description = req.Title,
                    UseDescriptionForTitle = true,
                    ShowNewFolderButton = true,
                };
                // 네트워크 경로는 확인하지 않고 넘겨요(닿지 않는 서버면 확인만으로 창이 멈춰요 — 대화상자가 알아서 처리)
                if (req.Initial is { } init && (init.StartsWith(@"\\", StringComparison.Ordinal) || Directory.Exists(init))) dlg.InitialDirectory = init;
                if (dlg.ShowDialog(this) == DialogResult.OK && Path.IsPathFullyQualified(dlg.SelectedPath)) path = dlg.SelectedPath;
            }
            finally
            {
                _picking = false;
                Reply(path);
            }
        });

        void Reply(string? path)
        {
            try { core.PostWebMessageAsJson(HostBridge.PickFolderResult(req.Id, path)); }
            catch (Exception ex) when (ex is COMException or InvalidOperationException or ArgumentException) { }
        }
    }

    private static void OpenExternal(Uri target)
    {
        try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException) { }
    }

    private void SavePlacement()
    {
        var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        new HubPlacement(r.X, r.Y, r.Width, r.Height, WindowState == FormWindowState.Maximized).Save(_home);
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
}
