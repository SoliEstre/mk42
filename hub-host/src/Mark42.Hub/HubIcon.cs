using System.Drawing.Drawing2D;

namespace Mark42.Hub;

/// <summary>
/// Mk42 아이콘 위 작은 표시(사용자 요청 2026-10-26: 왼쪽 위). Mk42 앱 그림(<see cref="AppIconArt"/>)의 왼쪽 위는 32px 이상에서 빈
/// 빨간 판이에요(16·24px에서는 «Mk»를 가리지만 «42»는 그대로).
/// - 통합 창: «창 넷»(2×2 금색 칸, 어두운 바탕) — 폴더·세션을 한데 모아 보는 창.
/// </summary>
internal static partial class HubIcon
{
    /// <summary>exe 아이콘(Assets\mk42-hub.ico)과 창 아이콘 크기</summary>
    internal static readonly int[] Sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

    public static Icon Create()
    {
        using var ms = new MemoryStream(BuildIco(Sizes));
        return new Icon(ms);
    }

    /// <summary>표시 없는 Mk42 앱 아이콘(진행 창 — «Mk42 준비 중»은 통합 창이 아니라 Mk42 자체예요)</summary>
    public static Icon CreateApp()
    {
        using var ms = new MemoryStream(PackIco(Sizes.Select(AppIconArt.Render).ToList()));
        return new Icon(ms);
    }

    internal static Bitmap Render(int size)
    {
        var bmp = AppIconArt.Render(size);
        DrawHubMark(bmp);
        return bmp;
    }

    /// <summary>표시 칸 한 변(아이콘의 약 45%, 최소 7px)</summary>
    internal static int MarkSize(int size) => Math.Max(7, (int)Math.Round(size * 0.45));

    internal static void DrawHubMark(Bitmap bmp)
    {
        int size = bmp.Width;
        int s = MarkSize(size);
        var rim = Color.FromArgb(255, 20, 16, 8);
        var fill = Color.FromArgb(255, 44, 36, 20);
        var cell = Color.FromArgb(255, 247, 205, 92);
        int inner = s - 2, gap = Math.Max(1, inner / 7), c = (inner - gap * 3) / 2;
        for (int y = 0; y < s; y++)
            for (int x = 0; x < s; x++)
            {
                bool edge = x == 0 || y == 0 || x == s - 1 || y == s - 1;
                int ix = x - 1 - gap, iy = y - 1 - gap;
                bool inCell = !edge && c > 0 && ix >= 0 && iy >= 0 && ix % (c + gap) < c && iy % (c + gap) < c && ix < 2 * c + gap && iy < 2 * c + gap;
                bmp.SetPixel(x, y, edge ? rim : inCell ? cell : fill);
            }
    }

    /// <summary>32비트 BGRA 이미지들(빈 AND 마스크)의 .ico</summary>
    internal static byte[] BuildIco(IReadOnlyList<int> sizes) => PackIco(sizes.Select(Render).ToList());

    /// <summary>정사각 비트맵들(차례대로 한 장씩)의 .ico. 비트맵은 여기서 버려요.</summary>
    internal static byte[] PackIco(IReadOnlyList<Bitmap> bitmaps)
    {
        var images = new List<(int Size, byte[] Dib)>();
        foreach (var bmp in bitmaps)
            using (bmp)
                images.Add((bmp.Width, ToIconDib(bmp)));
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)images.Count);
        var offset = 6 + 16 * images.Count;
        foreach (var (size, dib) in images)
        {
            w.Write((byte)(size >= 256 ? 0 : size)); w.Write((byte)(size >= 256 ? 0 : size));
            w.Write((byte)0); w.Write((byte)0);
            w.Write((ushort)1); w.Write((ushort)32);
            w.Write(dib.Length); w.Write(offset);
            offset += dib.Length;
        }
        foreach (var (_, dib) in images) w.Write(dib);
        w.Flush();
        return ms.ToArray();
    }

    private static byte[] ToIconDib(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var maskStride = ((w + 31) / 32) * 4;
        using var ms = new MemoryStream();
        using var bw = new BinaryWriter(ms);
        bw.Write(40); bw.Write(w); bw.Write(h * 2);
        bw.Write((ushort)1); bw.Write((ushort)32);
        bw.Write(0); bw.Write(w * h * 4 + maskStride * h);
        bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
        for (var y = h - 1; y >= 0; y--)
            for (var x = 0; x < w; x++)
            {
                var c = bmp.GetPixel(x, y);
                bw.Write(c.B); bw.Write(c.G); bw.Write(c.R); bw.Write(c.A);
            }
        bw.Write(new byte[maskStride * h]);
        bw.Flush();
        return ms.ToArray();
    }
}
