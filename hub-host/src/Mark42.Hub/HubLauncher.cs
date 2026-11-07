using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mark42.Hub;

/// <summary>
/// <c>--url</c> 없이 실행됐을 때(작업 표시줄에 고정한 통합 창 단추, exe 직접 실행): 데몬에게 통합 창을 열어 달라고(<c>$/openHub</c>)
/// 부탁하고 끝나요. 데몬이 새 토큰 주소로 이 exe를 다시 띄우고, 이미 떠 있으면 그 창이 주소를 넘겨받아 앞으로 나와요.
/// <para>
/// 파이프 이름: 데몬이 <c>&lt;home&gt;\hub.json</c>에 적어 둔 <c>pipe</c>(<c>daemon/src/hubServer.ts</c> <c>saveHubPort</c>), 없으면
/// 기본 이름 <c>\\.\pipe\mark42-m42d-&lt;sha256(사용자명 \n home) 앞 12자&gt;</c>(<c>packages/protocol/src/paths.ts</c> <c>defaultPipeName</c>).
/// </para>
/// <para>
/// 이 사용자가 만든 파이프만 믿고(<see cref="PipeOptions.CurrentUserOnly"/>) Identification으로 붙어요. 보내는 건 메서드 이름뿐이고
/// 답은 성공·실패만 봐요(주소는 쓰지 않아요 — 창은 데몬이 띄워요). 그래서 <c>$/auth</c> 확인은 하지 않아요.
/// </para>
/// </summary>
internal static class HubLauncher
{
    public const string OpenHubMethod = "$/openHub";
    private const int MaxReplyBytes = 64 * 1024;
    private static readonly Regex PipePath = new(@"^[\\/]{2}\.[\\/]pipe[\\/]([A-Za-z0-9._-]{1,200})$", RegexOptions.CultureInvariant);

    public enum Result { Opened, NoDaemon, Refused }

    /// <summary><c>[]</c> 또는 <c>--home &lt;전체 경로&gt;</c>. home이 없으면 <c>MARK42_HOME</c>, 그다음 <c>%LOCALAPPDATA%\Mark42</c>(데몬 기본값과 같은 글자).</summary>
    public static bool TryParseHome(string[] args, Func<string, string?> env, out string? home, out string? error)
    {
        home = null;
        error = null;
        if (args.Length == 0)
        {
            home = DefaultHome(env);
            if (home is null) error = Strings.HomeNotFound;
            return home is not null;
        }
        if (args.Length == 2 && args[0] == "--home" && Path.IsPathFullyQualified(args[1]))
        {
            home = args[1];
            return true;
        }
        error = args.Length == 2 && args[0] == "--home" ? Strings.HomeRequired : Strings.UnknownArgument(args[0]);
        return false;
    }

    /// <summary>데몬의 <c>defaultMark42Home</c>과 같은 글자(파이프 이름 해시에 그대로 들어가요)</summary>
    internal static string? DefaultHome(Func<string, string?> env)
    {
        var h = env("MARK42_HOME");
        if (!string.IsNullOrEmpty(h)) return Path.IsPathFullyQualified(h) ? h : null;
        var local = env("LOCALAPPDATA");
        if (string.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return string.IsNullOrEmpty(local) ? null : Path.Combine(local, "Mark42");
    }

    /// <summary>데몬 파이프의 짧은 이름(<c>\\.\pipe\</c> 뒤). hub.json의 것이 규칙에 맞으면 그것, 아니면 기본 이름.</summary>
    public static string PipeNameFor(string home, string userName)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(home, "hub.json")));
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("pipe", out var p)
                && p.ValueKind == JsonValueKind.String && TryShortPipeName(p.GetString(), out var name))
                return name;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
        return DefaultPipeName(home, userName);
    }

    internal static string DefaultPipeName(string home, string userName) =>
        "mark42-m42d-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{userName}\n{home}")))[..12];

    internal static bool TryShortPipeName(string? full, out string name)
    {
        name = "";
        var m = full is null ? null : PipePath.Match(full);
        if (m is null || !m.Success) return false;
        name = m.Groups[1].Value;
        return true;
    }

    /// <summary>
    /// 데몬에 <c>$/openHub</c>를 보내고 답을 기다려요. 붙기는 <paramref name="connectMs"/> 안에, 답은 <paramref name="replyMs"/> 안에 —
    /// 로그온 직후 데몬이 뜨는 중이면 통합 창 서버가 뜰 때까지 답이 늦어요(<c>daemon/src/main.ts</c> <c>hubReady</c>).
    /// </summary>
    public static Result AskOpenHub(string pipeName, int connectMs = 3000, int replyMs = 30_000)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Identification);
            using (var connect = new CancellationTokenSource(connectMs)) pipe.ConnectAsync(connect.Token).GetAwaiter().GetResult();
            using var cts = new CancellationTokenSource(replyMs);
            var request = JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 1, method = OpenHubMethod, @params = new { } });
            pipe.WriteAsync(Encoding.UTF8.GetBytes(request + "\n"), cts.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(cts.Token).GetAwaiter().GetResult();
            return ReadReplyAsync(pipe, cts.Token).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) { return Result.NoDaemon; }
        catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException) { return Result.NoDaemon; }
    }

    /// <summary>줄 단위 JSON-RPC에서 id 1의 답을 찾아요(그 앞의 알림은 건너뛰어요).</summary>
    internal static async Task<Result> ReadReplyAsync(Stream s, CancellationToken ct)
    {
        var buf = new byte[MaxReplyBytes];
        int n = 0, start = 0;
        while (n < buf.Length)
        {
            int r = await s.ReadAsync(buf.AsMemory(n), ct).ConfigureAwait(false);
            if (r <= 0) return Result.NoDaemon;
            n += r;
            int nl;
            while ((nl = Array.IndexOf(buf, (byte)'\n', start, n - start)) >= 0)
            {
                var reply = Classify(Encoding.UTF8.GetString(buf, start, nl - start));
                if (reply is not null) return reply.Value;
                start = nl + 1;
            }
        }
        return Result.NoDaemon;
    }

    internal static Result? Classify(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("id", out var id)
                || id.ValueKind != JsonValueKind.Number || !id.TryGetInt32(out var n) || n != 1) return null;
            return root.TryGetProperty("result", out _) && !root.TryGetProperty("error", out _) ? Result.Opened : Result.Refused;
        }
        catch (JsonException) { return null; }
    }
}
