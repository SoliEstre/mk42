# 빌드한 Mark42 앱(<빌드 작업 폴더의 부모>\VSCode-win32-x64)을 버전 폴더 %LOCALAPPDATA%\Mark42\app\Mk42-<버전>-<mark42 커밋>[-dirty]에 복사해요.
# 실행 중인 다른 버전 폴더는 건드리지 않아요(창을 닫지 않고 바꿔 끼우기 — 데몬 settings.apps가 새 폴더를 가리키게).
# 복사는 «<폴더>.partial»에 다 한 뒤 이름을 바꿔요 — 중간에 끊긴 복사가 설치된 것으로 보이지 않게.
#   powershell -File build\scripts\install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Join-Path $here '..\..'
$upstream = Get-Content (Join-Path $here '..\upstream.json') -Raw | ConvertFrom-Json
# 작업 폴더: MK42_UPSTREAM_DIR → build\internal\upstream.local.json(판 덧층) → upstream.json workdir(repo 루트 기준, paths.mjs와 같은 규칙)
$local = Join-Path $here '..\internal\upstream.local.json'
$work = if ($env:MK42_UPSTREAM_DIR) { $env:MK42_UPSTREAM_DIR } elseif (Test-Path $local) { (Get-Content $local -Raw | ConvertFrom-Json).workdir } else { $upstream.workdir }
if (-not [System.IO.Path]::IsPathRooted($work)) { $work = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $here '..\..') $work)) }
$src = Join-Path (Split-Path -Parent $work) 'VSCode-win32-x64'
if (-not (Test-Path (Join-Path $src 'Mk42.exe'))) { throw "no build at $src (run build.ps1)" }
$rev = (git -C $repo rev-parse --short=7 HEAD).Trim()
# 커밋하지 않은 build\ 변경으로 만든 빌드는 이름에 표시(같은 커밋의 깨끗한 빌드로 보이지 않게)
if (git -C $repo status --porcelain -- build) { $rev = "$rev-dirty-$(Get-Date -Format yyyyMMddHHmm)" }
$dest = Join-Path $env:LOCALAPPDATA "Mark42\app\Mk42-$($upstream.tag)-$rev"
if (Test-Path (Join-Path $dest 'Mk42.exe')) {
    Write-Host "already installed: $dest"
} else {
    $partial = "$dest.partial"
    if (Test-Path $partial) { Remove-Item -Recurse -Force $partial }
    New-Item -ItemType Directory -Force $partial | Out-Null
    robocopy $src $partial /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    Rename-Item $partial (Split-Path -Leaf $dest)
    Write-Host "installed: $dest"
}
Join-Path $dest 'Mk42.exe'
