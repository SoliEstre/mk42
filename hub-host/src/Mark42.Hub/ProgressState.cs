using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Mark42.Hub;

/// <summary>진행 창 한 줄의 상태(계약 C3 <c>steps[].state</c>). 모르는 값은 <see cref="Pending"/>.</summary>
internal enum ProgressStepState { Pending, Running, Done, Failed, Skipped }

internal sealed record ProgressStep(string Id, string Label, ProgressStepState State, string? Detail);

/// <summary>
/// 데몬이 쓰는 <c>&lt;home&gt;\run\launch-progress.json</c>(계약 C3) 한 판:
/// <c>{schema:1, id, updatedAt, lang, title, steps:[{id,label,state,detail?}], done, error}</c>.
/// 모르는 칸은 무시하고, 글은 길이를 잘라요(창이 작아요).
/// </summary>
internal sealed record ProgressSnapshot(
    string? Id, DateTimeOffset? UpdatedAt, string? Lang, string? Title, IReadOnlyList<ProgressStep> Steps, bool Done, string? Error)
{
    public const int MaxSteps = 12;
    public const int MaxTitleLength = 120;
    public const int MaxLabelLength = 120;
    public const int MaxDetailLength = 32;
    public const int MaxErrorLength = 500;

    /// <summary>한 판으로 읽혀요(덜 쓰인 JSON·객체가 아님·schema가 숫자가 아님이면 null — 부르는 쪽은 마지막 좋은 판을 그대로 둬요)</summary>
    public static ProgressSnapshot? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (root.TryGetProperty("schema", out var schema)
                && (schema.ValueKind != JsonValueKind.Number || !schema.TryGetInt32(out var v) || v < 1)) return null;
            DateTimeOffset? updatedAt = null;
            if (Str(root, "updatedAt") is { } u
                && DateTimeOffset.TryParse(u, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at)) updatedAt = at;
            var steps = new List<ProgressStep>();
            if (root.TryGetProperty("steps", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                int index = 0;
                foreach (var s in arr.EnumerateArray())
                {
                    if (steps.Count >= MaxSteps) break;
                    index++;
                    if (s.ValueKind != JsonValueKind.Object) continue;
                    var id = Str(s, "id") ?? $"#{index}";
                    var label = Clip(Str(s, "label"), MaxLabelLength) ?? id;
                    steps.Add(new ProgressStep(id, label, ParseState(Str(s, "state")), Clip(Str(s, "detail"), MaxDetailLength)));
                }
            }
            bool done = root.TryGetProperty("done", out var d) && d.ValueKind == JsonValueKind.True;
            return new ProgressSnapshot(Str(root, "id"), updatedAt, Str(root, "lang"), Clip(Str(root, "title"), MaxTitleLength),
                steps, done, Clip(Str(root, "error"), MaxErrorLength));
        }
        catch (JsonException) { return null; }
    }

    internal static ProgressStepState ParseState(string? s) => s switch
    {
        "running" => ProgressStepState.Running,
        "done" => ProgressStepState.Done,
        "failed" => ProgressStepState.Failed,
        "skipped" => ProgressStepState.Skipped,
        _ => ProgressStepState.Pending,
    };

    private static string? Str(JsonElement o, string name) =>
        o.TryGetProperty(name, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;

    /// <summary>앞뒤 공백·줄바꿈을 정리하고 잘라요. 비면 null.</summary>
    internal static string? Clip(string? s, int max)
    {
        if (s is null) return null;
        s = string.Join(' ', s.Split(['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        if (s.Length == 0) return null;
        return s.Length <= max ? s : s[..(max - 1)] + "…";
    }

    /// <summary>줄 머리 표시: 대기 ○, 진행 중 ◐◓◑◒(돌아가요), 끝 ✓, 실패 ✕, 건너뜀 –</summary>
    public static string Glyph(ProgressStepState state, int frame) => state switch
    {
        ProgressStepState.Running => SpinnerFrames[(frame % SpinnerFrames.Length + SpinnerFrames.Length) % SpinnerFrames.Length],
        ProgressStepState.Done => "✓",
        ProgressStepState.Failed => "✕",
        ProgressStepState.Skipped => "–",
        _ => "○",
    };

    internal static readonly string[] SpinnerFrames = ["◐", "◓", "◑", "◒"];
}

internal enum ProgressReadKind { Missing, Unreadable, Text }

internal readonly record struct ProgressRead(ProgressReadKind Kind, string? Text = null);

/// <summary>진행 파일 읽기·인자·창 하나 표식</summary>
internal static class ProgressFile
{
    public const int MaxBytes = 256 * 1024;

    /// <summary><c>--progress &lt;전체 경로 .json&gt;</c> 그대로 둘뿐이어야 해요</summary>
    public static bool TryParseArgs(string[] args, out string path)
    {
        path = "";
        if (args.Length != 2 || args[0] != Program.ProgressArgument) return false;
        var p = args[1];
        if (!Path.IsPathFullyQualified(p) || !p.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) return false;
        try { path = Path.GetFullPath(p); }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException) { return false; }
        return true;
    }

    /// <summary>파일마다 하나: <c>Mk42.Progress.&lt;sha1(전체 경로 소문자)&gt;</c>(앞에 <c>Local\</c>를 붙여 써요)</summary>
    public static string MutexName(string path) =>
        "Mk42.Progress." + Convert.ToHexStringLower(SHA1.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToLowerInvariant())));

    /// <summary>
    /// 데몬이 쓰는 중이어도 읽히게(<see cref="FileShare.ReadWrite"/>|<see cref="FileShare.Delete"/>) 읽어요. 없으면 Missing,
    /// 잠겨 있거나 지워지는 중·너무 크면 Unreadable(부르는 쪽은 마지막 판을 그대로 둬요).
    /// </summary>
    public static ProgressRead Read(string path)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var ms = new MemoryStream();
            var buf = new byte[16 * 1024];
            int r;
            while ((r = fs.Read(buf, 0, buf.Length)) > 0)
            {
                ms.Write(buf, 0, r);
                if (ms.Length > MaxBytes) return new ProgressRead(ProgressReadKind.Unreadable);
            }
            var bytes = ms.GetBuffer().AsSpan(0, (int)ms.Length);
            if (bytes.StartsWith((ReadOnlySpan<byte>)[0xEF, 0xBB, 0xBF])) bytes = bytes[3..];
            return new ProgressRead(ProgressReadKind.Text, Encoding.UTF8.GetString(bytes));
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return new ProgressRead(ProgressReadKind.Missing);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new ProgressRead(ProgressReadKind.Unreadable);
        }
    }
}

/// <summary>
/// 창이 보여 줄 단계: 아직 판 없음, 진행 중, 끝(곧 닫힘), 실패(사용자가 닫을 때까지 남아요), 사라짐(바로 닫힘).
/// </summary>
internal enum ProgressPhase { Waiting, Active, Finished, Failed, Gone }

/// <param name="Changed">새 판을 읽었어요(다시 그려요)</param>
/// <param name="Close">지금 닫아요</param>
internal readonly record struct ProgressTick(ProgressPhase Phase, bool Changed, bool Close);

/// <summary>
/// 진행 창의 판단(화면 없음 — 테스트해요). 250 ms마다 <see cref="Step"/>에 읽은 결과를 넣어요.
/// <list type="bullet">
/// <item>덜 쓰인 JSON·잠김: 마지막 좋은 판을 그대로 둬요.</item>
/// <item><c>done</c>이고 오류 없음: <see cref="CloseDelay"/> 뒤 닫혀요(그 사이 새 실행이 done:false로 다시 쓰면 이어요).</item>
/// <item><c>done</c>이고 <c>error</c>: 오류를 보여요 — <see cref="FailedAutoClose"/> 뒤, 또는 파일이 사라지거나 오래되면 닫혀요
///   (검토 2026-11-05: 계속 실패하는 상태면 띄울 때마다 창이 남지 않게). 새 판이 오면 따라가요.</item>
/// <item>파일이 사라짐(<see cref="MissingPollsToClose"/>번 이어서 — 지우고 다시 쓰는 틈은 넘겨요)·<c>updatedAt</c>이
///   <see cref="StaleAfter"/>보다 오래됨(데몬이 멈춤)·처음 판을 <see cref="FirstStateTimeout"/> 안에 못 읽음: 바로 닫혀요.</item>
/// </list>
/// </summary>
internal sealed class ProgressTracker(DateTimeOffset started)
{
    public static readonly TimeSpan CloseDelay = TimeSpan.FromMilliseconds(800);
    public static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan FirstStateTimeout = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan FailedAutoClose = TimeSpan.FromSeconds(30);
    public const int MissingPollsToClose = 2;

    private string? _lastText;
    private readonly DateTimeOffset _started = started;
    private DateTimeOffset _lastChange = started;
    private DateTimeOffset? _doneSince;
    private DateTimeOffset? _failedSince;
    private int _missing;

    public ProgressSnapshot? Current { get; private set; }
    public ProgressPhase Phase { get; private set; } = ProgressPhase.Waiting;

    public ProgressTick Step(ProgressRead read, DateTimeOffset now)
    {
        bool changed = false;
        _missing = read.Kind == ProgressReadKind.Missing ? _missing + 1 : 0;
        if (read is { Kind: ProgressReadKind.Text, Text: { } text } && text != _lastText && ProgressSnapshot.Parse(text) is { } snap)
        {
            _lastText = text;
            _lastChange = now;
            Current = snap;
            changed = true;
        }
        bool gone = _missing >= MissingPollsToClose;
        if (Current is null) Phase = gone || now - _started >= FirstStateTimeout ? ProgressPhase.Gone : ProgressPhase.Waiting;
        else if (gone || now - (Current.UpdatedAt ?? _lastChange) > StaleAfter) Phase = ProgressPhase.Gone;
        else if (Current.Done && Current.Error is not null) Phase = ProgressPhase.Failed;
        else if (Current.Done) Phase = ProgressPhase.Finished;
        else Phase = ProgressPhase.Active;

        if (Phase == ProgressPhase.Finished) _doneSince ??= now;
        else _doneSince = null;
        if (Phase == ProgressPhase.Failed) _failedSince ??= now;
        else _failedSince = null;
        bool close = Phase == ProgressPhase.Gone
            || (Phase == ProgressPhase.Finished && now - _doneSince >= CloseDelay)
            || (Phase == ProgressPhase.Failed && now - _failedSince >= FailedAutoClose);
        return new ProgressTick(Phase, changed, close);
    }
}
