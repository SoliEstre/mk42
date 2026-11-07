# Contributing

Thanks for helping. Issues (bugs, ideas) and pull requests are welcome.

- **Sign-off (DCO).** Every commit must carry a `Signed-off-by: Your Name <you@example.com>` line (`git commit -s`), certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Contributions are accepted under the Apache License 2.0.
- **Before a pull request:** `npm run typecheck`, `npm test`, and `dotnet test hub-host\Mark42.Hub.slnx` pass. Tests must never touch your real `~/.claude` or `~/.codex`.
- **Scope.** Keep changes focused. For larger features, open an issue first.
- **Comments and docs.** Much of the code is commented in Korean. English or Korean are both fine in new code; user-facing strings need both (`extension/l10n`, `extension/hub-ui/src/i18n.ts`, `hub-host/.../Strings.cs`, `daemon/src/i18n.ts`).
- **Security issues** go through [SECURITY.md](SECURITY.md), not public issues.

**한국어:** 이슈와 풀 리퀘스트를 환영해요. 커밋마다 DCO 서명(`git commit -s`)이 필요하고, 기여는 Apache License 2.0으로 받아요. 풀 리퀘스트 전에 타입 검사와 시험이 통과해야 해요(시험은 실제 `~/.claude`·`~/.codex`를 건드리지 않아야 해요). 화면 문구는 영어·한국어를 함께 넣어 주세요. 보안 문제는 공개 이슈 대신 [SECURITY.md](SECURITY.md)로 알려 주세요.
