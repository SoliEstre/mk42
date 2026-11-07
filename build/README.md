# build — Mark42 패치 빌드 (단계 5)

**Mark42 앱(`Mk42.exe`)**을 업스트림 Code - OSS에서 만들어요. 결정 D7·D21·D41·D47.

| 파일 | 내용 |
|---|---|
| `upstream.json` | 고정한 업스트림 태그·커밋, 작업 폴더(기본 repo 옆 `../mk42-build/vscode` — 공백 없는 경로로. `MK42_UPSTREAM_DIR`로 바꿔요, 규칙은 `scripts/paths.mjs`) |
| `product.overlay.json` | `product.json`에 합치는 값 — 이름(`Mk42.exe`·«Mark42»), 데이터 폴더 `.mk42`, `mark42://`, Open VSX, Codex API 제안 허용, `quality: stable`, 내장 Copilot 계정 무력화. `null`은 키 지우기 |
| `patches/*.patch` | 업스트림 소스 패치(아래) |
| `scripts/apply.mjs` | 작업 폴더 확인 → 패치 적용(이미 적용된 건 건너뜀) → overlay 합치기 → Mk42 아이콘. `--check`는 상태만 |
| `scripts/build.ps1` | Build Tools 개발자 셸 → apply → `npm ci` → `npm run gulp vscode-win32-x64-min` → `<작업 폴더의 부모>\VSCode-win32-x64\Mk42.exe` |
| `scripts/install.ps1` | (개발용) 빌드한 앱을 `%LOCALAPPDATA%\Mark42\app\Mk42-<태그>-<커밋>`에 복사만 |
| `scripts/package.mjs` | **설치 패키지** — 아래 «설치 패키지» |
| `installer/mk42.iss` | 설치 마법사(Inno Setup 6) — `package.mjs --exe`가 컴파일 |

## 패치 `0001-mark42-core.patch`

| 바꾼 곳 | 내용 |
|---|---|
| `build/lib/electron.ts`, `build/gulpfile.vscode.ts` rcedit | 실행 파일 버전 정보의 회사·저작권을 Mark42로(설명·제품 이름은 `nameLong` = «Mark42» → 작업 관리자 표시) |
| `build/gulpfile.vscode.ts` | 내장 Copilot Chat 확장 빌드·copilot 셸 심·ripgrep 심 빼기, `quality: stable`이어도 `win32ContextMenu`가 없으면 AppX 건너뛰기 |
| `build/lib/extensions.ts` | 쓰지 않는 기본 확장 빼기: microsoft-authentication, tunnel-forwarding, grunt, gulp, jake, ipynb, notebook-renderers, debug-server-ready, debug-auto-launch, simple-browser, extension-editing, terminal-suggest |
| `agentHostEnablementService.ts` | Agent Host 끄기(D21 — copilot-runtime.exe·agentHost 프로세스 없음) |
| `windowsMainService.ts` | Agents 창 열기 막기(Mk42) |
| `extensionManagementService.ts` + 기본값 `extensions.verifySignature: false` | Code - OSS에는 Microsoft 서명 검사 모듈이 없어서 갤러리(Open VSX) 설치가 모두 «Signature verification was not executed»로 실패 → 서명 검사 기본 끔(VSCodium과 같음, 사용자 결정 2026-10-27). 설정에서 켤 수는 있어요 |
| `src/vs/mark42/common/mark42Defaults.ts` (+ `main.ts`·`workbench.desktop.main.ts`에서 import) | 기본값: 내장 AI·Agent Host 끔, 텔레메트리·실험·업데이트 끔, 창 복원은 데몬이, 시작 화면·팁·추천 끔 |

패치를 고칠 때는 작업 폴더에서 고친 뒤 `git add -N <새 파일>; git diff -- . ':!product.json' ':!resources/win32/code.ico' ':!src/vs/workbench/browser/media/code-icon.svg' > <repo>\build\patches\0001-mark42-core.patch`로 다시 뽑아요(아이콘 두 개는 `apply.mjs`가 복사해요).

## 설치 패키지 (`scripts/package.mjs`, D51)

다른 PC(또는 이 PC)에 Mk42 전체(앱·데몬·통합 창·확장·Node 실행기)를 설치하는 폴더를 만들고, 원하면 **설치 마법사 exe**(`--exe`)·zip도 만들어요.

```powershell
node build\scripts\package.mjs [--app <Mk42 앱 폴더>] [--app-version <태그-커밋>] [--out <폴더>] [--exe] [--zip] [--skip-build]
# → <작업 폴더의 부모>\dist\Mk42-<YYYY.MMDD.HHmmss>\  (--exe이면 옆에 Mk42-Setup-<버전>.exe, --zip이면 .zip)
```

- **설치 마법사**(`installer/mk42.iss`, Inno Setup 6 — `winget install JRSoftware.InnoSetup --scope user`, 또는 `ISCC` 환경 변수): 패키지 폴더를 lzma2로 통째로 담아요. «설치»를 누르면 준비 단계에서 임시 폴더에 풀고 같은 설치 엔진을 돌려요(엔진이 실패하면 거기서 멈춰 제거 항목도 남지 않아요). 관리자 권한 없이 사용자 계정에만, 설치 위치는 home으로 정해져 있고, «로그온할 때 자동 실행» 선택·끝 화면 «통합 창 열기»가 있어요. «설정 → 앱»의 제거는 엔진 `uninstall`(아래)을 돌려요. 창을 닫는 Inno 기본 동작은 꺼요.
- 시험 빌드: ISCC에 `/DTest`를 주면 제거 항목 ID·이름이 다르고 압축하지 않아요. 설치 위치는 `/MK42HOME=<dir>`, 엔진 인자는 `/MK42ARGS="…"`(예: `--mk42-data <dir> --no-shortcut`), 조용히는 `/VERYSILENT /SUPPRESSMSGBOXES /TASKS=""`.

- 앱은 기본으로 **이 PC 데몬이 지금 쓰는 Mark42 앱 폴더**(registry.json)를 넣어요. 새 빌드를 넣으려면 `build.ps1` → `install.ps1` 뒤 그 폴더를 `--app`으로.
- 데몬·확장은 빌드해서(`npm run build`, `npm run package -w extension`), 통합 창 exe는 임시 폴더로 `dotnet publish`해서 넣어요. Node 실행기는 이 스크립트를 돌리는 `node.exe`(24 이상)예요.
- 패키지: `Setup.cmd`, `manifest.json`(구성 요소별 버전·트리 해시), `files\<구성 요소>.json`(파일별 sha256), `runtime\`·`daemon\`·`app\`·`hub\`·`extension\`, `setup\mk42-setup.mjs`(설치 엔진 — `daemon/src/setup/`).
- 설치 엔진: 해시 확인 → `%LOCALAPPDATA%\Mark42`의 버전 폴더(`runtime\node-<v>`·`daemon\<v>`·`app\Mk42-<v>`)와 한 자리(`hub\mk42-hub.exe`·`extension\`)에 복사(같은 버전은 건너뜀) → 데몬 끄기(`$/shutdown`, 옛 데몬은 파이프로 찾아 프로세스 종료 — Mk42 창은 그대로) → registry.json 백업·반영 → 로그온 작업(이 home 것일 때만) → 시작 메뉴 «Mk42»(기본 home만) → `install.json` → 데몬 다시 띄우기. `Setup.cmd --dry-run`은 검사·계획만, `node setup\mk42-setup.mjs status|stop`. 엔진 사본은 `home\setup\mk42-setup.mjs`에도 둬요(제거·나중 업데이트용).
- 제거 엔진(`uninstall [--check] [--purge]`): Mk42 home인지(설치 기록) 확인 → 관리자 권한 거절 → home 아래 실행 중인 Mk42 창·통합 창이 있으면 종료 코드 3으로 멈춤(창을 대신 닫지 않아요) → 데몬 끄기(설치 기록의 파이프) → 로그온 작업(이 home 것일 때만)·시작 메뉴 지우기 → registry.json에서 이 home 앱 항목만 빼기 → 프로그램 폴더(`runtime·daemon·app·hub·extension·setup`)·`install.json` 지우기. 설정·기록은 남겨요. `--purge`는 아는 파일(설정·로그·roles 등)도 지워요. Mk42 앱 데이터(`.mk42`)는 늘 남아요. 마법사는 home 밖에 node·엔진을 복사해 돌리고(자기 자신을 지울 수 없어서), 엔진이 멈추면 제거 항목을 남겨 둬요. 로그는 `%TEMP%\mk42-uninstall.log`.

## 준비물

Node 24.x(업스트림 `.nvmrc` 24.18.0 이상), Python 3, **VS 2026 Build Tools(C++ 워크로드 + 스펙터 완화 라이브러리)** — Community 설치에는 스펙터 라이브러리가 없어서 `build.ps1`이 Build Tools 개발자 셸을 써요. Git. Rust·7-Zip은 필요 없어요(업스트림 설치기·CLI를 만들지 않아요). 설치 마법사(`package.mjs --exe`)에는 Inno Setup 6이 필요해요.
