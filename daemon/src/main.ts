// mk42d 진입점 — 인자 → 단일 인스턴스(파이프 선점) → 레지스트리·인덱서·실행기 → 파이프·hub 서버 → (부팅 재개).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthSecretError, loadOrCreateAuthSecret } from '@mark42/protocol/auth';
import { claudeConfigDir, codexHome } from '@mark42/protocol/paths';
import { Autostart, LEGACY_TASK_NAME, TASK_NAME } from './autostart.ts';
import {
  ArgError,
  autostartEntryArgs,
  bootRespawnPlan,
  legacyTaskMigration,
  parseArgs,
  pipeNameForWindows,
  USAGE,
  type DaemonArgs,
} from './config.ts';
import { hubHostExe, hubHostRunning, openHubWindow } from './edge.ts';
import { errCode } from './fsutil.ts';
import { readHubPort, saveHubPort, startHubServer, type HubServer } from './hubServer.ts';
import { createClaudeIndexer } from './indexers/claude.ts';
import { createCodexIndexer } from './indexers/codex.ts';
import type { SessionIndexer } from './indexers/types.ts';
import { AppLauncher, sanitizeLaunchEnv } from './launcher.ts';
import { createFileLogger, errMsg, type Logger } from './log.ts';
import { Registry } from './registry.ts';
import { createRemoteSessionProbe, isRemoteSessionFromEnv, runBootResume, type BootResumeHandle } from './resume.ts';
import { askRunningDaemon, verifyRunningDaemon } from './secondInstance.ts';
import { DaemonCore, PipeServer } from './server.ts';
import { DAEMON_VERSION } from './version.ts';
import { AgentExtensionUpdater, AGENT_EXTENSION_SOURCES } from './agentUpdates.ts';
import { editionDefaults, type LaunchOverlay, type OverlayContext, type OverlayServices } from './edition.ts';
import { overlay } from './overlay/index.ts';
import { LaunchProgress, stepEndOfUpdate, type LaunchStepEnd } from './launchProgress.ts';
import { Mk42Updater } from './updater.ts';
import type { Mk42UpdateStatus } from '@mark42/protocol';
import { createTaskMonitor } from './tasks/taskMonitor.ts';

/** --boot: 콘솔 창 없이 자기 자신을 다시 띄워요. 띄웠으면 true(부모는 끝내요). */
function respawnDetachedForBoot(args: DaemonArgs): boolean {
  const plan = bootRespawnPlan(args, process.execPath, process.execArgv, process.argv, process.env, process.platform);
  if (!plan) return false;
  const child = spawn(plan.command, plan.args, { detached: true, windowsHide: true, stdio: 'ignore', env: plan.env });
  child.unref();
  return true;
}

/**
 * D41: 옛 로그온 작업(Mark42\m42d)이 켜져 있고 이 데몬(같은 home·pipe)의 것이면 새 이름·새 번들로 옮겨요.
 * 파이프 주인뿐 아니라 «이미 실행 중»으로 물러나는 두 번째 실행도 불러요 — 옛 작업이 띄운 옛 번들이 파이프를 쥐고 있어도 옮겨지게.
 */
async function migrateLegacyAutostart(
  autostart: Autostart,
  args: DaemonArgs,
  report: (level: 'info' | 'warn', msg: string) => void,
): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const r = await autostart.migrateLegacy((legacy) => legacyTaskMigration(legacy, args, { exists: existsSync }));
    if (r.outcome === 'migrated') {
      report('info', `autostart: migrated logon task ${LEGACY_TASK_NAME} -> ${TASK_NAME} (entry ${r.action.args[0] ?? '?'})`);
    } else if (r.outcome === 'skipped') {
      report('info', `autostart: left ${LEGACY_TASK_NAME} as is — it does not run this daemon's home/pipe`);
    }
  } catch (e) {
    report('warn', `autostart: legacy task migration failed: ${errMsg(e)}`);
  }
}

async function main(): Promise<number> {
  let args: DaemonArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (respawnDetachedForBoot(args)) return 0;

  // 파이프 서버 인증 비밀 — 파이프를 열기 전에 준비해요(창이 연결하자마자 hello.challenge에 답할 수 있게).
  // 두 번째 실행도 같은 비밀로 파이프 주인이 진짜 mk42d인지 확인해요(파이프 선점 방지).
  const authNotes: { level: 'info' | 'warn'; msg: string }[] = [];
  // Windows: home을 본인 전용으로 조인 뒤에 비밀을 써요. 조이거나 확인하지 못하면 시작하지 않아요(넓은 ACL의 비밀은 믿을 수 없어요).
  let auth: Awaited<ReturnType<typeof loadOrCreateAuthSecret>>;
  try {
    auth = await loadOrCreateAuthSecret(args.home, { log: (level, msg) => authNotes.push({ level, msg }) });
  } catch (e) {
    if (!(e instanceof AuthSecretError)) throw e;
    for (const n of authNotes) process.stderr.write(`${n.level}: ${n.msg}\n`);
    process.stderr.write(`mk42d: refusing to start — daemon auth secret cannot be kept private (${e.code}): ${e.message}\n`);
    return 1;
  }

  const autostart = new Autostart({
    action: { command: process.execPath, args: autostartEntryArgs(fileURLToPath(import.meta.url), args) },
    tmpDir: join(args.home, 'tmp'),
  });

  // 단일 인스턴스: 파이프를 먼저 차지한 쪽이 주인
  const pipeServer = new PipeServer();
  try {
    await pipeServer.listen(args.pipe);
  } catch (e) {
    // 파이프를 다른 프로세스가 잡고 있으면 보통 EADDRINUSE지만, 작업 스케줄러로 뜬 데몬이 잡고 있으면 EACCES가 와요
    // (2026-10-24 실측). 어느 쪽이든 아래에서 $/auth로 진짜 mk42d인지 확인한 뒤에만 말을 걸어요.
    if (errCode(e) === 'EADDRINUSE' || errCode(e) === 'EACCES') {
      const ask = { secret: auth.secret };
      let verified = false;
      if (args.openHub) {
        try {
          await askRunningDaemon(args.pipe, args.home, '$/openHub', {}, ask);
          verified = true;
          process.stdout.write('mk42d already running; asked it to open the hub window\n');
        } catch (e2) {
          process.stderr.write(`mk42d already running; open hub failed: ${errMsg(e2)}\n`);
          return 1;
        }
      } else if (args.boot) {
        // 다른 Windows 세션(RemoteApp 등)의 로그온 작업 — 떠 있는 데몬에 넘겨요(D28 b)
        try {
          const remote = await createRemoteSessionProbe()().catch(() => isRemoteSessionFromEnv());
          await askRunningDaemon(args.pipe, args.home, '$/bootResume', { remote }, ask);
          verified = true;
          process.stdout.write('mk42d already running; forwarded boot resume\n');
        } catch (e2) {
          process.stderr.write(`mk42d already running; boot resume forward failed: ${errMsg(e2)}\n`);
        }
      } else {
        try {
          await verifyRunningDaemon(args.pipe, args.home, ask);
          verified = true;
          process.stdout.write('mk42d already running\n');
        } catch (e2) {
          process.stderr.write(`pipe ${args.pipe} is in use but its owner is not a verified mk42d: ${errMsg(e2)}\n`);
          return 1;
        }
      }
      // 떠 있는 데몬이 옛 로그온 작업이 띄운 옛 번들이어도 작업은 지금 옮겨요(다음 로그온부터 새 번들)
      if (verified) {
        await migrateLegacyAutostart(autostart, args, (level, msg) =>
          (level === 'warn' ? process.stderr : process.stdout).write(`${msg}\n`),
        );
      }
      return 0;
    }
    throw e;
  }

  const log: Logger = createFileLogger({
    file: join(args.home, 'logs', 'mk42d.log'),
    level: args.logLevel,
    echo: process.stdout.isTTY === true,
  });
  log.info(`mk42d ${DAEMON_VERSION}${overlay.edition ? ` (${overlay.edition})` : ''} starting pid=${process.pid} home=${args.home} pipe=${args.pipe}`);
  for (const n of authNotes) log[n.level](n.msg);

  const registry = await Registry.load(args.home, { log: log.child('registry') });
  const indexerLog = (scope: string) => {
    const l = log.child(scope);
    return (msg: string) => l.info(msg);
  };
  const indexers: SessionIndexer[] = [];
  try {
    indexers.push(createClaudeIndexer({ claudeDir: claudeConfigDir(), log: indexerLog('claude') }));
  } catch (e) {
    log.error(`claude indexer init failed: ${errMsg(e)}`);
  }
  try {
    // 기본은 sqlite 읽기 전용 — app-server는 ~/.codex DB를 읽기-쓰기로 열어요(registry.ts codexIndexer 참고)
    const mode = registry.settings.codexIndexer ?? 'sqlite';
    indexers.push(createCodexIndexer({ codexHome: codexHome(), mode, log: indexerLog('codex') }));
  } catch (e) {
    log.error(`codex indexer init failed: ${errMsg(e)}`);
  }

  // 아래 에이전트 확장 업데이트가 만들어진 뒤에 이어 붙여요(빠진 Claude Code는 검증해서 깔아요)
  let onVerifiedExtensionMissing: (id: string) => Promise<LaunchStepEnd> | undefined = () => undefined;
  // C3: 첫 실행 준비(확장 설치·창 열기) 진행 — 700ms 넘게 걸리면 작은 진행 창(mk42-hub.exe --progress)
  const launchProgress = new LaunchProgress({
    home: args.home,
    hubExe: () => registry.settings.hubHostPath ?? hubHostExe(args.home),
    log: log.child('progress'),
  });
  void launchProgress.clearStale();
  // 판 덧층(edition.ts): 실행기 훅은 덧층 서비스가 뜬 뒤 onUserDataLaunch를 채워요(같은 객체)
  const defaults = editionDefaults(overlay);
  const launchOverlay: LaunchOverlay = { ...(overlay.launch ?? {}) };
  const launcher = new AppLauncher({
    home: args.home,
    getSettings: () => registry.settings,
    overlay: launchOverlay,
    defaultAppProduct: defaults.defaultAppProduct,
    log: log.child('launcher'),
    onVerifiedExtensionMissing: (id) => onVerifiedExtensionMissing(id),
    progress: launchProgress,
  });
  void migrateLegacyAutostart(autostart, args, (level, msg) => log[level](msg));
  const overlayCtx: OverlayContext = {
    home: args.home,
    getSettings: () => registry.settings,
    installs: () => launcher.installs(),
    hubExe: () => registry.settings.hubHostPath ?? hubHostExe(args.home),
    log: log.child('overlay'),
  };
  let overlayServices: OverlayServices | undefined;
  try {
    overlayServices = await overlay.start?.(overlayCtx);
  } catch (e) {
    log.warn(`overlay services failed to start: ${errMsg(e)}`);
  }
  if (overlayServices?.launch?.onUserDataLaunch) launchOverlay.onUserDataLaunch = overlayServices.launch.onUserDataLaunch;
  const supply = overlay.agentSupply?.(overlayCtx);

  let hub: HubServer | undefined;
  // 파이프는 통합 창 서버보다 먼저 받아요 — 로그온 직후 고정한 통합 창 단추의 `$/openHub`는 서버가 뜨거나 실패할 때까지 기다려요
  let hubSettled!: () => void;
  const hubReady = new Promise<void>((resolve) => (hubSettled = resolve));
  const openHub = async (): Promise<{ url: string }> => {
    await hubReady;
    if (!hub) throw new Error(args.hubServer ? 'hub server failed to start' : 'hub server disabled (--no-hub-server)');
    const s = registry.settings;
    const w = await openHubWindow({ url: hub.nextWindowUrl(), home: args.home, hubWindow: s.hubWindow, hubHostPath: s.hubHostPath });
    log.info(`hub window opened on port ${hub.port} (${w.kind === 'host' ? 'mk42-hub' : 'edge'})`);
    return { url: `http://127.0.0.1:${hub.port}/` };
  };

  // Mk42 에이전트 확장 업데이트 — 갤러리 판을 검증한 뒤 깔아요(공급원·검증 기준은 판 덧층이 바꿀 수 있어요)
  let notifyUpdated: (ids: string[]) => void = () => undefined;
  const agentUpdates = new AgentExtensionUpdater({
    home: args.home,
    target: () => launcher.mark42ExtensionTarget(),
    installer: launcher,
    sources: supply?.sources?.(AGENT_EXTENSION_SOURCES) ?? AGENT_EXTENSION_SOURCES,
    reference: supply?.reference,
    env: sanitizeLaunchEnv(process.env),
    onUpdated: (ids) => notifyUpdated(ids),
    log: log.child('agent-updates'),
  });

  // Mk42 자체 업데이트(계약 C4) — 설치 기록에 채널이 있을 때만 켜져요. 바뀐 상태는 창·통합 창에 update.changed
  let notifyMk42Update: (s: Mk42UpdateStatus) => void = () => undefined;
  const mk42Update = new Mk42Updater({
    home: args.home,
    autoInstall: () => registry.settings.update?.autoInstall === true,
    onChange: (s) => notifyMk42Update(s),
    log: log.child('self-update'),
  });

  // 백그라운드 작업(워크플로우·서브에이전트) 모니터 — ~/.claude·~/.codex 읽기 전용
  const taskLog = log.child('tasks');
  const tasks = createTaskMonitor({ claudeDir: claudeConfigDir(), codexHome: codexHome(), log: (m) => taskLog.info(m) });

  let boot: BootResumeHandle | undefined;
  let shutdown: (signal: string, exitCode?: number) => Promise<void> = async () => undefined;
  const core = new DaemonCore({
    home: args.home,
    registry,
    indexers,
    launcher,
    autostart,
    log: log.child('core'),
    onOpenHub: openHub,
    onBootResume: ({ remote }) => {
      // firstRemoteApp로 기다리는 중일 때만, 원격 세션 로그온이면 지금 실행해요
      if (!boot?.waiting || !remote) return { accepted: false };
      return { accepted: boot.trigger('forwarded from another session') };
    },
    // 답이 나간 뒤에 꺼요(파이프를 바로 닫으면 부른 쪽이 답을 못 받아요)
    onShutdown: () => void setTimeout(() => void shutdown('$/shutdown'), 200),
    pipeName: pipeNameForWindows(args.pipe),
    auth: { secret: auth.secret, pipeName: args.pipe },
    agentUpdates,
    tasks,
    mk42Update,
    onWindowHello: (w) => launchProgress.windowHello(w.workspaceFile),
    defaults,
    resolveAppProduct: overlay.resolveAppProduct,
    appProductOfName: overlay.appProductOfName,
  });
  pipeServer.attachCore(core);
  await core.start();
  tasks.start(() => core.notifyTasksChanged());
  notifyUpdated = (ids) => core.notifyExtensionsUpdated(ids);
  // 끝(깔림·실패·사용자 확인 대기)을 준비 진행의 claude-extension 단계로 돌려줘요
  onVerifiedExtensionMissing = (id) =>
    agentUpdates.check({ ids: [id] }).then(
      (us) => stepEndOfUpdate(us.find((u) => u.id === id)?.status),
      (e) => {
        log.warn(`agent extension ${id}: ${errMsg(e)}`);
        return 'failed' as const;
      },
    );
  agentUpdates.start();
  notifyMk42Update = (s) => core.notifyUpdateChanged(s);
  void mk42Update.start().catch((e) => log.warn(`self-update start failed: ${errMsg(e)}`));

  if (args.hubServer) {
    try {
      // 같은 포트로: 이전 실행의 통합 창이 다시 붙으려다 새 토큰에 거절돼 스스로 닫혀요(통합 창은 하나만 — hubServer)
      hub = await startHubServer({
        core,
        uiDir: registry.settings.hubUiDir,
        preferredPort: await readHubPort(args.home),
        log: log.child('hub'),
      });
      await saveHubPort(args.home, hub.port, args.pipe).catch((e) => log.warn(`hub port not saved: ${errMsg(e)}`));
    } catch (e) {
      log.error(`hub server failed to start: ${errMsg(e)}`);
    }
  }
  hubSettled();
  if (args.openHub) await openHub().catch((e) => log.error(`open hub failed: ${errMsg(e)}`));
  else if (hub && (await hubHostRunning(args.home))) {
    // 데몬만 다시 떴고 Mk42 통합 창은 떠 있어요: 새 토큰 주소를 넘겨 그 창을 이어요(안 그러면 지난 토큰으로 거절돼 닫혀요)
    log.info('hub window is open from before: handing it the new address');
    await openHub().catch((e) => log.error(`open hub failed: ${errMsg(e)}`));
  }

  if (args.boot) {
    boot = runBootResume({
      mode: registry.settings.resumeMode ?? defaults.resumeMode,
      run: () => core.resumeNow(),
      isRemoteSession: createRemoteSessionProbe(),
      log: log.child('boot'),
    });
    boot.done.then(
      (r) => r && log.info(`boot resume done: started=${r.started.length} skipped=${r.skipped.length}`),
      (e) => log.error(`boot resume failed: ${errMsg(e)}`),
    );
  }

  let stopping = false;
  shutdown = async (signal: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    log.info(`shutting down (${signal})`);
    boot?.cancel();
    agentUpdates.close();
    mk42Update.close();
    tasks.stop();
    overlayServices?.close?.();
    await Promise.allSettled([hub?.close(), pipeServer.close()]);
    await core.close().catch((e) => log.error(`core close failed: ${errMsg(e)}`));
    log.info('bye');
    process.exit(exitCode);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void shutdown(sig));
  process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${errMsg(e)}`));
  process.on('uncaughtException', (e) => {
    log.error(`uncaught exception: ${e.stack ?? errMsg(e)}`);
    void shutdown('uncaughtException', 1);
  });
  log.info('mk42d ready');
  return -1; // 상주
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    process.stderr.write(`mk42d failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
