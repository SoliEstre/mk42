// 백그라운드 작업 모니터 — Claude·Codex 수집기를 합쳐 tasks.list에 답하고, 싼 stat 서명을 폴링해 바뀌면 알려요.
// 에이전트 홈은 읽기만 해요. 폴더·DB가 없거나 줄이 깨져 있어도 빈 목록으로 버텨요.
import type { TasksListParams, SessionTasks } from '@mark42/protocol';
import { createClaudeTaskCollector, type TaskCollector } from './claudeTasks.ts';
import { createCodexTaskCollector } from './codexTasks.ts';
import { compareSessions, DEFAULT_SINCE_MS, MAX_SINCE_MS } from './common.ts';
import { pollSignature, type Poller } from '../indexers/watch.ts';

export const TASKS_DEFAULT_LIMIT = 30;
export const TASKS_MAX_LIMIT = 100;

export interface TaskMonitorOptions {
  claudeDir?: string;
  codexHome?: string;
  /** 서명 폴링 간격(기본 4초) */
  pollMs?: number;
  now?: () => number;
  log?: (m: string) => void;
  /** 수집기 바꿔 끼우기(테스트용) */
  collectors?: { claude?: TaskCollector; codex?: TaskCollector };
}

export interface TaskMonitor {
  list(p: TasksListParams): Promise<SessionTasks[]>;
  /** 서명이 바뀌면 onChange(첫 계산은 기준값) */
  start(onChange: () => void): void;
  stop(): void;
}

export function createTaskMonitor(opts: TaskMonitorOptions = {}): TaskMonitor {
  const collectors: { agent: 'claude' | 'codex'; c: TaskCollector }[] = [
    { agent: 'claude', c: opts.collectors?.claude ?? createClaudeTaskCollector({ claudeDir: opts.claudeDir, now: opts.now }) },
    { agent: 'codex', c: opts.collectors?.codex ?? createCodexTaskCollector({ codexHome: opts.codexHome, now: opts.now }) },
  ];
  let poller: Poller | undefined;
  let stopped = false;

  async function list(p: TasksListParams = {}): Promise<SessionTasks[]> {
    const sinceMs = Math.min(MAX_SINCE_MS, Math.max(0, p.sinceMs ?? DEFAULT_SINCE_MS));
    const limit = Math.min(TASKS_MAX_LIMIT, Math.max(1, Math.floor(p.limit ?? TASKS_DEFAULT_LIMIT)));
    const lists = await Promise.all(
      collectors
        .filter((x) => !p.agent || x.agent === p.agent)
        .map((x) =>
          x.c.collect({ sessionId: p.sessionId, sinceMs }).catch((e) => {
            opts.log?.(`${x.agent} tasks collect failed: ${e instanceof Error ? e.message : String(e)}`);
            return [] as SessionTasks[];
          }),
        ),
    );
    return lists.flat().sort(compareSessions).slice(0, limit);
  }

  async function fingerprint(): Promise<string> {
    const parts = await Promise.all(collectors.map((x) => x.c.fingerprint().catch(() => `${x.agent}:error`)));
    return parts.join('|');
  }

  return {
    list,
    start(onChange) {
      if (poller || stopped) return;
      // 처음 한 번 모아 두면(캐시·끝나지 않은 파일 목록) 서명이 진행 중인 파일의 덧붙임까지 알아채요
      void list({}).finally(() => {
        if (stopped || poller) return;
        poller = pollSignature(fingerprint, opts.pollMs ?? 4000, onChange, opts.log);
      });
    },
    stop() {
      stopped = true;
      poller?.stop();
      poller = undefined;
    },
  };
}
