using System.Text.Json;

namespace Mark42.Hub;

/// <summary>
/// 통합 창 화면(<c>extension/hub-ui/src/host-bridge.ts</c>)과 주고받는 폴더 선택 메시지. 화면은 <c>window.mk42HubHost.pickFolder</c>가
/// 있을 때만 «폴더 선택» 단추를 보여요 — Edge로 띄운 통합 창·옛 exe에는 없어요.
/// <list type="bullet">
/// <item>화면 → exe: <c>{"type":"pickFolder","id":N,"title":"…","initial":"C:\…"}</c></item>
/// <item>exe → 화면: <c>{"type":"pickFolderResult","id":N,"path":"C:\…"|null}</c></item>
/// </list>
/// </summary>
internal static class HostBridge
{
    public const string MarkerScript = "window.mk42HubHost = Object.freeze({ pickFolder: 1 });";

    public sealed record PickFolderRequest(int Id, string Title, string? Initial);

    public const int MaxTitleLength = 200;

    /// <summary>폴더 선택 요청이면 그 내용, 아니면 null. 제목은 길이를 자르고, 처음 폴더는 전체 경로만.</summary>
    public static PickFolderRequest? ParsePickFolder(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || type.GetString() != "pickFolder") return null;
            if (!root.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out var id)) return null;
            string title = root.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
            if (title.Length > MaxTitleLength) title = title[..MaxTitleLength];
            if (title.Length == 0) title = Strings.PickFolderDefaultTitle;
            string? initial = root.TryGetProperty("initial", out var i) && i.ValueKind == JsonValueKind.String ? i.GetString() : null;
            if (initial is not null && (initial.Length > 1024 || !Path.IsPathFullyQualified(initial))) initial = null;
            return new PickFolderRequest(id, title, initial);
        }
        catch (JsonException) { return null; }
    }

    public static string PickFolderResult(int id, string? path) =>
        JsonSerializer.Serialize(new { type = "pickFolderResult", id, path });
}
