// 두 번째 실행(--open-hub·--boot·그냥 실행)이 파이프를 이미 차지한 쪽에 말을 걸 때 — 먼저 그쪽이 진짜 mk42d인지 확인해요.
// 파이프 이름은 예측할 수 있어서 다른 프로세스가 먼저 차지했을 수 있어요(squatting). `$/auth` proof가 맞기 전에는 아무것도 보내지 않아요.
import { connect } from 'node:net';
import { RpcPeer } from '@mark42/protocol';
import { newChallenge, readAuthSecret, verifyProof } from '@mark42/protocol/auth';
import { socketChannel } from '@mark42/protocol/node';

export class UnverifiedDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnverifiedDaemonError';
  }
}

async function openPeer(pipe: string): Promise<RpcPeer> {
  const socket = connect(pipe);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const peer = new RpcPeer(socketChannel(socket));
  // 확인 전후 모두 상대가 보내는 요청·알림은 처리하지 않아요
  peer.setHandlers({});
  return peer;
}

/** 이미 연 피어가 같은 home의 비밀을 아는 데몬인지. 아니면 UnverifiedDaemonError */
export async function verifyPeer(peer: RpcPeer, pipe: string, secret: Uint8Array, timeoutMs = 10_000): Promise<void> {
  const challenge = newChallenge();
  let proof: unknown;
  try {
    const res = (await peer.request('$/auth', { challenge }, timeoutMs)) as { proof?: unknown } | undefined;
    proof = res?.proof;
  } catch (e) {
    throw new UnverifiedDaemonError(
      `process on ${pipe} did not answer $/auth (${e instanceof Error ? e.message : String(e)}) — not a verified mk42d (old version or pipe squatting)`,
    );
  }
  if (!verifyProof(secret, pipe, challenge, proof)) {
    throw new UnverifiedDaemonError(`process on ${pipe} failed authentication — the pipe may be held by another process (squatting)`);
  }
}

export interface AskOptions {
  timeoutMs?: number;
  /** 테스트용: 비밀을 직접 줘요(기본: <home>/auth.secret 읽기) */
  secret?: Uint8Array;
}

/** 파이프 주인을 확인만 해요(그냥 두 번째 실행). */
export async function verifyRunningDaemon(pipe: string, home: string, opts: AskOptions = {}): Promise<void> {
  const secret = opts.secret ?? (await readAuthSecret(home));
  const peer = await openPeer(pipe);
  try {
    await verifyPeer(peer, pipe, secret, opts.timeoutMs);
  } finally {
    peer.close();
  }
}

/** 확인한 뒤에만 데몬 전용 메서드를 부탁해요. */
export async function askRunningDaemon(
  pipe: string,
  home: string,
  method: '$/openHub' | '$/bootResume' | '$/shutdown',
  params: object,
  opts: AskOptions = {},
): Promise<unknown> {
  const secret = opts.secret ?? (await readAuthSecret(home));
  const peer = await openPeer(pipe);
  try {
    await verifyPeer(peer, pipe, secret, opts.timeoutMs);
    return await peer.request(method, params, opts.timeoutMs ?? 15_000);
  } finally {
    peer.close();
  }
}
