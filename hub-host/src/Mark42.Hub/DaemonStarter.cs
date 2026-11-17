using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mark42.Hub;

/// <summary>
/// 통합 창 단추를 눌렀는데 데몬 파이프가 아예 없을 때(로그온 작업이 안 돌았거나 데몬이 꺼진 뒤) 데몬을 직접 띄워요 —
/// 설치 엔진 <c>daemon/src/setup/main.ts</c> <c>startDaemon</c>과 같은 명령: <c>&lt;home&gt;\runtime\node-&lt;v&gt;\node.exe
/// &lt;home&gt;\daemon\&lt;v&gt;\daemon\dist\mk42d.mjs --home &lt;home&gt; --pipe &lt;pipe&gt;</c>(<c>--boot</c> 없이 — 부팅 재개는 하지 않아요).
/// <para>
/// 경로는 <c>install.json</c>의 경로 문자열을 믿지 않고 판(version)으로 home 안에서 다시 만들어요(<c>daemon/src/setup/plan.ts</c> <c>targetFor</c>).
/// 파이프가 있는데 답이 없으면(데몬이 바쁘거나 멈춤) 새로 띄우지 않아요 — 같은 이름을 두 데몬이 다툴 뿐이라서요.
/// </para>
/// </summary>
internal static class DaemonStarter
{
    public sealed record Plan(string Node, string Entry, string Home, string PipeName);

    private static readonly Regex SafeVersion = new(@"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$", RegexOptions.CultureInvariant);

    /// <summary><c>&lt;home&gt;\install.json</c>의 runtime·daemon 판과 pipe로 띄울 명령을 만들어요. 설치 기록이 없거나(개발 실행) 모양이 틀리면 null.</summary>
    public static Plan? ReadPlan(string home)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(home, "install.json")));
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("components", out var comps) || comps.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("pipe", out var pipeEl) || pipeEl.ValueKind != JsonValueKind.String
                || !HubLauncher.TryShortPipeName(pipeEl.GetString(), out var pipe))
                return null;
            var runtime = VersionOf(comps, "runtime");
            var daemon = VersionOf(comps, "daemon");
            if (runtime is null || daemon is null) return null;
            var node = Path.Combine(home, "runtime", $"node-{runtime}", "node.exe");
            var entry = Path.Combine(home, "daemon", daemon, "daemon", "dist", "mk42d.mjs");
            return File.Exists(node) && File.Exists(entry) ? new Plan(node, entry, home, pipe) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    private static string? VersionOf(JsonElement comps, string name)
    {
        if (!comps.TryGetProperty(name, out var c) || c.ValueKind != JsonValueKind.Object) return null;
        if (!c.TryGetProperty("version", out var v) || v.ValueKind != JsonValueKind.String) return null;
        var s = v.GetString();
        return s is not null && SafeVersion.IsMatch(s) ? s : null;
    }

    /// <summary>이 이름의 파이프가 지금 있는지 — 목록만 봐요(<c>File.Exists</c>는 파이프에 붙었다 끊어서 데몬 쪽에 빈 연결을 남겨요)</summary>
    public static bool PipeExists(string shortName)
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(@"\\.\pipe\"))
                if (string.Equals(Path.GetFileName(f), shortName, StringComparison.OrdinalIgnoreCase)) return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return false;
    }

    public static ProcessStartInfo StartInfo(Plan p)
    {
        var psi = new ProcessStartInfo(p.Node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = p.Home,   // 설치 엔진처럼 home — 다른 폴더를 붙잡지 않게
        };
        foreach (var a in new[] { p.Entry, "--home", p.Home, "--pipe", @"\\.\pipe\" + p.PipeName }) psi.ArgumentList.Add(a);
        // 엔진의 daemonEnv()와 같이: 데몬은 인자로 받은 home·pipe만 써요. ELECTRON_RUN_AS_NODE도 물려주지 않아요
        psi.Environment.Remove("MARK42_HOME");
        psi.Environment.Remove("MARK42_PIPE");
        psi.Environment.Remove("ELECTRON_RUN_AS_NODE");
        return psi;
    }

    public enum Outcome { Opened, NotInstalled, Unresponsive, Failed, Refused }

    /// <summary>
    /// 파이프가 없을 때만 데몬을 띄우고, 파이프가 생기면 통합 창을 부탁해요(최대 <paramref name="waitMs"/>).
    /// 띄운 데몬이 그 사이 끝나면(번들 깨짐 등) 바로 Failed.
    /// </summary>
    public static Outcome StartAndOpenHub(string home, string pipeName, int waitMs = 30_000)
    {
        if (PipeExists(pipeName)) return Outcome.Unresponsive;
        var plan = ReadPlan(home);
        if (plan is null) return Outcome.NotInstalled;
        Process? child;
        try { child = Process.Start(StartInfo(plan)); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException) { return Outcome.Failed; }
        if (child is null) return Outcome.Failed;
        using (child)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < waitMs)
            {
                if (PipeExists(plan.PipeName))
                {
                    // 데몬은 통합 창 서버가 뜰 때까지 $/openHub 답을 미뤄요(hubReady) — 답 기다림은 남은 시간만큼
                    var left = (int)Math.Max(5_000, waitMs - sw.ElapsedMilliseconds);
                    return HubLauncher.AskOpenHub(plan.PipeName, 3000, left) switch
                    {
                        HubLauncher.Result.Opened => Outcome.Opened,
                        HubLauncher.Result.Refused => Outcome.Refused,
                        _ => Outcome.Failed,
                    };
                }
                // 같이 누른 다른 통합 창 단추가 먼저 띄운 데몬이 파이프를 잡으면 이 데몬은 «already running»으로 끝나요 — 파이프가 곧 보여요
                if (child.HasExited && sw.ElapsedMilliseconds > 3000 && !PipeExists(plan.PipeName)) return Outcome.Failed;
                Thread.Sleep(250);
            }
        }
        return Outcome.Failed;
    }
}
