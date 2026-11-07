using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;

namespace Mark42.Hub;

/// <summary>
/// Mk42 app icon art: a red metallic plate with a large gold «42» filling most of the icon and a small «Mk» at the
/// bottom left, both standing on the same bottom line (gold-dominant with red plating). Glyphs are
/// font outlines scaled into fixed boxes — «42» is stretched vertically when the width runs out, so every size fills the plate.
/// </summary>
internal static class AppIconArt
{
    // Gold: light highlight → warm gold → deep shadow band → reflected light → dark rim (metallic banding).
    private static readonly Color[] GoldColors =
    [
        Color.FromArgb(255, 255, 246, 196),
        Color.FromArgb(255, 247, 205, 92),
        Color.FromArgb(255, 205, 150, 34),
        Color.FromArgb(255, 150, 98, 14),
        Color.FromArgb(255, 238, 188, 74),
        Color.FromArgb(255, 122, 78, 10),
    ];
    private static readonly float[] GoldStops = [0f, 0.22f, 0.48f, 0.60f, 0.78f, 1f];

    private static readonly Color RedTop = Color.FromArgb(255, 214, 38, 44);
    private static readonly Color RedMid = Color.FromArgb(255, 150, 16, 26);
    private static readonly Color RedBottom = Color.FromArgb(255, 86, 6, 14);
    private static readonly Color GlyphEdge = Color.FromArgb(255, 58, 30, 4);

    /// <summary>Smallest size drawn from font outlines; below it the icon is hand-placed pixel art.</summary>
    public const int SmallestWithMk = 32;

    public static Bitmap Render(int size)
    {
        if (size < SmallestWithMk) return RenderPixel(size);

        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.Clear(Color.Transparent);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.CompositingQuality = CompositingQuality.HighQuality;

        DrawPlate(g, size);

        float m = size * 0.10f;                                        // inner margin
        float bottom = size - m;                                       // shared bottom line
        float top = size * 0.11f;

        using var num = GlyphPath("42", heavy: true);

        // «Mk»: small, bottom-left; the «42» box starts right after it and stands on the same bottom line.
        float mkH = size * 0.20f;
        using var mk = GlyphPath("Mk");
        var mkB = mk.GetBounds();
        var mkRect = new RectangleF(m, bottom - mkH, mkB.Width * (mkH / mkB.Height), mkH);
        FitInto(mk, mkRect);

        float gap = size * 0.025f;
        var numRect = new RectangleF(mkRect.Right + gap, top, size - m - (mkRect.Right + gap), bottom - top);
        FitInto(num, numRect);

        FillGold(g, num, numRect, size);
        FillGold(g, mk, mkRect, size);
        return bmp;
    }

    // ---- pixel art for 16 / 20 / 24 px (outlines turn to mush there) ----
    // Each size: «Mk» top-left, «42» below it on the bottom line; '#' = on. Gold is shaded per row (metallic bands) with a
    // 1 px dark drop shadow; the plate is a row-shaded red with a 1 px gold rim and rounded corners.

    private sealed record PixelLayout(int MkX, int MkY, string[] M, string[] K, int NumX, int NumY, string[] Four, string[] Two, int Corner);

    private static readonly string[] M4 = ["#...#", "##.##", "#.#.#", "#...#"];
    private static readonly string[] K4 = ["#..", "#.#", "##.", "#.#"];
    private static readonly string[] M5 = ["#...#", "##.##", "#.#.#", "#...#", "#...#"];
    private static readonly string[] K5 = ["#..", "#..", "#.#", "##.", "#.#"];

    private static readonly PixelLayout Pixel16 = new(2, 2, M4, K4, 2, 7,
        ["...##.", "..###.", ".#.##.", "#..##.", "######", "...##.", "...##."],
        [".####.", "##..##", "...##.", "..##..", ".##...", "##....", "######"], 2);

    private static readonly PixelLayout Pixel20 = new(2, 2, M4, K4, 2, 7,
        ["....##.", "...###.", "..#.##.", ".#..##.", "#...##.", "#######", "#######", "....##.", "....##.", "....##."],
        [".#####.", "##...##", ".....##", "....##.", "...##..", "..##...", ".##....", "##.....", "##.....", "#######"], 3);

    private static readonly PixelLayout Pixel24 = new(2, 2, M5, K5, 2, 8,
        [".....##..", "....###..", "...####..", "..##.##..", ".##..##..", "##...##..", "#########", "#########", ".....##..", ".....##..", ".....##..", ".....##..", ".....##.."],
        ["..#####..", ".##...##.", "##.....##", ".......##", "......##.", ".....##..", "....##...", "...##....", "..##.....", ".##......", "##.......", "#########", "#########"], 3);

    private static readonly Color PixShadow = Color.FromArgb(255, 60, 4, 10);
    private static readonly Color PixRim = Color.FromArgb(255, 196, 140, 40);

    private static Bitmap RenderPixel(int size)
    {
        var layout = size <= 17 ? Pixel16 : size <= 21 ? Pixel20 : Pixel24;
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);

        // Plate: row-shaded red, gold rim, corners cut by distance from the corner centers.
        int c = layout.Corner;
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
            {
                int cx = x < c ? c : x > size - 1 - c ? size - 1 - c : x;
                int cy = y < c ? c : y > size - 1 - c ? size - 1 - c : y;
                double d = Math.Sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
                if (d > c + 0.25) continue;                                 // outside the rounded corner
                bool rim = x == 0 || y == 0 || x == size - 1 || y == size - 1 || d > c - 0.75;
                bmp.SetPixel(x, y, rim ? PixRim : Lerp3(RedTop, RedMid, RedBottom, y / (double)(size - 1)));
            }

        var lit = new Dictionary<(int X, int Y), double>();                 // pixel → shade position 0..1
        void Stamp(string[] glyph, int x0, int y0, int bandTop, int bandHeight)
        {
            for (int row = 0; row < glyph.Length; row++)
                for (int col = 0; col < glyph[row].Length; col++)
                    if (glyph[row][col] == '#')
                        lit[(x0 + col, y0 + row)] = (y0 + row - bandTop) / (double)Math.Max(1, bandHeight - 1);
        }
        Stamp(layout.M, layout.MkX, layout.MkY, layout.MkY, layout.M.Length);
        Stamp(layout.K, layout.MkX + layout.M[0].Length + 1, layout.MkY, layout.MkY, layout.K.Length);
        Stamp(layout.Four, layout.NumX, layout.NumY, layout.NumY, layout.Four.Length);
        Stamp(layout.Two, layout.NumX + layout.Four[0].Length + 1, layout.NumY, layout.NumY, layout.Two.Length);

        foreach (var ((x, y), _) in lit)
            if (x + 1 < size - 1 && y + 1 < size - 1 && !lit.ContainsKey((x + 1, y + 1))) bmp.SetPixel(x + 1, y + 1, PixShadow);
        foreach (var ((x, y), t) in lit) bmp.SetPixel(x, y, GoldAt(t));
        return bmp;
    }

    private static Color GoldAt(double t)
    {
        t = Math.Clamp(t, 0, 1);
        for (int i = 1; i < GoldStops.Length; i++)
            if (t <= GoldStops[i])
                return Lerp(GoldColors[i - 1], GoldColors[i], (t - GoldStops[i - 1]) / (GoldStops[i] - GoldStops[i - 1]));
        return GoldColors[^1];
    }

    private static Color Lerp3(Color a, Color b, Color c, double t) => t < 0.55 ? Lerp(a, b, t / 0.55) : Lerp(b, c, (t - 0.55) / 0.45);

    private static Color Lerp(Color a, Color b, double t) => Color.FromArgb(255,
        (int)Math.Round(a.R + (b.R - a.R) * t), (int)Math.Round(a.G + (b.G - a.G) * t), (int)Math.Round(a.B + (b.B - a.B) * t));

    private static void DrawPlate(Graphics g, int size)
    {
        float r = Math.Max(2f, size / 5.5f);
        using var plate = RoundedSquare(size, r);
        using (var red = new LinearGradientBrush(new RectangleF(-1, -1, size + 2, size + 2), RedTop, RedBottom, 75f))
        {
            red.InterpolationColors = new ColorBlend { Colors = [RedTop, RedMid, RedBottom], Positions = [0f, 0.55f, 1f] };
            red.WrapMode = WrapMode.TileFlipXY;
            g.FillPath(red, plate);
        }
        if (size >= 24)
        {
            // Diagonal sheen across the upper left of the plate.
            var state = g.Save();
            g.SetClip(plate);
            using var sheen = new GraphicsPath();
            sheen.AddPolygon([new PointF(0, 0), new PointF(size * 0.75f, 0), new PointF(0, size * 0.62f)]);
            using var sheenBrush = new LinearGradientBrush(new PointF(0, 0), new PointF(size * 0.4f, size * 0.4f),
                Color.FromArgb(90, 255, 255, 255), Color.FromArgb(0, 255, 255, 255));
            g.FillPath(sheenBrush, sheen);
            g.Restore(state);
            // Thin gold rim.
            using var rim = new Pen(Color.FromArgb(220, 214, 160, 52), Math.Max(1f, size / 40f));
            g.DrawPath(rim, plate);
        }
    }

    private static void FillGold(Graphics g, GraphicsPath glyphs, RectangleF box, int size)
    {
        var band = RectangleF.Inflate(box, 1f, 1f);
        using var gold = new LinearGradientBrush(band, GoldColors[0], GoldColors[^1], LinearGradientMode.Vertical)
        {
            InterpolationColors = new ColorBlend { Colors = GoldColors, Positions = GoldStops },
            WrapMode = WrapMode.TileFlipXY,
        };
        if (size >= 32)
        {
            // Dark edge first (drawn wide, then the fill covers its inner half) so the gold reads on the red at any DPI.
            using var edge = new Pen(GlyphEdge, size / 22f) { LineJoin = LineJoin.Round };
            g.DrawPath(edge, glyphs);
        }
        g.FillPath(gold, glyphs);
    }

    /// <summary>
    /// Outline of <paramref name="text"/>, origin-agnostic (callers fit it by its ink bounds). <paramref name="heavy"/>: the
    /// blackest face available, because the «42» is stretched tall and a regular-weight stroke turns spindly.
    /// </summary>
    private static GraphicsPath GlyphPath(string text, bool heavy = false)
    {
        var path = new GraphicsPath();
        using var family = PickFamily(heavy ? ["Segoe UI Black", "Arial Black", "Bahnschrift"] : ["Bahnschrift", "Segoe UI"]);
        var style = family.IsStyleAvailable(FontStyle.Bold) ? FontStyle.Bold : FontStyle.Regular;
        path.AddString(text, family, (int)style, 100f, PointF.Empty, StringFormat.GenericTypographic);
        return path;
    }

    private static FontFamily PickFamily(string[] names)
    {
        foreach (var name in names)
        {
            try { return new FontFamily(name); }
            catch (ArgumentException) { }
        }
        return new FontFamily(GenericFontFamilies.SansSerif);
    }

    /// <summary>
    /// Scales the path's ink bounds into <paramref name="box"/>: width-limited uniform scale, then stretched vertically to the
    /// box height (the «42» gets taller rather than leaving empty plate), anchored to the box's bottom-left.
    /// </summary>
    private static void FitInto(GraphicsPath path, RectangleF box)
    {
        var b = path.GetBounds();
        if (b.Width <= 0 || b.Height <= 0) return;
        float sx = box.Width / b.Width;
        float sy = box.Height / b.Height;
        float s = Math.Min(sx, sy);
        float stretchY = Math.Max(s, sy); // fill the height
        using var mx = new Matrix();
        mx.Translate(box.Left, box.Bottom);
        mx.Scale(s, stretchY);
        mx.Translate(-b.Left, -b.Bottom);
        path.Transform(mx);
    }

    private static GraphicsPath RoundedSquare(int size, float r)
    {
        var p = new GraphicsPath();
        var d = r * 2;
        var e = size - 0.5f;
        p.AddArc(0.5f, 0.5f, d, d, 180, 90);
        p.AddArc(e - d, 0.5f, d, d, 270, 90);
        p.AddArc(e - d, e - d, d, d, 0, 90);
        p.AddArc(0.5f, e - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
}
