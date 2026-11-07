using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Mark42.Hub;

/// <summary>
/// 통합 창은 home마다 하나: 이름 있는 뮤텍스 <c>Local\Mark42.Hub.&lt;h&gt;</c>를 가진 첫 실행이 창을 띄우고, 이어지는 실행은 같은 이름의
/// 파이프로 새 주소를 넘기고 받았다는 답(<c>ok</c>)을 받은 뒤 끝나요. 답이 없으면(닫히는 중) 다시 뮤텍스를 잡아 봐요.
/// <c>&lt;h&gt;</c> = SHA-256(사용자 SID | 세션 번호 | home 소문자) 앞 16자 — 다른 계정이 이름을 미리 알기 어렵고, 같은 사용자의 다른
/// 세션과도 안 섞여요. 파이프는 <see cref="PipeOptions.CurrentUserOnly"/>(서버가 이 사용자 것인지 확인)이고, 클라이언트는
/// <see cref="TokenImpersonationLevel.Identification"/>으로 붙어서 남이 파이프를 먼저 만들어도 이 사용자 권한을 빌릴 수 없어요.
/// </summary>
internal sealed class HubInstance : IDisposable
{
    public const int MaxMessageBytes = 8192;
    public const string Ack = "ok";

    private readonly Mutex _mutex;
    private readonly string _name;
    private readonly CancellationTokenSource _cts = new();

    private HubInstance(Mutex mutex, string name)
    {
        _mutex = mutex;
        _name = name;
    }

    public static string NameFor(string home) =>
        NameFor(home, WindowsIdentity.GetCurrent().User?.Value ?? "?", System.Diagnostics.Process.GetCurrentProcess().SessionId);

    internal static string NameFor(string home, string sid, int sessionId)
    {
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(home)).ToLowerInvariant();
        var key = $"{sid}|{sessionId}|{full}";
        return "Mark42.Hub." + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
    }

    /// <summary>
    /// 이 home의 첫 통합 창이면 그 표식, 이미 떠 있으면 null. 다른 계정이 같은 이름을 먼저 만들어 열 수 없으면
    /// <see cref="HubBlockedException"/>.
    /// </summary>
    public static HubInstance? TryAcquire(string home)
    {
        var name = NameFor(home);
        Mutex mutex;
        bool createdNew;
        try { mutex = new Mutex(initiallyOwned: false, @"Local\" + name, out createdNew); }
        catch (Exception ex) when (ex is UnauthorizedAccessException or WaitHandleCannotBeOpenedException) { throw new HubBlockedException(); }
        if (createdNew) return new HubInstance(mutex, name);
        mutex.Dispose();
        return null;
    }

    /// <summary>떠 있는 통합 창에 주소를 넘기고 받았다는 답을 기다려요. 못 넘기거나 답이 없으면 false.</summary>
    public static bool Forward(string home, Uri url, int timeoutMs = 3000)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", NameFor(home), PipeDirection.InOut,
                PipeOptions.CurrentUserOnly, TokenImpersonationLevel.Identification);
            pipe.Connect(timeoutMs);
            var bytes = Encoding.UTF8.GetBytes(url.OriginalString + "\n");
            if (bytes.Length > MaxMessageBytes) return false;
            pipe.Write(bytes);
            pipe.Flush();
            var reply = ReadLineAsync(pipe, timeoutMs).GetAwaiter().GetResult();
            return reply == Ack;
        }
        catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException or OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>
    /// 다음 실행이 넘기는 주소를 받아요. <paramref name="onUrl"/>(받는 스레드에서 불려요)이 true면 <c>ok</c>로 답해요. 주소 규칙에
    /// 안 맞거나 false면 답하지 않아요(보낸 쪽은 실패로 봐요). <see cref="StopListening"/> 뒤에는 받지 않아요.
    /// </summary>
    public void Listen(Func<Uri, bool> onUrl)
    {
        var ct = _cts.Token;
        var thread = new Thread(() =>
        {
            int failures = 0;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    using var server = new NamedPipeServerStream(_name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                        PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    server.WaitForConnectionAsync(ct).GetAwaiter().GetResult();
                    failures = 0;
                    var text = ReadLineAsync(server, 3000).GetAwaiter().GetResult();
                    bool ok = false;
                    if (text is not null && HubUrl.TryParse(text, out var url) && !ct.IsCancellationRequested)
                    {
                        try { ok = onUrl(url); } catch (Exception) { ok = false; }
                    }
                    if (ok)
                    {
                        server.Write(Encoding.UTF8.GetBytes(Ack + "\n"));
                        server.Flush();
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or OperationCanceledException or TimeoutException)
                {
                    // 파이프를 못 만들면(이름을 남이 쥠 등) 점점 천천히 다시 해 봐요 — CPU를 태우지 않게
                    failures++;
                    if (ct.WaitHandle.WaitOne(Math.Min(5000, 100 * (1 << Math.Min(failures, 6))))) return;
                }
            }
        }) { IsBackground = true, Name = "hub-instance" };
        thread.Start();
    }

    public void StopListening() => _cts.Cancel();

    /// <summary>줄 하나(최대 <see cref="MaxMessageBytes"/>)를 <paramref name="timeoutMs"/> 안에 읽어요. 넘치거나 시간이 지나면 null.</summary>
    internal static async Task<string?> ReadLineAsync(Stream s, int timeoutMs)
    {
        using var cts = new CancellationTokenSource(timeoutMs);
        var buf = new byte[MaxMessageBytes + 1];
        int n = 0;
        try
        {
            while (n < buf.Length)
            {
                int r = await s.ReadAsync(buf.AsMemory(n), cts.Token).ConfigureAwait(false);
                if (r <= 0) break;
                n += r;
                int nl = Array.IndexOf(buf, (byte)'\n', 0, n);
                if (nl >= 0) return Encoding.UTF8.GetString(buf, 0, nl).TrimEnd('\r');
            }
        }
        catch (OperationCanceledException) { return null; }
        return n > MaxMessageBytes || n == 0 ? null : Encoding.UTF8.GetString(buf, 0, n).TrimEnd('\r', '\n');
    }

    public void Dispose()
    {
        _cts.Cancel();
        _mutex.Dispose();
    }
}

/// <summary>다른 계정이 이 세션에서 통합 창 이름을 먼저 쥐고 있어서 열 수 없어요.</summary>
internal sealed class HubBlockedException : Exception;
