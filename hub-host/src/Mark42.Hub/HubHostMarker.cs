using System.Text.Json;

namespace Mark42.Hub;

/// <summary>
/// <c>&lt;home&gt;\hub-host.json</c> = <c>{"pid":N}</c> — 통합 창이 떠 있는 동안만 있어요. 데몬은 시작할 때 이 프로세스가 살아 있으면
/// 통합 창을 다시 열어(새 토큰의 주소를 넘김) 창이 그대로 이어지게 해요(<c>daemon/src/edge.ts</c> <c>hubHostRunning</c>).
/// 없으면 이 창은 이전 토큰으로 다시 붙으려다 거절(4401)돼 닫혀요.
/// </summary>
internal static class HubHostMarker
{
    public const string FileName = "hub-host.json";

    public static string PathFor(string home) => Path.Combine(home, FileName);

    public static void Write(string home)
    {
        try
        {
            var path = PathFor(home);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new { pid = Environment.ProcessId }));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>이 프로세스가 쓴 것일 때만 지워요(막 뜬 다른 통합 창의 표시를 지우지 않게)</summary>
    public static void Delete(string home)
    {
        try
        {
            var path = PathFor(home);
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("pid", out var pid) && pid.TryGetInt32(out var n) && n == Environment.ProcessId)
                File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { }
    }
}
