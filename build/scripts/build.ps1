# Mark42 패치 빌드(PM/005 §4): 업스트림 작업 폴더에 Mark42를 적용하고 Windows x64 앱 폴더를 만들어요.
#   powershell -File build\scripts\build.ps1 [-SkipInstall]
# 결과: <workdir 부모>\VSCode-win32-x64 (Mk42.exe). 설치기·서명·CLI는 만들지 않아요.
# 스펙터 완화 라이브러리가 있는 Build Tools 개발자 셸에서 돌려요(Community 설치에는 없어서 node-gyp가 MSB8040으로 실패 — 2026-10-27).
param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$upstream = Get-Content (Join-Path $here '..\upstream.json') -Raw | ConvertFrom-Json
# 작업 폴더: MK42_UPSTREAM_DIR → build\internal\upstream.local.json(판 덧층) → upstream.json workdir(repo 루트 기준, paths.mjs와 같은 규칙)
$local = Join-Path $here '..\internal\upstream.local.json'
$work = if ($env:MK42_UPSTREAM_DIR) { $env:MK42_UPSTREAM_DIR } elseif (Test-Path $local) { (Get-Content $local -Raw | ConvertFrom-Json).workdir } else { $upstream.workdir }
if (-not [System.IO.Path]::IsPathRooted($work)) { $work = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $here '..\..') $work)) }

# 스펙터 라이브러리가 있는 VS(Build Tools 2026·2022 등)를 vswhere로 찾아요 — PC마다 판이 달라요(옛 PC 2026, 새 PC 2022)
if (-not $env:VCINSTALLDIR) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -products * -latest -requires Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre -property installationPath
    if (-not $vs) { throw 'no Visual Studio with «MSVC x64/x86 Spectre-mitigated libs» — add that component in the VS Installer' }
    & (Join-Path $vs 'Common7\Tools\Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
}

node (Join-Path $here 'apply.mjs')
if ($LASTEXITCODE -ne 0) { throw 'apply failed' }

$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$env:FOUNDRY_LOCAL_SKIP_INSTALL = '1'
$env:npm_config_arch = 'x64'
Push-Location $work
try {
    if (-not $SkipInstall) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    }
    # 메모리를 넉넉히(번들 단계)
    $env:NODE_OPTIONS = '--max-old-space-size=16384'
    $started = Get-Date
    npm run gulp vscode-win32-x64-min
    if ($LASTEXITCODE -ne 0) {
        # 마지막 단계(컴파일 캐시)만 가끔 경합으로 실패해요 — 묶기가 이번에 끝났으면(main.js가 새것) 그 단계만 다시
        $mainJs = Join-Path (Split-Path -Parent $work) 'VSCode-win32-x64\resources\app\out\main.js'
        if (-not ((Test-Path $mainJs) -and (Get-Item $mainJs).LastWriteTime -gt $started)) { throw 'gulp vscode-win32-x64-min failed' }
        Write-Host 'gulp failed after packaging: retrying the Node.js compile cache step'
        node (Join-Path $here 'compile-cache-retry.mjs') $work
        if ($LASTEXITCODE -ne 0) { throw 'gulp vscode-win32-x64-min failed (compile cache)' }
    }
}
finally { Pop-Location }

$out = Join-Path (Split-Path -Parent $work) 'VSCode-win32-x64'
# 뺀 기본 확장(ipynb·notebook-renderers·simple-browser 등)의 화면 빌드 찌꺼기 — package.json 없는 폴더는 VS Code가 무시하지만 치워요
Get-ChildItem (Join-Path $out 'resources\app\extensions') -Directory |
    Where-Object { $_.Name -ne 'node_modules' -and -not (Test-Path (Join-Path $_.FullName 'package.json')) } |
    ForEach-Object { Write-Host "remove leftover extensions\$($_.Name)"; Remove-Item -Recurse -Force $_.FullName }
$exe = Join-Path $out 'Mk42.exe'
if (-not (Test-Path $exe)) { throw "Mk42.exe not found in $out" }
(Get-Item $exe).VersionInfo | Select-Object FileDescription, ProductName, CompanyName, ProductVersion | Format-List
