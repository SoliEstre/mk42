; Mk42 설치 마법사(Inno Setup 6) — build/scripts/package.mjs --exe가 패키지 폴더를 만든 뒤 ISCC로 컴파일해요.
; 실제 설치는 패키지의 설치 엔진(setup\mk42-setup.mjs)이 해요: 마법사는 패키지를 임시 폴더에 풀고 엔진을 돌려 진행을 보여 줘요.
; 엔진이 실패하면 «준비» 단계에서 멈춰서 제거 항목도 남지 않아요. 제거는 엔진의 uninstall(창이 떠 있으면 멈춤, 대신 닫지 않음).
; package.mjs가 넘기는 값: PkgDir AppVersion VersionInfo OutputDir OutputBase IconFile SourceInfo
; 언어(2026-11-05): english·korean — Windows 표시 언어로 골라요. 우리 문구는 모두 [CustomMessages], 엔진에는 --lang으로 같은 언어를 넘겨요

#ifndef PkgDir
  #error PkgDir is required (run build/scripts/package.mjs --exe)
#endif

; 시험 빌드(/DTest): 제거 항목 ID·이름을 따로 쓰고 압축하지 않아요. 설치 위치는 /MK42HOME=, 엔진 인자는 /MK42ARGS=로 바꿔요
#ifdef Test
  #define AppIdValue "{{6E0D3A52-4B7C-4F0E-9A42-4D4B3432FFFF}"
  #define AppNameValue "Mk42 시험"
#else
  #define AppIdValue "{{6E0D3A52-4B7C-4F0E-9A42-4D4B34320042}"
  #define AppNameValue "Mk42"
#endif

[Setup]
AppId={#AppIdValue}
AppName={#AppNameValue}
AppVersion={#AppVersion}
AppVerName={#AppNameValue} {#AppVersion}
AppPublisher=SoliEstre
AppComments={#SourceInfo}
VersionInfoVersion={#VersionInfo}
VersionInfoProductName=Mk42
VersionInfoDescription=Mk42 Setup
VersionInfoCompany=SoliEstre
; 설치 위치는 Mark42 home으로 정해져 있어요(데몬·창·통합 창이 모두 이 자리를 써요)
DefaultDirName={param:MK42HOME|{localappdata}\Mark42}
DisableDirPage=yes
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DirExistsWarning=no
; 관리자 권한 없이 사용자 계정에만 — 관리자 권한으로 띄운 데몬은 일반 창이 못 써서 엔진이 거절해요
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallFilesDir={app}\uninstall
UninstallDisplayName={#AppNameValue}
UninstallDisplayIcon={app}\hub\mk42-hub.exe
SetupIconFile={#IconFile}
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
#ifdef Test
Compression=none
#else
; 공식 VS Code 설치기처럼 lzma 솔리드 — 앱 1.1GB가 100MB대로 줄어요(zip은 420MB)
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
#endif
; 창을 갑자기 닫지 않아요 — 엔진이 데몬만 바꾸고 Mk42 창은 그대로 다시 붙어요
CloseApplications=no
RestartApplications=no
WizardStyle=modern
; 언어는 묻지 않고 Windows 표시 언어로 골라요(한국어면 korean, 그 밖은 english — 못 맞추면 [Languages]의 첫 항목).
; 다시 설치할 때도 지난 설치 언어가 아니라 지금 표시 언어를 따라요
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=no
SetupLogging=yes

[Languages]
; english가 첫 항목이어야 해요 — 표시 언어가 둘 다 아니면 첫 항목을 써요
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[CustomMessages]
; 우리 문구(마법사 기본 문구는 위 .isl). %1… 은 FmtMessage 자리, %n은 줄 바꿈
; 설치 엔진(mk42-setup.mjs)에 넘기는 언어 — 엔진의 MK42-ERROR 문구가 마법사와 같은 언어로 나와요
english.EngineLang=en
korean.EngineLang=ko
english.AutostartTask=Start the Mk42 daemon at logon (creates the logon task on the first install)
korean.AutostartTask=로그온할 때 Mk42 데몬 자동 실행 (처음 설치할 때 로그온 작업을 만들어요)
english.OpenHub=Open the Mk42 hub window
korean.OpenHub=Mk42 통합 창 열기
english.Installing=Installing…
korean.Installing=설치하는 중…
english.FailureFormat=%1 (%2): %3%n%nDetails: %4
korean.FailureFormat=%1 (%2): %3%n%n자세한 기록: %4
english.ProgressCaption=Mk42 Setup
korean.ProgressCaption=Mk42 설치
english.ProgressDescription=The setup engine is checking and installing the components. Mk42 windows stay open.
korean.ProgressDescription=설치 엔진이 구성 요소를 확인하고 설치하고 있어요. Mk42 창은 닫히지 않아요.
english.Extracting=Extracting the setup files…
korean.Extracting=설치 파일을 푸는 중…
english.ExtractingHint=This can take a minute or two.
korean.ExtractingHint=1~2분 걸릴 수 있어요.
english.ExtractFailed=Could not extract the setup files: %1
korean.ExtractFailed=설치 파일을 풀지 못했어요: %1
english.EngineStartFailed=Could not start the setup engine: %1
korean.EngineStartFailed=설치 엔진을 실행하지 못했어요: %1
english.InstallFailed=Setup failed
korean.InstallFailed=설치하지 못했어요
english.UninstallEngineMissing=The setup engine was not found. Only the uninstall entry is removed; the files in %1 are left in place.
korean.UninstallEngineMissing=설치 엔진을 찾지 못했어요. 제거 항목만 지우고 %1의 파일은 그대로 둬요.
english.UninstallPrepFailed=Could not prepare the uninstall (the engine could not be copied to a temporary folder): %1
korean.UninstallPrepFailed=제거 준비에 실패했어요(임시 폴더에 엔진을 복사하지 못함): %1
english.UninstallBusy=Mk42 cannot be uninstalled right now
korean.UninstallBusy=지금은 제거할 수 없어요
english.PurgeQuestion=Also remove the settings and records (registered folders, pinned sessions, logs, …)?%n%nChoose No to remove only the program and keep the settings and records in %1 — a reinstall picks up where you left off.%nMk42 app data (user-data and extensions folders) is kept either way.
korean.PurgeQuestion=설정과 기록(등록한 폴더·고정 세션·로그 등)도 지울까요?%n%n«아니요»를 누르면 프로그램만 지우고 %1의 설정·기록은 남겨요. 다시 설치하면 이어서 써요.%nMk42 앱 데이터(user-data·확장 폴더)는 어느 쪽이든 남아요.
english.UninstallIncomplete=Uninstall did not finish
korean.UninstallIncomplete=제거를 끝내지 못했어요
english.UninstallEntryKept=The uninstall entry was kept. Fix the cause, then uninstall again from Settings > Apps.
korean.UninstallEntryKept=제거 항목은 남겨 뒀어요. 원인을 정리한 뒤 «설정 → 앱»에서 다시 제거해 주세요.

[Tasks]
Name: "autostart"; Description: "{cm:AutostartTask}"

[Files]
; 마법사가 직접 복사하지 않아요(dontcopy) — PrepareToInstall에서 임시 폴더로 풀어 엔진에 넘겨요
Source: "{#PkgDir}\*"; DestDir: "{tmp}\pkg"; Flags: dontcopy noencryption recursesubdirs createallsubdirs ignoreversion

[Run]
Filename: "{app}\hub\mk42-hub.exe"; Description: "{cm:OpenHub}"; Flags: postinstall nowait skipifsilent

[Code]
const
  ErrPrefix = 'MK42-ERROR ';
  LogPrefix = 'MK42-LOG ';

var
  ProgressPage: TOutputMarqueeProgressWizardPage;
  LastError: String;
  LastLine: String;
  EngineLog: String;
  UninstallTemp: String;
  UninstallReady: Boolean;
  UninstallPurge: Boolean;
  UninstallFormReady: Boolean;

{ 엔진 출력 한 줄: 로그에 남기고, 화면에는 마지막 줄을 보여 줘요. MK42-ERROR 줄은 오류 상자 문구로 기억해요 }
procedure OnEngineLine(const S: String; const Error, FirstLine: Boolean);
var
  T: String;
begin
  Log('engine: ' + S);
  if Error then
    exit;
  T := Trim(S);
  if T = '' then
    exit;
  if Pos(LogPrefix, T) = 1 then
  begin
    EngineLog := Copy(T, Length(LogPrefix) + 1, MaxInt);
    exit;
  end;
  if Pos(ErrPrefix, T) = 1 then
    LastError := Copy(T, Length(ErrPrefix) + 1, MaxInt)
  else
    LastLine := T;
  if IsUninstaller then
  begin
    { InitializeUninstall(사용 중 검사) 때는 진행 창이 아직 없어요 }
    if UninstallFormReady then
      UninstallProgressForm.StatusLabel.Caption := T;
  end
  else if ProgressPage <> nil then
  begin
    ProgressPage.SetText(CustomMessage('Installing'), T);
    ProgressPage.Animate;
  end;
end;

{ 엔진이 알려 준 로그 자리(MK42-LOG)를 먼저, 못 받았으면 Fallback }
function EngineFailure(const What: String; const Code: Integer; const Fallback: String): String;
var
  Msg, LogFile: String;
begin
  Msg := LastError;
  if Msg = '' then
    Msg := LastLine;
  LogFile := EngineLog;
  if LogFile = '' then
    LogFile := Fallback;
  Result := FmtMessage(CustomMessage('FailureFormat'), [What, IntToStr(Code), Msg, LogFile]);
end;

{ 엔진 인자 --lang — 마법사가 고른 언어(EngineLang)로 엔진 문구를 맞춰요 }
function EngineLangArg: String;
begin
  Result := ' --lang ' + CustomMessage('EngineLang');
end;

procedure InitializeWizard;
begin
  ProgressPage := CreateOutputMarqueeProgressPage(CustomMessage('ProgressCaption'), CustomMessage('ProgressDescription'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Pkg, Params: String;
begin
  Result := '';
  ProgressPage.SetText(CustomMessage('Extracting'), CustomMessage('ExtractingHint'));
  ProgressPage.Show;
  try
    try
      ExtractTemporaryFiles('{tmp}\pkg\*');
    except
      Result := FmtMessage(CustomMessage('ExtractFailed'), [GetExceptionMessage]);
      exit;
    end;
    Pkg := ExpandConstant('{tmp}\pkg');
    Params := AddQuotes(Pkg + '\setup\mk42-setup.mjs') + ' install --package ' + AddQuotes(Pkg) + ' --home ' + AddQuotes(ExpandConstant('{app}')) + EngineLangArg;
    if not WizardIsTaskSelected('autostart') then
      Params := Params + ' --no-autostart';
    if ExpandConstant('{param:MK42ARGS}') <> '' then
      Params := Params + ' ' + ExpandConstant('{param:MK42ARGS}');
    LastError := '';
    LastLine := '';
    EngineLog := '';
    ProgressPage.SetText(CustomMessage('Installing'), '');
    if not ExecAndLogOutput(Pkg + '\runtime\node.exe', Params, ExpandConstant('{tmp}'), SW_SHOWNORMAL, ewWaitUntilTerminated, Code, @OnEngineLine) then
      Result := FmtMessage(CustomMessage('EngineStartFailed'), [SysErrorMessage(Code)])
    else if Code <> 0 then
      Result := EngineFailure(CustomMessage('InstallFailed'), Code, ExpandConstant('{app}\logs\mk42-setup.log'));
  finally
    ProgressPage.Hide;
  end;
end;

{ ---- 제거 ---- }

{ home\runtime\node-*\node.exe 중 하나(어느 판이든 엔진을 돌릴 수 있어요) }
function FindRuntimeNode(const Home: String): String;
var
  FR: TFindRec;
begin
  Result := '';
  if FindFirst(Home + '\runtime\node-*', FR) then
  try
    repeat
      if ((FR.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and FileExists(Home + '\runtime\' + FR.Name + '\node.exe') then
        Result := Home + '\runtime\' + FR.Name + '\node.exe';
    until not FindNext(FR);
  finally
    FindClose(FR);
  end;
end;

function RunUninstallEngine(const Args: String; var Code: Integer): Boolean;
begin
  LastError := '';
  LastLine := '';
  EngineLog := '';
  Result := ExecAndLogOutput(UninstallTemp + '\node.exe', AddQuotes(UninstallTemp + '\mk42-setup.mjs') + ' ' + Args + EngineLangArg, UninstallTemp, SW_SHOWNORMAL, ewWaitUntilTerminated, Code, @OnEngineLine);
end;

function UninstallLogFile: String;
begin
  Result := AddBackslash(GetTempDir) + 'mk42-uninstall.log';
end;

function InitializeUninstall: Boolean;
var
  Home, Node, Engine: String;
  Code: Integer;
begin
  Result := True;
  UninstallReady := False;
  UninstallPurge := False;
  Home := ExpandConstant('{app}');
  Node := FindRuntimeNode(Home);
  Engine := Home + '\setup\mk42-setup.mjs';
  if (Node = '') or not FileExists(Engine) then
  begin
    SuppressibleMsgBox(FmtMessage(CustomMessage('UninstallEngineMissing'), [Home]), mbInformation, MB_OK, IDOK);
    exit;
  end;
  { 엔진은 home 밖 사본으로 돌려요 — home\runtime의 node는 자기 자신을 지울 수 없어요 }
  UninstallTemp := AddBackslash(GetTempDir) + 'mk42-uninstall-' + GetDateTimeString('yyyymmddhhnnss', #0, #0);
  ForceDirectories(UninstallTemp);
  if not (CopyFile(Node, UninstallTemp + '\node.exe', False) and CopyFile(Engine, UninstallTemp + '\mk42-setup.mjs', False)) then
  begin
    SuppressibleMsgBox(FmtMessage(CustomMessage('UninstallPrepFailed'), [UninstallTemp]), mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;
  { 사용 중 검사 — 창이 떠 있으면 여기서 멈춰요(아무것도 안 바꿔요, 창은 대신 닫지 않아요) }
  if not RunUninstallEngine('uninstall --check --home ' + AddQuotes(Home), Code) or (Code <> 0) then
  begin
    SuppressibleMsgBox(EngineFailure(CustomMessage('UninstallBusy'), Code, UninstallLogFile), mbError, MB_OK, IDOK);
    Result := False;
    exit;
  end;
  UninstallReady := True;
end;

procedure InitializeUninstallProgressForm;
begin
  UninstallFormReady := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Args: String;
  Code: Integer;
begin
  if (CurUninstallStep = usUninstall) and UninstallReady then
  begin
    { «정말 제거할까요?»를 확인한 다음에 물어요. 조용한 제거는 늘 «아니요»(프로그램만) }
    if not UninstallSilent then
      UninstallPurge := MsgBox(FmtMessage(CustomMessage('PurgeQuestion'), [ExpandConstant('{app}')]),
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
    Args := 'uninstall --home ' + AddQuotes(ExpandConstant('{app}'));
    if UninstallPurge then
      Args := Args + ' --purge';
    if not RunUninstallEngine(Args, Code) or (Code <> 0) then
    begin
      { 엔진이 멈췄거나 일부를 못 지웠어요 — 제거 항목·제거 프로그램을 남겨서 다시 제거할 수 있게 여기서 멈춰요 }
      SuppressibleMsgBox(EngineFailure(CustomMessage('UninstallIncomplete'), Code, UninstallLogFile) + #13#10#13#10 +
        CustomMessage('UninstallEntryKept'), mbError, MB_OK, IDOK);
      Abort;
    end;
  end;
end;

{ 확인 단계에서 취소해도, 제거를 멈춰도 엔진 사본(약 90MB)을 치워요 }
procedure DeinitializeUninstall;
begin
  if UninstallTemp <> '' then
    DelTree(UninstallTemp, True, True, True);
end;
