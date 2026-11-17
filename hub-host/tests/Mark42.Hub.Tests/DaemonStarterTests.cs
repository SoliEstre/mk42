namespace Mark42.Hub.Tests;

public sealed class DaemonStarterTests : IDisposable
{
    private readonly string _home = Path.Combine(Path.GetTempPath(), "mk42-hub-starter-" + Guid.NewGuid().ToString("N"));

    public DaemonStarterTests() => Directory.CreateDirectory(_home);

    public void Dispose()
    {
        try { Directory.Delete(_home, recursive: true); } catch (IOException) { }
    }

    private void Install(string runtime = "24.22.1", string daemon = "2026.1116.35559", string pipe = @"\\.\pipe\mark42-m42d-0123456789ab",
        bool files = true, string? pathField = null)
    {
        if (files)
        {
            Directory.CreateDirectory(Path.Combine(_home, "runtime", $"node-{runtime}"));
            File.WriteAllText(Path.Combine(_home, "runtime", $"node-{runtime}", "node.exe"), "");
            Directory.CreateDirectory(Path.Combine(_home, "daemon", daemon, "daemon", "dist"));
            File.WriteAllText(Path.Combine(_home, "daemon", daemon, "daemon", "dist", "mk42d.mjs"), "");
        }
        var json = System.Text.Json.JsonSerializer.Serialize(new
        {
            home = _home,
            pipe,
            components = new
            {
                runtime = new { version = runtime, path = pathField ?? Path.Combine(_home, "runtime", $"node-{runtime}") },
                daemon = new { version = daemon, path = pathField ?? Path.Combine(_home, "daemon", daemon) },
            },
        });
        File.WriteAllText(Path.Combine(_home, "install.json"), json);
    }

    [Fact]
    public void Plan_comes_from_versions_inside_home()
    {
        Install(pathField: @"D:\elsewhere");   // install.json path strings are not trusted
        var p = DaemonStarter.ReadPlan(_home);
        Assert.NotNull(p);
        Assert.Equal(Path.Combine(_home, "runtime", "node-24.22.1", "node.exe"), p!.Node);
        Assert.Equal(Path.Combine(_home, "daemon", "2026.1116.35559", "daemon", "dist", "mk42d.mjs"), p.Entry);
        Assert.Equal("mark42-m42d-0123456789ab", p.PipeName);
    }

    [Fact]
    public void No_install_record_means_no_plan() => Assert.Null(DaemonStarter.ReadPlan(_home));

    [Fact]
    public void Missing_files_mean_no_plan()
    {
        Install(files: false);
        Assert.Null(DaemonStarter.ReadPlan(_home));
    }

    [Theory]
    [InlineData(@"..\..\x", "2026.1")]
    [InlineData("24.22.1", @"..\evil")]
    [InlineData("24.22.1", "a/b")]
    [InlineData("", "2026.1")]
    public void Unsafe_versions_are_rejected(string runtime, string daemon)
    {
        Install(runtime: "24.22.1", daemon: "2026.1");   // real files exist under the safe names
        var json = File.ReadAllText(Path.Combine(_home, "install.json"))
            .Replace("\"version\":\"24.22.1\"", $"\"version\":{System.Text.Json.JsonSerializer.Serialize(runtime)}")
            .Replace("\"version\":\"2026.1\"", $"\"version\":{System.Text.Json.JsonSerializer.Serialize(daemon)}");
        File.WriteAllText(Path.Combine(_home, "install.json"), json);
        Assert.Null(DaemonStarter.ReadPlan(_home));
    }

    [Theory]
    [InlineData("mark42-m42d-x")]                // not a pipe path
    [InlineData(@"\\.\pipe\bad name")]
    [InlineData(@"\\server\pipe\mark42")]
    public void Bad_pipe_means_no_plan(string pipe)
    {
        Install(pipe: pipe);
        Assert.Null(DaemonStarter.ReadPlan(_home));
    }

    [Fact]
    public void Start_info_matches_the_setup_engine_command_without_boot()
    {
        Install();
        var psi = DaemonStarter.StartInfo(DaemonStarter.ReadPlan(_home)!);
        Assert.False(psi.UseShellExecute);
        Assert.True(psi.CreateNoWindow);
        Assert.Equal(_home, psi.WorkingDirectory);
        Assert.Equal(
            [Path.Combine(_home, "daemon", "2026.1116.35559", "daemon", "dist", "mk42d.mjs"), "--home", _home, "--pipe", @"\\.\pipe\mark42-m42d-0123456789ab"],
            psi.ArgumentList.ToArray());
        Assert.DoesNotContain("--boot", psi.ArgumentList);
        Assert.False(psi.Environment.ContainsKey("MARK42_HOME"));
        Assert.False(psi.Environment.ContainsKey("MARK42_PIPE"));
        Assert.False(psi.Environment.ContainsKey("ELECTRON_RUN_AS_NODE"));
    }

    [Fact]
    public void Pipe_listing_finds_only_existing_pipes()
    {
        var name = "mk42-hub-test-" + Guid.NewGuid().ToString("N");
        Assert.False(DaemonStarter.PipeExists(name));
        using var server = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
            System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly);
        Assert.True(DaemonStarter.PipeExists(name));
    }

    [Fact]
    public void Existing_pipe_is_unresponsive_not_a_second_daemon()
    {
        var name = "mk42-hub-test-" + Guid.NewGuid().ToString("N");
        using var server = new System.IO.Pipes.NamedPipeServerStream(name, System.IO.Pipes.PipeDirection.InOut, 1,
            System.IO.Pipes.PipeTransmissionMode.Byte, System.IO.Pipes.PipeOptions.Asynchronous | System.IO.Pipes.PipeOptions.CurrentUserOnly);
        Install();   // node.exe here is an empty file — it must never be started
        Assert.Equal(DaemonStarter.Outcome.Unresponsive, DaemonStarter.StartAndOpenHub(_home, name, waitMs: 1000));
    }

    [Fact]
    public void Not_installed_when_no_record()
    {
        var name = "mk42-hub-test-" + Guid.NewGuid().ToString("N");
        Assert.Equal(DaemonStarter.Outcome.NotInstalled, DaemonStarter.StartAndOpenHub(_home, name, waitMs: 1000));
    }
}
