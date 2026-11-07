using System.Globalization;

namespace Mark42.Hub;

/// <summary>
/// 사용자에게 보이는 글(계약 C1): Windows 표시 언어(<see cref="CultureInfo.CurrentUICulture"/>)가 한국어면 한국어, 아니면 영어.
/// 한국어 문구는 지금까지 쓰던 그대로예요. 진행 창(<see cref="ProgressForm"/>)은 파일의 <c>lang</c>을 먼저 봐요(<see cref="IsKoreanLang"/>).
/// </summary>
internal static class Strings
{
    /// <summary>지금 UI 언어가 한국어인지(부를 때마다 봐요 — 테스트는 스레드의 CurrentUICulture를 바꿔요)</summary>
    public static bool Korean => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ko";

    private static string T(string ko, string en) => Korean ? ko : en;

    /// <summary>파일의 <c>lang</c>(<c>ko</c>, <c>ko-KR</c>, <c>en</c> …)이 있으면 그것으로, 없으면 UI 언어로</summary>
    public static bool IsKoreanLang(string? lang) =>
        string.IsNullOrWhiteSpace(lang) ? Korean : lang.Trim().StartsWith("ko", StringComparison.OrdinalIgnoreCase);

    // 통합 창
    public static string HubTitle => T("Mk42 통합 창", "Mk42 Hub");
    public static string HubOpenedByDaemon => T("통합 창은 데몬이 띄워요(mk42d --open-hub 또는 확장의 «통합 창 열기»).",
        "The hub window is opened by the daemon (mk42d --open-hub or the extension's \"Open Hub\").");
    public static string HubBlocked => T("이 세션에서 다른 계정이 Mk42 통합 창 이름을 쥐고 있어서 통합 창을 열 수 없어요.",
        "Another account in this session holds the Mk42 Hub name, so the hub window can't be opened.");
    public static string NoDaemon => T("Mk42 데몬(mk42d)에 닿지 못했어요. 데몬이 떠 있는지 확인해 주세요(보통 로그온 때 자동으로 떠요).",
        "Couldn't reach the Mk42 daemon (mk42d). Please check that it is running (it normally starts automatically at sign-in).");
    public static string DaemonRefused => T("데몬이 통합 창을 열지 못했어요. 데몬 로그(<home>\\logs\\mk42d.log)를 확인해 주세요.",
        "The daemon couldn't open the hub window. Please check the daemon log (<home>\\logs\\mk42d.log).");
    public static string WebViewFailed(string message) => T($"통합 창을 띄우지 못했어요(WebView2): {message}",
        $"Couldn't open the hub window (WebView2): {message}");
    public static string PickFolderDefaultTitle => T("폴더 선택", "Select folder");

    // 인자
    public static string UnknownArgument(string arg) => T($"모르는 인자예요: {arg}", $"Unknown argument: {arg}");
    public static string UrlRequired => T("--url에는 데몬이 준 통합 창 주소(http://127.0.0.1:<포트>/#token=…)가 있어야 해요.",
        "--url needs the hub address given by the daemon (http://127.0.0.1:<port>/#token=…).");
    public static string HomeRequired => T("--home에는 Mark42 home 전체 경로가 있어야 해요.", "--home needs the full path of the Mark42 home.");
    public static string HomeNotFound => T("Mark42 home을 찾지 못했어요(--home으로 알려 주세요).", "Couldn't find the Mark42 home (pass it with --home).");

    // 진행 창(계약 C3) — 파일의 lang을 따라요
    public static string ProgressTitle(bool ko) => ko ? "Mk42 준비 중" : "Preparing Mk42";
    public static string ProgressHide(bool ko) => ko ? "숨기기" : "Hide";
    public static string ProgressClose(bool ko) => ko ? "닫기" : "Close";
}
