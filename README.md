# Mk42

**Mk42** (Mark42) is a lightweight editor built on [Code - OSS](https://github.com/microsoft/vscode) for working with AI coding agents. It runs the **Claude Code** and **Codex** VS Code extensions in their own agent windows, and adds a hub window and a small resident daemon to keep many projects and sessions in order.

> **Status:** pre-release. There is no public build yet. Windows x64 is the only platform built so far.

[한국어](#한국어) · [License](#license)

## What it does

- **One window, one agent.** Each project folder opens in an agent window that runs exactly one agent extension (Claude Code or Codex). Links and previews open in a separate, simplified editor window for the same folder.
- **Hub window.** Registered folders, their running agent windows, and the Claude Code / Codex session history in one place. Open, resume, or pin sessions from there.
- **Pinned sessions and resume at logon.** Pin sessions with their model and effort settings, and optionally reopen them when you sign in, with a resume prompt filled in.
- **Background tasks view.** Workflows and sub-agents of recent sessions, read from the agents' local files.
- **Self-update.** Signed update channel (Ed25519); the update is downloaded in the background and installs only when you say so. Open windows are not closed.

Mk42 does not bundle the agent extensions. On first run it installs them from [Open VSX](https://open-vsx.org) into Mk42's own extension folder. Each build is checked against reference hashes of the official build before it is installed; when no reference is available yet, Mk42 asks you first. (The signed reference-hash list is still being built.)

## Privacy

- No telemetry. Mk42 turns off the editor's telemetry and experiments by default.
- The daemon **reads** (never writes) the agents' local session files (`~/.claude`, `~/.codex`) to list sessions: working folder, session title, the first 200 characters of the last prompt, model and effort. Nothing of it leaves the machine. (The optional `codexIndexer` setting `auto`/`appServer` starts `codex app-server`, which may write to its own database; the default does not.)
- Network: Open VSX (extensions), `raw.githubusercontent.com` (the Open VSX extension-control list), and the Mk42 update server (update check about every 6 hours — the server log keeps the IP address and the installed version).
- The Claude Code and Codex extensions are separate products and follow their own terms and privacy policies.

## Building from source

Requirements: Windows 10/11 x64, Node.js 24+, .NET SDK 10 (hub window), Visual Studio Build Tools with the C++ workload (app build), Inno Setup 6 (installer).

```powershell
npm ci
npm run build      # daemon, extension and hub UI bundles
npm run typecheck
npm test           # never touches your real ~/.claude or ~/.codex
dotnet test hub-host\Mark42.Hub.slnx
```

The app itself is Code - OSS at a pinned tag plus one patch — see [build/README.md](build/README.md). The upstream work folder defaults to `../mk42-build/vscode` next to this repository; set `MK42_UPSTREAM_DIR` to use another one.

| Folder | Contents |
| --- | --- |
| `packages/protocol` | Shared types, IPC method table, NDJSON JSON-RPC, paths |
| `daemon` | `mk42d` — folder and pinned-session registry, session indexers, window launcher, resume, self-update, setup engine |
| `extension` | The built-in Mk42 extension (window roles, agent panel control, hub webview) and `hub-ui` (hub screen, plain TS + DOM) |
| `hub-host` | `mk42-hub.exe` — the hub window (.NET WinForms + WebView2) |
| `build` | Pinned upstream, product overlay, core patch, packaging and installer |

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) (DCO sign-off). Security reports: [SECURITY.md](SECURITY.md).

## License

Mk42's own code is licensed under the [Apache License 2.0](LICENSE). Code - OSS and the other bundled components keep their own licenses — see [NOTICE](NOTICE). The names **Mk42** and **Mark42** and the Mk42 icon are not covered by the license — see [TRADEMARKS.md](TRADEMARKS.md).

Mk42 is an independent project and is not affiliated with or endorsed by Microsoft, Anthropic or OpenAI. "Visual Studio Code" is a trademark of Microsoft; "Claude" and "Claude Code" are trademarks of Anthropic; "Codex" is a trademark of OpenAI.

---

## 한국어

**Mk42**(Mark42)는 [Code - OSS](https://github.com/microsoft/vscode)를 바탕으로 AI 코딩 에이전트와 일하기 위해 가볍게 만든 편집기예요. **Claude Code**·**Codex** VS Code 확장을 각자의 에이전트 창에서 돌리고, 통합 창과 작은 상주 데몬으로 여러 프로젝트와 세션을 정리해요.

> **상태:** 공개 전이에요. 아직 공개 빌드는 없고, 지금은 Windows x64만 빌드해요.

- **창 하나에 에이전트 하나.** 폴더마다 에이전트 창을 열고 확장 하나(Claude Code 또는 Codex)만 돌려요. 링크·미리보기는 그 폴더의 간소한 편집기 창에서 열어요.
- **통합 창.** 등록한 폴더, 떠 있는 에이전트 창, Claude Code·Codex 세션 기록을 한곳에서 보고 열고 이어 가고 고정해요.
- **고정 세션·로그온 때 재개.** 모델·effort 설정과 함께 세션을 고정하고, 원하면 로그온할 때 재개 프롬프트와 함께 다시 열어요.
- **백그라운드 작업 보기.** 최근 세션의 워크플로·서브에이전트를 에이전트 로컬 파일에서 읽어 보여 줘요.
- **자체 업데이트.** 서명된(Ed25519) 업데이트 채널 — 뒤에서 받아 두고, 설치는 사용자가 정할 때만 해요. 열린 창은 닫지 않아요.

에이전트 확장은 Mk42에 동봉하지 않아요. 첫 실행 때 [Open VSX](https://open-vsx.org)에서 Mk42 전용 확장 폴더에 깔아요. 깔기 전에 공식 판의 기준 해시와 대조하고, 기준이 아직 없으면 먼저 물어요(서명된 기준 해시 목록은 만드는 중이에요).

**개인정보:** 텔레메트리 없음. 데몬은 세션 목록을 위해 에이전트의 로컬 세션 파일(`~/.claude`, `~/.codex`)을 **읽기만** 해요(작업 폴더·세션 제목·마지막 프롬프트 앞 200자·모델·effort) — 기기 밖으로 보내지 않아요. 접속하는 곳은 Open VSX, `raw.githubusercontent.com`(Open VSX 확장 제어 목록), Mk42 업데이트 서버(약 6시간마다 확인 — 서버 로그에 IP와 설치 판이 남아요)예요. Claude Code·Codex 확장은 각자의 약관·개인정보 방침을 따라요.

**라이선스:** Mk42 자체 코드는 [Apache License 2.0](LICENSE)이에요. Code - OSS와 함께 들어가는 구성 요소는 각자의 라이선스를 따라요([NOTICE](NOTICE)). **Mk42**·**Mark42** 이름과 Mk42 아이콘은 라이선스에 들어 있지 않아요([TRADEMARKS.md](TRADEMARKS.md)). Mk42는 Microsoft·Anthropic·OpenAI와 관계없는 독립 프로젝트예요.
