using System.Globalization;
using System.Text;

namespace Mark42.Hub.Tests;

public sealed class ProgressSnapshotTests
{
    internal const string Sample = """
        { "schema": 1, "id": "L1", "updatedAt": "2026-11-05T05:30:12.345Z", "lang": "ko",
          "title": "Mk42 준비 중",
          "steps": [
            { "id": "mark42-extension", "label": "Mark42 확장 설치", "state": "done" },
            { "id": "language-pack", "label": "한국어 언어 팩", "state": "running", "detail": "120 / 600 MB" },
            { "id": "open-window", "label": "창 여는 중", "state": "pending" },
            { "id": "codex-extension", "label": "Codex", "state": "skipped" },
            { "id": "claude-extension", "label": "Claude Code", "state": "failed" }
          ],
          "done": false, "error": null }
        """;

    [Fact]
    public void Parses_the_contract_sample()
    {
        var s = ProgressSnapshot.Parse(Sample)!;
        Assert.Equal("L1", s.Id);
        Assert.Equal(new DateTimeOffset(2026, 11, 5, 5, 30, 12, 345, TimeSpan.Zero), s.UpdatedAt);
        Assert.Equal("ko", s.Lang);
        Assert.Equal("Mk42 준비 중", s.Title);
        Assert.False(s.Done);
        Assert.Null(s.Error);
        Assert.Equal(
            [ProgressStepState.Done, ProgressStepState.Running, ProgressStepState.Pending, ProgressStepState.Skipped, ProgressStepState.Failed],
            s.Steps.Select(x => x.State));
        Assert.Equal(new ProgressStep("language-pack", "한국어 언어 팩", ProgressStepState.Running, "120 / 600 MB"), s.Steps[1]);
        Assert.Null(s.Steps[0].Detail);
    }

    [Theory]
    [InlineData("")]
    [InlineData("""{ "schema": 1, "steps": [ { "id": "a", "lab""")]   // half-written
    [InlineData("""[1,2]""")]
    [InlineData("""null""")]
    [InlineData("""{ "schema": "1" }""")]
    [InlineData("""{ "schema": 0 }""")]
    public void Rejects_partial_or_foreign_json(string json) => Assert.Null(ProgressSnapshot.Parse(json));

    [Fact]
    public void Is_lenient_about_optional_and_unknown_fields()
    {
        var s = ProgressSnapshot.Parse("""
            { "extra": {"x": 1}, "updatedAt": "not a date", "title": "  ",
              "steps": [ 5, { "id": "a" }, { "label": "B", "state": "weird" }, { "id": "c", "label": 3, "detail": "  " } ],
              "done": "true", "error": "" }
            """)!;
        Assert.Null(s.UpdatedAt);
        Assert.Null(s.Title);       // blank → the window's default title
        Assert.False(s.Done);       // only JSON true counts
        Assert.Null(s.Error);
        Assert.Equal(3, s.Steps.Count);
        Assert.Equal(new ProgressStep("a", "a", ProgressStepState.Pending, null), s.Steps[0]);       // label falls back to id
        Assert.Equal(new ProgressStep("#3", "B", ProgressStepState.Pending, null), s.Steps[1]);      // no id: position; unknown state: pending
        Assert.Equal(new ProgressStep("c", "c", ProgressStepState.Pending, null), s.Steps[2]);
        Assert.True(ProgressSnapshot.Parse("""{ "schema": 2, "done": true }""")!.Done);             // a newer schema still shows what it can
    }

    [Fact]
    public void Clips_long_text_and_caps_the_step_count()
    {
        var steps = string.Join(",", Enumerable.Range(0, 30).Select(i => $$"""{"id":"s{{i}}","label":"{{new string('x', 500)}}"}"""));
        var s = ProgressSnapshot.Parse($$"""{"title":"{{new string('t', 500)}}","error":"line1\nline2","steps":[{{steps}}]}""")!;
        Assert.Equal(ProgressSnapshot.MaxSteps, s.Steps.Count);
        Assert.Equal(ProgressSnapshot.MaxLabelLength, s.Steps[0].Label.Length);
        Assert.EndsWith("…", s.Steps[0].Label);
        Assert.Equal(ProgressSnapshot.MaxTitleLength, s.Title!.Length);
        Assert.Equal("line1 line2", s.Error);
    }

    [Fact]
    public void Glyphs_per_state_and_spinner()
    {
        Assert.Equal("○", ProgressSnapshot.Glyph(ProgressStepState.Pending, 0));
        Assert.Equal("✓", ProgressSnapshot.Glyph(ProgressStepState.Done, 0));
        Assert.Equal("✕", ProgressSnapshot.Glyph(ProgressStepState.Failed, 0));
        Assert.Equal("–", ProgressSnapshot.Glyph(ProgressStepState.Skipped, 0));
        var frames = Enumerable.Range(0, 4).Select(f => ProgressSnapshot.Glyph(ProgressStepState.Running, f)).ToList();
        Assert.Equal(4, frames.Distinct().Count());
        Assert.Equal(frames[0], ProgressSnapshot.Glyph(ProgressStepState.Running, 4));
        Assert.Equal(frames[3], ProgressSnapshot.Glyph(ProgressStepState.Running, -1));
    }
}

public sealed class ProgressTrackerTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 5, 5, 30, 0, TimeSpan.Zero);

    private static ProgressRead Text(string json) => new(ProgressReadKind.Text, json);
    private static readonly ProgressRead Missing = new(ProgressReadKind.Missing);
    private static readonly ProgressRead Locked = new(ProgressReadKind.Unreadable);

    private static string Json(bool done = false, string? error = null, string state = "running", DateTimeOffset? at = null, string id = "L1") =>
        $$"""{"schema":1,"id":"{{id}}","updatedAt":"{{(at ?? T0):O}}","steps":[{"id":"a","label":"A","state":"{{state}}"}],"done":{{(done ? "true" : "false")}},"error":{{(error is null ? "null" : $"\"{error}\"")}}}""";

    [Fact]
    public void Shows_new_states_and_keeps_the_last_good_one_over_partial_or_locked_reads()
    {
        var t = new ProgressTracker(T0);
        var a = t.Step(Text(Json()), T0);
        Assert.Equal(new ProgressTick(ProgressPhase.Active, Changed: true, Close: false), a);
        Assert.Equal(new ProgressTick(ProgressPhase.Active, false, false), t.Step(Text(Json()), T0.AddMilliseconds(250)));   // same text
        Assert.Equal(new ProgressTick(ProgressPhase.Active, false, false), t.Step(Text("""{"schema":1,"ste"""), T0.AddMilliseconds(500)));
        Assert.Equal(new ProgressTick(ProgressPhase.Active, false, false), t.Step(Locked, T0.AddMilliseconds(750)));
        Assert.Equal(ProgressStepState.Running, t.Current!.Steps[0].State);
        Assert.True(t.Step(Text(Json(state: "done")), T0.AddSeconds(1)).Changed);
        Assert.Equal(ProgressStepState.Done, t.Current!.Steps[0].State);
    }

    [Fact]
    public void Closes_a_moment_after_done()
    {
        var t = new ProgressTracker(T0);
        t.Step(Text(Json()), T0);
        var done = t.Step(Text(Json(done: true, state: "done")), T0.AddSeconds(1));
        Assert.Equal(new ProgressTick(ProgressPhase.Finished, true, false), done);
        Assert.False(t.Step(Text(Json(done: true, state: "done")), T0.AddSeconds(1.5)).Close);
        Assert.True(t.Step(Text(Json(done: true, state: "done")), T0.AddMilliseconds(1800)).Close);
    }

    [Fact]
    public void A_new_launch_before_the_close_keeps_the_window()
    {
        var t = new ProgressTracker(T0);
        t.Step(Text(Json(done: true, state: "done")), T0);
        Assert.Equal(ProgressPhase.Active, t.Step(Text(Json(id: "L2", at: T0.AddSeconds(0.5))), T0.AddSeconds(0.5)).Phase);
        Assert.False(t.Step(Text(Json(id: "L2", at: T0.AddSeconds(0.5))), T0.AddSeconds(2)).Close);
        // done again: the delay starts over
        Assert.False(t.Step(Text(Json(done: true, id: "L2", at: T0.AddSeconds(3))), T0.AddSeconds(3)).Close);
        Assert.True(t.Step(Missing, T0.AddSeconds(3.25)).Phase != ProgressPhase.Gone); // one missing read is tolerated
        Assert.True(t.Step(Text(Json(done: true, id: "L2", at: T0.AddSeconds(3))), T0.AddMilliseconds(3800)).Close);
    }

    [Fact]
    public void An_error_stays_open_for_a_while_then_closes()
    {
        var t = new ProgressTracker(T0);
        var e = t.Step(Text(Json(done: true, error: "설치하지 못했어요", state: "failed", at: T0)), T0);
        Assert.Equal(new ProgressTick(ProgressPhase.Failed, true, false), e);
        Assert.Equal("설치하지 못했어요", t.Current!.Error);
        Assert.False(t.Step(Text(Json(done: true, error: "설치하지 못했어요", state: "failed", at: T0)), T0.AddSeconds(29)).Close);
        Assert.True(t.Step(Text(Json(done: true, error: "설치하지 못했어요", state: "failed", at: T0)), T0.AddSeconds(30)).Close); // auto close
    }

    [Fact]
    public void An_error_closes_when_the_file_is_gone_and_a_fresh_launch_takes_over()
    {
        var t = new ProgressTracker(T0);
        t.Step(Text(Json(done: true, error: "x", state: "failed", at: T0)), T0);
        Assert.Equal(ProgressPhase.Active, t.Step(Text(Json(id: "L2", at: T0.AddSeconds(5))), T0.AddSeconds(5)).Phase); // a fresh launch reuses the window
        var g = new ProgressTracker(T0);
        g.Step(Text(Json(done: true, error: "x", state: "failed", at: T0)), T0);
        Assert.False(g.Step(Missing, T0.AddSeconds(1)).Close);
        Assert.True(g.Step(Missing, T0.AddSeconds(1.25)).Close); // gone
    }

    [Fact]
    public void Closes_when_the_file_is_gone()
    {
        var t = new ProgressTracker(T0);
        t.Step(Text(Json()), T0);
        Assert.False(t.Step(Missing, T0.AddMilliseconds(250)).Close);   // a delete-and-rewrite gap
        Assert.False(t.Step(Text(Json()), T0.AddMilliseconds(500)).Close);
        Assert.False(t.Step(Missing, T0.AddMilliseconds(750)).Close);
        Assert.Equal(new ProgressTick(ProgressPhase.Gone, false, true), t.Step(Missing, T0.AddMilliseconds(1000)));
    }

    [Fact]
    public void Closes_when_the_daemon_stopped_writing()
    {
        var t = new ProgressTracker(T0);
        t.Step(Text(Json(at: T0)), T0);
        Assert.False(t.Step(Text(Json(at: T0)), T0.AddMinutes(9)).Close);
        Assert.True(t.Step(Text(Json(at: T0)), T0.AddMinutes(10).AddSeconds(1)).Close);

        // an already-stale file (left over from a crash) closes at once
        var old = new ProgressTracker(T0);
        Assert.True(old.Step(Text(Json(at: T0.AddHours(-1))), T0).Close);

        // without updatedAt: the time the content last changed counts
        var noTime = new ProgressTracker(T0);
        const string bare = """{"schema":1,"steps":[]}""";
        noTime.Step(Text(bare), T0);
        Assert.False(noTime.Step(Text(bare), T0.AddMinutes(9)).Close);
        Assert.True(noTime.Step(Text(bare), T0.AddMinutes(11)).Close);
    }

    [Fact]
    public void Gives_up_when_no_readable_state_ever_arrives()
    {
        var t = new ProgressTracker(T0);
        Assert.Equal(new ProgressTick(ProgressPhase.Waiting, false, false), t.Step(Locked, T0));
        Assert.False(t.Step(Text("{"), T0.AddSeconds(5)).Close);
        Assert.True(t.Step(Locked, T0.AddSeconds(10)).Close);
        Assert.Null(t.Current);
    }
}

public sealed class ProgressFileTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "mk42-progress-test-" + Guid.NewGuid().ToString("N"));

    public ProgressFileTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void Args_need_one_absolute_json_path()
    {
        Assert.True(ProgressFile.TryParseArgs(["--progress", @"C:\Users\me\AppData\Local\Mark42\run\launch-progress.json"], out var p));
        Assert.Equal(@"C:\Users\me\AppData\Local\Mark42\run\launch-progress.json", p);
        Assert.False(ProgressFile.TryParseArgs(["--progress"], out _));
        Assert.False(ProgressFile.TryParseArgs(["--progress", @"run\launch-progress.json"], out _));
        Assert.False(ProgressFile.TryParseArgs(["--progress", @"C:\x\launch-progress.txt"], out _));
        Assert.False(ProgressFile.TryParseArgs(["--progress", @"C:\x\a.json", "--extra"], out _));
        Assert.False(ProgressFile.TryParseArgs(["--url", @"C:\x\a.json"], out _));
    }

    [Fact]
    public void Mutex_name_is_per_file_and_case_insensitive()
    {
        var a = ProgressFile.MutexName(@"C:\Users\Me\Mark42\run\launch-progress.json");
        Assert.Equal(a, ProgressFile.MutexName(@"c:\users\me\mark42\run\LAUNCH-PROGRESS.json"));
        Assert.NotEqual(a, ProgressFile.MutexName(@"C:\Users\Me\Other\run\launch-progress.json"));
        Assert.Matches("^Mk42\\.Progress\\.[0-9a-f]{40}$", a);
    }

    [Fact]
    public void Reads_missing_text_bom_and_files_being_written()
    {
        var path = Path.Combine(_dir, "launch-progress.json");
        Assert.Equal(ProgressReadKind.Missing, ProgressFile.Read(path).Kind);
        Assert.Equal(ProgressReadKind.Missing, ProgressFile.Read(Path.Combine(_dir, "no-such-dir", "x.json")).Kind);

        File.WriteAllText(path, ProgressSnapshotTests.Sample, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
        var r = ProgressFile.Read(path);
        Assert.Equal(ProgressReadKind.Text, r.Kind);
        Assert.NotNull(ProgressSnapshot.Parse(r.Text!));   // BOM stripped

        // the daemon still holds it open for writing (shared): readable
        using (var w = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete))
            Assert.Equal(ProgressReadKind.Text, ProgressFile.Read(path).Kind);

        // held exclusively: unreadable (the window keeps its last state)
        using (var x = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            Assert.Equal(ProgressReadKind.Unreadable, ProgressFile.Read(path).Kind);

        File.WriteAllBytes(path, new byte[ProgressFile.MaxBytes + 1]);
        Assert.Equal(ProgressReadKind.Unreadable, ProgressFile.Read(path).Kind);
    }
}

public sealed class StringsTests
{
    private static T WithUiCulture<T>(string name, Func<T> f)
    {
        var old = CultureInfo.CurrentUICulture;
        CultureInfo.CurrentUICulture = new CultureInfo(name);
        try { return f(); }
        finally { CultureInfo.CurrentUICulture = old; }
    }

    [Fact]
    public void Follows_the_ui_language()
    {
        Assert.Equal("Mk42 통합 창", WithUiCulture("ko-KR", () => Strings.HubTitle));
        Assert.Equal("Mk42 Hub", WithUiCulture("en-US", () => Strings.HubTitle));
        Assert.Equal("Mk42 Hub", WithUiCulture("ja-JP", () => Strings.HubTitle));      // anything but Korean: English
        Assert.Equal("모르는 인자예요: --x", WithUiCulture("ko-KR", () => Strings.UnknownArgument("--x")));
        Assert.Equal("Unknown argument: --x", WithUiCulture("en-US", () => Strings.UnknownArgument("--x")));
        Assert.Equal("폴더 선택", WithUiCulture("ko-KR", () => HostBridge.ParsePickFolder("""{"type":"pickFolder","id":1}""")!.Title));
        Assert.Equal("Select folder", WithUiCulture("en-GB", () => HostBridge.ParsePickFolder("""{"type":"pickFolder","id":1}""")!.Title));
    }

    [Fact]
    public void Progress_window_prefers_the_file_language()
    {
        Assert.True(WithUiCulture("en-US", () => Strings.IsKoreanLang("ko")));
        Assert.True(WithUiCulture("en-US", () => Strings.IsKoreanLang("ko-KR")));
        Assert.False(WithUiCulture("ko-KR", () => Strings.IsKoreanLang("en")));
        Assert.True(WithUiCulture("ko-KR", () => Strings.IsKoreanLang(null)));
        Assert.False(WithUiCulture("en-US", () => Strings.IsKoreanLang("")));
        Assert.Equal(("숨기기", "닫기", "Mk42 준비 중"), (Strings.ProgressHide(true), Strings.ProgressClose(true), Strings.ProgressTitle(true)));
        Assert.Equal(("Hide", "Close", "Preparing Mk42"), (Strings.ProgressHide(false), Strings.ProgressClose(false), Strings.ProgressTitle(false)));
    }
}
