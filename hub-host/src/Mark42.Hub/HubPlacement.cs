using System.Text.Json;

namespace Mark42.Hub;

/// <summary>창 위치·크기 기억(<c>&lt;home&gt;\hub-window.json</c>). 읽을 때 지금 화면 안으로 맞춰요.</summary>
internal sealed record HubPlacement(int X, int Y, int Width, int Height, bool Maximized)
{
    public const string FileName = "hub-window.json";
    public static readonly Size DefaultSize = new(1100, 760);
    public static readonly Size MinSize = new(480, 360);

    public static string PathFor(string home) => Path.Combine(home, FileName);

    public static HubPlacement? Load(string home)
    {
        try { return JsonSerializer.Deserialize<HubPlacement>(File.ReadAllText(PathFor(home))); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException) { return null; }
    }

    public void Save(string home)
    {
        try
        {
            var path = PathFor(home);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this));
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>제목 표시줄로 보는 위쪽 띠 높이</summary>
    public const int TitleBarHeight = 32;

    /// <summary>
    /// 기억한 자리의 **제목 표시줄**(위쪽 띠)이 지금 화면들(<paramref name="workingAreas"/>) 중 하나 안에 가로 120 픽셀 이상, 띠 높이
    /// 전부 들어 있으면 그 자리(크기는 그 화면보다 크지 않게) — 끌어서 옮길 수 있게. 아니면 주 화면 가운데 기본 크기.
    /// </summary>
    public static Rectangle Fit(HubPlacement? saved, IReadOnlyList<Rectangle> workingAreas, Rectangle primary)
    {
        if (saved is not null && saved.Width >= MinSize.Width && saved.Height >= MinSize.Height)
        {
            var r = new Rectangle(saved.X, saved.Y, saved.Width, saved.Height);
            var titleBar = new Rectangle(r.X, r.Y, r.Width, TitleBarHeight);
            foreach (var area in workingAreas)
            {
                var hit = Rectangle.Intersect(area, titleBar);
                if (hit.Width >= 120 && hit.Height >= TitleBarHeight)
                    return new Rectangle(r.X, r.Y, Math.Min(r.Width, area.Width), Math.Min(r.Height, area.Height));
            }
        }
        int w = Math.Min(DefaultSize.Width, primary.Width), h = Math.Min(DefaultSize.Height, primary.Height);
        return new Rectangle(primary.X + (primary.Width - w) / 2, primary.Y + (primary.Height - h) / 2, w, h);
    }
}
