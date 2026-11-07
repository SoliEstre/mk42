using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mark42.Hub;

/// <summary>
/// 진행 창(계약 C3, <c>mk42-hub.exe --progress &lt;launch-progress.json&gt;</c>): 첫 실행 때 확장 설치·창 띄우기를 기다리는 동안
/// 무엇을 하는지 보여 주는 작은 창이에요. WebView2 없이 바로 떠요. 판단은 <see cref="ProgressTracker"/>, 여기는 그리기만.
/// 처음 뜰 때 한 번만 앞으로 나오고(그 뒤로는 포커스를 가져가지 않아요), 늘 위(TopMost)도 아니에요. «숨기기»는 이 창만 닫아요
/// (준비는 데몬이 계속해요).
/// </summary>
internal sealed class ProgressForm : Form
{
    /// <summary>창 폭(96 DPI 기준 — AutoScaleMode.Dpi가 키워요)</summary>
    public const int LogicalWidth = 380;
    private const int PadX = 16;

    private readonly string _path;
    private readonly ProgressTracker _tracker;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 250 };
    private readonly Palette _p;
    private readonly Label _title;
    private readonly (Label Glyph, Label Text, Label Detail)[] _rows = new (Label, Label, Label)[ProgressSnapshot.MaxSteps];
    private readonly Label _error;
    private readonly ProgressBar _bar;
    private readonly Button _button;
    private readonly Icon _icon;
    private int _frame;
    private ProgressPhase? _shownPhase;

    public ProgressForm(string path, ProgressTracker tracker)
    {
        _path = path;
        _tracker = tracker;
        _p = Palette.Current();
        _icon = HubIcon.CreateApp();

        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9F);
        Icon = _icon;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        TopMost = false;
        StartPosition = FormStartPosition.Manual;
        Location = Screen.PrimaryScreen!.WorkingArea.Location; // 기본 화면의 DPI로 만들어지게(가운데 맞춤은 OnLoad)
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        BackColor = _p.Back;
        ForeColor = _p.Fore;

        int content = LogicalWidth - 2 * PadX;
        var root = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            Padding = new Padding(PadX, 14, PadX, 12),
            Margin = Padding.Empty,
            MinimumSize = new Size(LogicalWidth, 0),
            MaximumSize = new Size(LogicalWidth, 0),
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        _title = new Label
        {
            AutoSize = false,
            AutoEllipsis = true,
            UseMnemonic = false,
            Dock = DockStyle.Fill,
            Height = 26,
            TextAlign = ContentAlignment.MiddleLeft,
            Font = new Font("Segoe UI Semibold", 11F),
            Margin = new Padding(0, 0, 0, 6),
        };
        root.Controls.Add(_title);

        var steps = new TableLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 3,
            RowCount = ProgressSnapshot.MaxSteps,
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
        };
        steps.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        steps.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        steps.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var glyphFont = new Font("Segoe UI Symbol", 9.75F);
        for (int i = 0; i < _rows.Length; i++)
        {
            steps.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            var glyph = new Label
            {
                AutoSize = false, Size = new Size(22, 22), Margin = Padding.Empty, UseMnemonic = false,
                TextAlign = ContentAlignment.MiddleLeft, Font = glyphFont, Visible = false,
            };
            var text = new Label
            {
                AutoSize = false, AutoEllipsis = true, Dock = DockStyle.Fill, Height = 22, Margin = Padding.Empty, UseMnemonic = false,
                TextAlign = ContentAlignment.MiddleLeft, Visible = false,
            };
            var detail = new Label
            {
                AutoSize = true, Anchor = AnchorStyles.Right, Margin = new Padding(8, 0, 0, 0), UseMnemonic = false,
                MaximumSize = new Size(150, 22), ForeColor = _p.Dim, Visible = false,
            };
            steps.Controls.Add(glyph, 0, i);
            steps.Controls.Add(text, 1, i);
            steps.Controls.Add(detail, 2, i);
            _rows[i] = (glyph, text, detail);
        }
        root.Controls.Add(steps);

        _error = new Label
        {
            AutoSize = true, MaximumSize = new Size(content, 0), Margin = new Padding(0, 8, 0, 0), UseMnemonic = false,
            ForeColor = _p.Fail, Visible = false,
        };
        root.Controls.Add(_error);

        _bar = new ProgressBar
        {
            Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 30, Dock = DockStyle.Fill, Height = 6,
            Margin = new Padding(0, 12, 0, 0),
        };
        root.Controls.Add(_bar);

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0),
        };
        _button = new Button { AutoSize = true, MinimumSize = new Size(88, 28), Margin = Padding.Empty, UseMnemonic = false };
        if (_p.Dark)
        {
            _button.FlatStyle = FlatStyle.Flat;
            _button.BackColor = _p.ButtonBack;
            _button.ForeColor = _p.Fore;
            _button.FlatAppearance.BorderColor = _p.ButtonBorder;
        }
        else _button.FlatStyle = FlatStyle.System;
        _button.Click += (_, _) => Close();
        buttons.Controls.Add(_button);
        root.Controls.Add(buttons);
        CancelButton = _button;

        Controls.Add(root);
        ResumeLayout(false);
        PerformLayout();

        _timer.Tick += (_, _) => OnTick();
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        Render();
        PerformLayout();
        var wa = Screen.PrimaryScreen!.WorkingArea;
        Location = new Point(wa.X + Math.Max(0, (wa.Width - Width) / 2), wa.Y + Math.Max(0, (wa.Height - Height) / 2));
        _timer.Start();
    }

    /// <summary>제목 표시줄: 다른 Mk42 창과 같은 빨간 판 + 금색 글자(HubForm). 어두운 테마면 테두리 등도 어둡게.</summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int dark = _p.Dark ? 1 : 0;
        DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        if (SystemInformation.HighContrast) return;
        int caption = HubForm.ColorRef(0x7a, 0x10, 0x18), text = HubForm.ColorRef(0xf7, 0xcd, 0x5c);
        DwmSetWindowAttribute(Handle, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_BORDER_COLOR, ref caption, sizeof(int));
        DwmSetWindowAttribute(Handle, DWMWA_TEXT_COLOR, ref text, sizeof(int));
    }

    private void OnTick()
    {
        var tick = _tracker.Step(ProgressFile.Read(_path), DateTimeOffset.UtcNow);
        _frame++;
        if (tick.Close)
        {
            _timer.Stop();
            Close();
            return;
        }
        if (tick.Changed || tick.Phase != _shownPhase) Render();
        else Spin();
    }

    private void Render()
    {
        var s = _tracker.Current;
        var phase = _tracker.Phase;
        bool ko = Strings.IsKoreanLang(s?.Lang);
        var title = s?.Title ?? Strings.ProgressTitle(ko);
        SetText(this, title);
        SetText(_title, title);
        var steps = s?.Steps ?? [];
        for (int i = 0; i < _rows.Length; i++)
        {
            var (glyph, text, detail) = _rows[i];
            bool show = i < steps.Count;
            if (show)
            {
                var step = steps[i];
                SetText(glyph, ProgressSnapshot.Glyph(step.State, _frame));
                glyph.ForeColor = GlyphColor(step.State);
                SetText(text, step.Label);
                text.ForeColor = step.State is ProgressStepState.Pending or ProgressStepState.Skipped ? _p.Dim : _p.Fore;
                SetText(detail, step.Detail ?? "");
            }
            glyph.Visible = show;
            text.Visible = show;
            detail.Visible = show && i < steps.Count && steps[i].Detail is not null;
        }
        SetText(_error, s?.Error ?? "");
        _error.Visible = s?.Error is not null;
        if (phase == ProgressPhase.Failed) _bar.Visible = false;
        else
        {
            _bar.Visible = true;
            if (phase == ProgressPhase.Finished)
            {
                _bar.Style = ProgressBarStyle.Continuous;
                _bar.Value = _bar.Maximum;
            }
            else if (_bar.Style != ProgressBarStyle.Marquee) _bar.Style = ProgressBarStyle.Marquee;
        }
        SetText(_button, phase == ProgressPhase.Failed ? Strings.ProgressClose(ko) : Strings.ProgressHide(ko));
        _shownPhase = phase;
    }

    /// <summary>진행 중 줄의 머리 표시만 돌려요</summary>
    private void Spin()
    {
        var steps = _tracker.Current?.Steps;
        if (steps is null) return;
        for (int i = 0; i < steps.Count && i < _rows.Length; i++)
            if (steps[i].State == ProgressStepState.Running) SetText(_rows[i].Glyph, ProgressSnapshot.Glyph(ProgressStepState.Running, _frame));
    }

    private Color GlyphColor(ProgressStepState state) => state switch
    {
        ProgressStepState.Running => _p.Accent,
        ProgressStepState.Done => _p.Ok,
        ProgressStepState.Failed => _p.Fail,
        _ => _p.Dim,
    };

    private static void SetText(Control c, string text)
    {
        if (c.Text != text) c.Text = text;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _icon.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>시스템 앱 테마(어두움/밝음)를 따르는 색. 고대비면 시스템 색 그대로.</summary>
    private sealed record Palette(bool Dark, Color Back, Color Fore, Color Dim, Color Accent, Color Ok, Color Fail, Color ButtonBack, Color ButtonBorder)
    {
        public static Palette Current()
        {
            if (SystemInformation.HighContrast)
                return new(false, SystemColors.Control, SystemColors.ControlText, SystemColors.GrayText, SystemColors.Highlight,
                    SystemColors.ControlText, SystemColors.ControlText, SystemColors.Control, SystemColors.ControlDark);
            if (AppsUseDarkTheme())
                return new(true, Color.FromArgb(32, 32, 32), Color.FromArgb(242, 242, 242), Color.FromArgb(160, 160, 160),
                    Color.FromArgb(247, 205, 92), Color.FromArgb(108, 203, 95), Color.FromArgb(255, 107, 107),
                    Color.FromArgb(51, 51, 51), Color.FromArgb(96, 96, 96));
            return new(false, SystemColors.Control, SystemColors.ControlText, SystemColors.GrayText, Color.FromArgb(122, 16, 24),
                Color.FromArgb(15, 123, 15), Color.FromArgb(196, 43, 28), SystemColors.Control, SystemColors.ControlDark);
        }

        private static bool AppsUseDarkTheme()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
                return key?.GetValue("AppsUseLightTheme") is int v && v == 0;
            }
            catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException) { return false; }
        }
    }

    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_BORDER_COLOR = 34, DWMWA_CAPTION_COLOR = 35, DWMWA_TEXT_COLOR = 36;
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(nint hwnd, int attr, ref int value, int size);
}
