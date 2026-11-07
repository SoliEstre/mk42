using System.Text;

namespace Mark42.Hub.Tests;

public sealed class HubArgsTests
{
    private const string Url = "http://127.0.0.1:53854/#token=abc&w=2";

    [Fact]
    public void Parses_url_and_home()
    {
        Assert.True(HubArgs.TryParse(["--url", Url, "--home", @"C:\Users\me\AppData\Local\Mark42\"], out var a, out _));
        Assert.Equal(Url, a!.Url.OriginalString);
        Assert.Equal(@"C:\Users\me\AppData\Local\Mark42", a.Home);
    }

    [Theory]
    [InlineData("--url", Url)]                                                   // no home
    [InlineData("--home", @"C:\h")]                                              // no url
    [InlineData("--url", Url, "--home", "relative")]
    [InlineData("--url", Url, "--home", @"C:\h", "--extra")]
    public void Rejects_incomplete_or_unknown(params string[] args)
    {
        Assert.False(HubArgs.TryParse(args, out _, out var error));
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Theory]
    [InlineData("http://127.0.0.1:53854/#token=x", true)]
    [InlineData("http://127.0.0.1:53854/#token=x&w=9", true)]
    [InlineData("https://127.0.0.1:53854/#token=x", false)]   // the daemon serves http only
    [InlineData("http://localhost:53854/#token=x", false)]
    [InlineData("http://127.0.0.1/#token=x", false)]          // default port
    [InlineData("http://127.0.0.1:80/#token=x", false)]
    [InlineData("http://127.0.0.1:53854/other#token=x", false)]
    [InlineData("http://127.0.0.1:53854/?a=1#token=x", false)]
    [InlineData("http://127.0.0.1:53854/", false)]            // no token
    [InlineData("http://evil.example:53854/#token=x", false)]
    [InlineData("http://u:p@127.0.0.1:53854/#token=x", false)]
    [InlineData("file:///C:/x#token=x", false)]
    public void Hub_url_rule(string url, bool ok) => Assert.Equal(ok, HubUrl.TryParse(url, out _));

    [Fact]
    public void Same_origin_and_external_links()
    {
        Assert.True(HubUrl.TryParse(Url, out var hub));
        Assert.True(HubUrl.SameOrigin(hub, new Uri("http://127.0.0.1:53854/hub-ui.js")));
        Assert.False(HubUrl.SameOrigin(hub, new Uri("http://127.0.0.1:53855/")));
        Assert.False(HubUrl.SameOrigin(hub, new Uri("http://localhost:53854/")));
        Assert.True(HubUrl.IsExternalWebLink(new Uri("https://github.com/x")));
        Assert.False(HubUrl.IsExternalWebLink(new Uri("http://127.0.0.1:9/")));
        Assert.False(HubUrl.IsExternalWebLink(new Uri("file:///C:/Windows/notepad.exe")));
        Assert.Equal("http://127.0.0.1:53854/", HubUrl.ForLog(hub)); // never the token
    }

    [Fact]
    public void Same_document_ignores_only_the_fragment()
    {
        // a new token / window number arrives in the fragment only: Navigate would be a hashchange, so the host reloads
        Assert.True(HubUrl.SameDocument(new Uri("http://127.0.0.1:53854/#token=old&w=1"), new Uri("http://127.0.0.1:53854/#token=new&w=2")));
        Assert.False(HubUrl.SameDocument(new Uri("http://127.0.0.1:53854/#token=a"), new Uri("http://127.0.0.1:53855/#token=a")));
    }
}

public sealed class HubInstanceTests
{
    [Fact]
    public void Name_is_per_user_session_and_home()
    {
        Assert.Equal(HubInstance.NameFor(@"C:\Users\Me\Mark42"), HubInstance.NameFor(@"c:\users\me\mark42\"));
        Assert.NotEqual(HubInstance.NameFor(@"C:\a"), HubInstance.NameFor(@"C:\b"));
        Assert.Matches("^Mark42\\.Hub\\.[0-9a-f]{16}$", HubInstance.NameFor(@"C:\a"));
        // another account or another session of the same user gets a different name (not guessable from the home alone)
        Assert.NotEqual(HubInstance.NameFor(@"C:\a", "S-1-5-21-1", 2), HubInstance.NameFor(@"C:\a", "S-1-5-21-2", 2));
        Assert.NotEqual(HubInstance.NameFor(@"C:\a", "S-1-5-21-1", 2), HubInstance.NameFor(@"C:\a", "S-1-5-21-1", 3));
    }

    [Fact]
    public void Second_start_forwards_its_url_to_the_first()
    {
        var home = Path.Combine(Path.GetTempPath(), "mk42-hub-test-" + Guid.NewGuid().ToString("n"));
        using var first = HubInstance.TryAcquire(home);
        Assert.NotNull(first);
        Assert.Null(HubInstance.TryAcquire(home)); // one per home
        Uri? received = null;
        bool accept = true;
        first!.Listen(u => { received = u; return accept; });
        // acknowledged: the running window took it
        Assert.True(HubInstance.Forward(home, new Uri("http://127.0.0.1:53854/#token=t&w=3")));
        Assert.Equal("http://127.0.0.1:53854/#token=t&w=3", received!.OriginalString);
        // a window that is closing refuses: no ack, so the sender starts its own window instead
        accept = false;
        Assert.False(HubInstance.Forward(home, new Uri("http://127.0.0.1:53854/#token=t&w=4"), timeoutMs: 500));
        // nobody listening there
        Assert.False(HubInstance.Forward(home + "-other", new Uri("http://127.0.0.1:53854/#token=t"), timeoutMs: 200));
        first.StopListening();
        Assert.False(HubInstance.Forward(home, new Uri("http://127.0.0.1:53854/#token=t&w=5"), timeoutMs: 300));
    }

    [Fact]
    public async Task Read_line_stops_at_newline_and_refuses_oversized()
    {
        Assert.Equal("abc", await HubInstance.ReadLineAsync(new MemoryStream(Encoding.UTF8.GetBytes("abc\r\nrest")), 1000));
        Assert.Equal("abc", await HubInstance.ReadLineAsync(new MemoryStream(Encoding.UTF8.GetBytes("abc")), 1000));
        Assert.Null(await HubInstance.ReadLineAsync(new MemoryStream(new byte[HubInstance.MaxMessageBytes + 10]), 1000));
        Assert.Null(await HubInstance.ReadLineAsync(new MemoryStream(), 1000));
    }
}

public sealed class HubLauncherTests
{
    private static string? NoEnv(string _) => null;

    [Fact]
    public void Home_from_args_env_or_localappdata()
    {
        Dictionary<string, string> env = new() { ["LOCALAPPDATA"] = @"C:\Users\me\AppData\Local" };
        Assert.True(HubLauncher.TryParseHome([], k => env.GetValueOrDefault(k), out var home, out _));
        Assert.Equal(@"C:\Users\me\AppData\Local\Mark42", home); // the same text as the daemon default (it goes into the pipe hash)
        env["MARK42_HOME"] = @"D:\m42";
        Assert.True(HubLauncher.TryParseHome([], k => env.GetValueOrDefault(k), out home, out _));
        Assert.Equal(@"D:\m42", home);
        Assert.True(HubLauncher.TryParseHome(["--home", @"E:\h"], NoEnv, out home, out _));
        Assert.Equal(@"E:\h", home);
        Assert.False(HubLauncher.TryParseHome(["--home", "relative"], NoEnv, out _, out var e1));
        Assert.False(HubLauncher.TryParseHome(["--other"], NoEnv, out _, out var e2));
        Assert.False(string.IsNullOrEmpty(e1) || string.IsNullOrEmpty(e2));
    }

    [Fact]
    public void Pipe_name_from_hub_json_else_the_daemon_default()
    {
        var home = Path.Combine(Path.GetTempPath(), "mk42-hub-test-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(home);
        try
        {
            // packages/protocol defaultPipeName: sha256("<user>\n<home>") first 12 hex
            var expected = "mark42-m42d-" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes($"me\n{home}")))[..12];
            Assert.Equal(expected, HubLauncher.PipeNameFor(home, "me"));
            File.WriteAllText(Path.Combine(home, "hub.json"), """{"port":53854,"pipe":"\\\\.\\pipe\\mark42-m42d-custom"}""");
            Assert.Equal("mark42-m42d-custom", HubLauncher.PipeNameFor(home, "me"));
            File.WriteAllText(Path.Combine(home, "hub.json"), """{"port":53854,"pipe":"\\\\server\\pipe\\x"}""");
            Assert.Equal(expected, HubLauncher.PipeNameFor(home, "me")); // only a local pipe
            File.WriteAllText(Path.Combine(home, "hub.json"), """{"port":53854}""");
            Assert.Equal(expected, HubLauncher.PipeNameFor(home, "me")); // an older daemon
        }
        finally { Directory.Delete(home, recursive: true); }
    }

    [Theory]
    [InlineData(@"\\.\pipe\mark42-m42d-8e7882229610", "mark42-m42d-8e7882229610")]
    [InlineData("//./pipe/mark42-x", "mark42-x")]
    [InlineData(@"\\.\pipe\a\b", null)]
    [InlineData(@"\\.\pipe\", null)]
    [InlineData(@"\\host\pipe\x", null)]
    [InlineData(@"C:\x", null)]
    public void Short_pipe_name(string full, string? name)
    {
        Assert.Equal(name is not null, HubLauncher.TryShortPipeName(full, out var got));
        if (name is not null) Assert.Equal(name, got);
    }

    [Fact]
    public void Asks_the_daemon_and_reads_its_reply()
    {
        var name = "mk42-hub-test-" + Guid.NewGuid().ToString("n");
        string? request = null;
        var server = Task.Run(async () =>
        {
            using var s = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
                System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly);
            await s.WaitForConnectionAsync();
            request = await HubInstance.ReadLineAsync(s, 3000);
            // a notification may come first; the reply is the line with id 1
            await s.WriteAsync(Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"method\":\"state.changed\",\"params\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"url\":\"x\"}}\n"));
            await s.FlushAsync();
            s.WaitForPipeDrain();
        });
        Assert.Equal(HubLauncher.Result.Opened, HubLauncher.AskOpenHub(name, 5000));
        server.Wait(5000);
        Assert.Equal("""{"jsonrpc":"2.0","id":1,"method":"$/openHub","params":{}}""", request);
        Assert.Equal(HubLauncher.Result.NoDaemon, HubLauncher.AskOpenHub(name + "-none", 300));
    }

    [Theory]
    [InlineData("""{"jsonrpc":"2.0","id":1,"result":{}}""", "Opened")]
    [InlineData("""{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"hub server disabled"}}""", "Refused")]
    [InlineData("""{"jsonrpc":"2.0","id":2,"result":{}}""", null)]
    [InlineData("""{"jsonrpc":"2.0","method":"x"}""", null)]
    [InlineData("not json", null)]
    public void Classifies_reply_lines(string line, string? expected) => Assert.Equal(expected, HubLauncher.Classify(line)?.ToString());

    [Fact]
    public async Task Reply_reader_spans_chunks_and_gives_up_on_close()
    {
        var bytes = Encoding.UTF8.GetBytes("{\"method\":\"a\"}\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n");
        Assert.Equal(HubLauncher.Result.Opened, await HubLauncher.ReadReplyAsync(new MemoryStream(bytes), CancellationToken.None));
        Assert.Equal(HubLauncher.Result.NoDaemon, await HubLauncher.ReadReplyAsync(new MemoryStream(Encoding.UTF8.GetBytes("{\"id\":1")), CancellationToken.None));
    }
}

public sealed class HostBridgeTests
{
    [Fact]
    public void Pick_folder_request_is_parsed_strictly()
    {
        var r = HostBridge.ParsePickFolder("""{"type":"pickFolder","id":7,"title":"클론할 위치","initial":"C:\\Dev"}""");
        Assert.Equal(new HostBridge.PickFolderRequest(7, "클론할 위치", @"C:\Dev"), r);
        Assert.Equal(Strings.PickFolderDefaultTitle, HostBridge.ParsePickFolder("""{"type":"pickFolder","id":1}""")!.Title);
        Assert.Null(HostBridge.ParsePickFolder("""{"type":"pickFolder","id":1,"initial":"relative\\x"}""")!.Initial);
        Assert.Equal(HostBridge.MaxTitleLength, HostBridge.ParsePickFolder($$"""{"type":"pickFolder","id":1,"title":"{{new string('a', 500)}}"}""")!.Title.Length);
        Assert.Null(HostBridge.ParsePickFolder("""{"type":"other","id":1}"""));
        Assert.Null(HostBridge.ParsePickFolder("""{"type":"pickFolder","id":"1"}"""));
        Assert.Null(HostBridge.ParsePickFolder("""["pickFolder"]"""));
        Assert.Null(HostBridge.ParsePickFolder("not json"));
    }

    [Fact]
    public void Pick_folder_result_round_trips()
    {
        Assert.Equal("""{"type":"pickFolderResult","id":3,"path":"C:\\Dev\\x"}""", HostBridge.PickFolderResult(3, @"C:\Dev\x"));
        Assert.Equal("""{"type":"pickFolderResult","id":3,"path":null}""", HostBridge.PickFolderResult(3, null));
        Assert.Contains("mk42HubHost", HostBridge.MarkerScript);
    }
}

public sealed class HubPlacementTests
{
    private static readonly Rectangle Primary = new(0, 0, 1920, 1040);

    [Fact]
    public void Default_is_centered_on_the_primary_screen()
    {
        var r = HubPlacement.Fit(null, [Primary], Primary);
        Assert.Equal(new Rectangle(410, 140, 1100, 760), r);
    }

    [Fact]
    public void Saved_place_is_kept_when_on_a_screen_and_shrunk_to_it()
    {
        Assert.Equal(new Rectangle(100, 50, 800, 600), HubPlacement.Fit(new(100, 50, 800, 600, false), [Primary], Primary));
        Assert.Equal(new Rectangle(0, 0, 1920, 1040), HubPlacement.Fit(new(0, 0, 3000, 2000, false), [Primary], Primary));
    }

    [Fact]
    public void Saved_place_whose_title_bar_is_off_screen_falls_back_to_default()
    {
        // body overlaps the screen but the title bar is above it: could not be dragged back
        Assert.Equal(HubPlacement.Fit(null, [Primary], Primary), HubPlacement.Fit(new(100, -300, 800, 600, false), [Primary], Primary));
        // title bar mostly off to the left, only 100 px visible
        Assert.Equal(HubPlacement.Fit(null, [Primary], Primary), HubPlacement.Fit(new(-700, 100, 800, 600, false), [Primary], Primary));
    }

    [Fact]
    public void Saved_place_on_a_screen_that_is_gone_falls_back_to_default()
    {
        Assert.Equal(HubPlacement.Fit(null, [Primary], Primary), HubPlacement.Fit(new(4000, 100, 800, 600, false), [Primary], Primary));
        Assert.Equal(HubPlacement.Fit(null, [Primary], Primary), HubPlacement.Fit(new(100, 100, 100, 100, false), [Primary], Primary));
    }
}

public sealed class HubFormTests
{
    [Fact]
    public void Title_bar_colors_are_colorrefs() => Assert.Equal(0x0018107A, HubForm.ColorRef(0x7a, 0x10, 0x18));
}

public sealed class HubIconTests
{
    private static string Root()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "Mark42.Hub.slnx"))) return d.FullName;
        throw new DirectoryNotFoundException("Mark42.Hub.slnx not found above the test output.");
    }

    /// <summary>exe 아이콘 파일이 그림과 같아요. 그림을 바꾸면 <c>$env:MK42_WRITE_ICONS=1; dotnet test --filter HubIconTests</c>로 다시 만들어요.</summary>
    [Fact]
    public void Exe_icon_matches_the_art()
    {
        var expected = HubIcon.BuildIco(HubIcon.Sizes);
        var path = Path.Combine(Root(), "src", "Mark42.Hub", "Assets", "mk42-hub.ico");
        if (Environment.GetEnvironmentVariable("MK42_WRITE_ICONS") == "1") File.WriteAllBytes(path, expected);
        Assert.True(File.Exists(path), "mk42-hub.ico is missing — regenerate with MK42_WRITE_ICONS=1");
        Assert.True(expected.AsSpan().SequenceEqual(File.ReadAllBytes(path)), "mk42-hub.ico is stale — regenerate with MK42_WRITE_ICONS=1");
        using var icon = HubIcon.Create();
        Assert.True(icon.Width > 0);
    }
}
