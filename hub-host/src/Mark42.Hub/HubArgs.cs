namespace Mark42.Hub;

/// <summary>
/// <c>mk42-hub.exe --url &lt;통합 창 주소&gt; --home &lt;Mark42 home&gt;</c> — 데몬(<c>daemon/src/edge.ts</c> <c>openHubWindow</c>)이 넘겨요.
/// </summary>
internal sealed record HubArgs(Uri Url, string Home)
{
    /// <summary>이게 없으면 데몬에게 열어 달라고 부탁하는 실행이에요(<see cref="HubLauncher"/>)</summary>
    public const string UrlArgument = "--url";

    public static bool TryParse(string[] args, out HubArgs? result, out string? error)
    {
        result = null;
        string? url = null, home = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--url" when i + 1 < args.Length:
                    url = args[++i];
                    break;
                case "--home" when i + 1 < args.Length:
                    home = args[++i];
                    break;
                default:
                    error = Strings.UnknownArgument(args[i]);
                    return false;
            }
        }
        if (url is null || !HubUrl.TryParse(url, out var uri))
        {
            error = Strings.UrlRequired;
            return false;
        }
        if (home is null || !Path.IsPathFullyQualified(home))
        {
            error = Strings.HomeRequired;
            return false;
        }
        result = new HubArgs(uri, Path.TrimEndingDirectorySeparator(Path.GetFullPath(home)));
        error = null;
        return true;
    }
}

/// <summary>통합 창 주소 규칙: 이 창은 데몬의 루프백 통합 창 화면만 보여 줘요.</summary>
internal static class HubUrl
{
    /// <summary><c>http://127.0.0.1:&lt;1025..65535&gt;/</c>, 쿼리 없음, 해시에 <c>token=</c>.</summary>
    public static bool TryParse(string text, out Uri uri)
    {
        uri = null!;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var u)) return false;
        if (u.Scheme != Uri.UriSchemeHttp || u.Host != "127.0.0.1" || u.IsDefaultPort || u.Port <= 1024) return false;
        if (u.AbsolutePath != "/" || u.Query.Length > 0 || !string.IsNullOrEmpty(u.UserInfo)) return false;
        if (!u.Fragment.Contains("token=", StringComparison.Ordinal)) return false;
        uri = u;
        return true;
    }

    /// <summary>창 안에서 그대로 열어도 되는 주소: 통합 창과 같은 출처(같은 포트의 127.0.0.1)</summary>
    public static bool SameOrigin(Uri hub, Uri target) =>
        target.Scheme == hub.Scheme && target.Host == hub.Host && target.Port == hub.Port;

    /// <summary>해시만 다른 같은 문서(이 경우 Navigate는 다시 불러오지 않아요)</summary>
    public static bool SameDocument(Uri a, Uri b) =>
        string.Equals(a.GetLeftPart(UriPartial.Query), b.GetLeftPart(UriPartial.Query), StringComparison.Ordinal);

    /// <summary>창 밖(기본 브라우저)으로 넘길 링크: http(s)이고 루프백이 아닌 것</summary>
    public static bool IsExternalWebLink(Uri target) =>
        (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps) && !target.IsLoopback;

    /// <summary>로그용: 해시(토큰)를 뺀 주소</summary>
    public static string ForLog(Uri u) => u.GetLeftPart(UriPartial.Path);
}
