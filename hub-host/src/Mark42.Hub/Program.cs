using System.Runtime.InteropServices;

namespace Mark42.Hub;

internal static partial class Program
{
    /// <summary>작업 표시줄에서 Mk42 앱 창·브라우저 창과 따로 묶이는 통합 창 ID</summary>
    public const string AppUserModelId = "Mark42.Mk42.Hub";

    /// <summary>종료 코드: 0 띄움·넘김, 1 넘기지도 띄우지도 못함, 2 인자 잘못, 3 다른 계정이 이름을 쥠</summary>
    public const int BlockedExitCode = 3;

    [STAThread]
    private static int Main(string[] args)
    {
        // 판 덧층의 창 없는 명령(있으면 여기서 끝나요). 덧층이 없는 판에서는 이 호출이 컴파일되지 않아요
        int? overlayExit = null;
        RunOverlayCommand(args, ref overlayExit);
        if (overlayExit is int code) return code;

        // 데몬이 준비 중(확장 설치 등)일 때 띄우는 작은 진행 창: 통합 창과 다른 작업 표시줄 묶음으로 따로 떠요
        bool progress = args.Length > 0 && args[0] == ProgressArgument;
        SetCurrentProcessExplicitAppUserModelID(progress ? ProgressAppUserModelId : AppUserModelId);
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (progress) return RunProgress(args);

        // 주소 없이(작업 표시줄에 고정한 단추 등): 데몬에게 열어 달라고 부탁해요
        if (!args.Contains(HubArgs.UrlArgument)) return AskDaemon(args);

        if (!HubArgs.TryParse(args, out var a, out var error))
        {
            MessageBox.Show($"{error}\n\n{Strings.HubOpenedByDaemon}", HubForm.Title,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
        }

        try
        {
            // home마다 하나: 이미 떠 있으면 주소만 넘기고(받았다는 답까지) 끝나요. 막 닫히는 중이라 답이 없으면 잠깐 뒤 다시 잡아 봐요.
            for (int attempt = 0; attempt < 4; attempt++)
            {
                using var instance = HubInstance.TryAcquire(a!.Home);
                if (instance is null)
                {
                    if (HubInstance.Forward(a.Home, a.Url)) return 0;
                    Thread.Sleep(500);
                    continue;
                }
                using var form = new HubForm(a);
                instance.Listen(form.ShowUrl);
                form.FormClosing += (_, _) => instance.StopListening();
                Application.Run(form);
                return 0;
            }
            return 1;
        }
        catch (HubBlockedException)
        {
            MessageBox.Show(Strings.HubBlocked, HubForm.Title,
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return BlockedExitCode;
        }
    }

    /// <summary>종료 코드: 0 데몬이 받음, 1 데몬에 닿지 못함·거절, 2 인자 잘못</summary>
    private static int AskDaemon(string[] args)
    {
        if (!HubLauncher.TryParseHome(args, Environment.GetEnvironmentVariable, out var home, out var error))
        {
            MessageBox.Show(error, HubForm.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
        }
        var result = HubLauncher.AskOpenHub(HubLauncher.PipeNameFor(home!, Environment.UserName));
        if (result == HubLauncher.Result.Opened) return 0;
        MessageBox.Show(result == HubLauncher.Result.NoDaemon
                ? Strings.NoDaemon
                : Strings.DaemonRefused,
            HubForm.Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 1;
    }

    public const string ProgressArgument = "--progress";

    /// <summary>진행 창의 작업 표시줄 ID(통합 창 단추에 묶이지 않게)</summary>
    public const string ProgressAppUserModelId = "Mark42.Mk42.Progress";

    /// <summary>
    /// <c>--progress &lt;launch-progress.json 전체 경로&gt;</c>(계약 C3): 그 파일을 보여 주는 작은 창. 파일마다 하나만 떠요(두 번째 실행은
    /// 바로 0으로 끝나요). 처음 읽을 때 파일이 없거나 이미 끝났으면(오류 없이) 창 없이 끝나요. 0 정상, 2 인자 잘못, 3 다른 계정이 이름을 쥠.
    /// </summary>
    internal static int RunProgress(string[] args)
    {
        if (!ProgressFile.TryParseArgs(args, out var path)) return 2;
        Mutex mutex;
        bool createdNew;
        try { mutex = new Mutex(initiallyOwned: false, @"Local\" + ProgressFile.MutexName(path), out createdNew); }
        catch (Exception ex) when (ex is UnauthorizedAccessException or WaitHandleCannotBeOpenedException) { return BlockedExitCode; }
        using (mutex)
        {
            if (!createdNew) return 0;
            var read = ProgressFile.Read(path);
            if (read.Kind == ProgressReadKind.Missing) return 0; // 벌써 끝나 지워졌어요
            var tracker = new ProgressTracker(DateTimeOffset.UtcNow);
            var first = tracker.Step(read, DateTimeOffset.UtcNow);
            if (first.Close || first.Phase is ProgressPhase.Finished) return 0;
            using var form = new ProgressForm(path, tracker);
            Application.Run(form);
            return 0;
        }
    }

    /// <summary>판 덧층의 창 없는 명령 — 처리했으면 <paramref name="exitCode"/>를 채워요(구현이 없으면 아무 일도 없어요)</summary>
    static partial void RunOverlayCommand(string[] args, ref int? exitCode);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
}
