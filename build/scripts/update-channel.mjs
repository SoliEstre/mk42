// package.mjs의 업데이트 채널 인자(계약 C4) — 패키지 루트의 update.json {channel,url,publicKey}와 (내부 채널만) update.secret.
//   --update-channel internal|stable   --update-url <바탕 주소, 기본 https://mk42.estre.so/updates/>   --update-auth-file <user:password 한 줄 파일>
// 공개 키는 build/update-signing.pub.pem(개인 키는 빌드 PC ~/.secrets에만). 자격 증명 내용은 어디에도 출력하지 않아요.
import { createHash, createPublicKey } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_UPDATE_URL = 'https://mk42.estre.so/updates/';
export const UPDATE_CHANNELS = ['internal', 'stable'];

/**
 * @param {{ channel?: string, url?: string, authFile?: string }} opts
 * @param {{ publicKeyFile: string, readFile?: (p: string) => Promise<string> }} deps
 * @returns {Promise<{ config: { channel: string, url: string, publicKey: string }, secret?: string } | undefined>}
 */
export async function resolveUpdateChannel(opts, deps) {
  const readFile = deps.readFile ?? ((p) => fsp.readFile(p, 'utf8'));
  if (!opts.channel) {
    if (opts.authFile || opts.url) throw new Error('--update-url / --update-auth-file need --update-channel');
    return undefined;
  }
  if (!UPDATE_CHANNELS.includes(opts.channel)) throw new Error(`--update-channel must be one of ${UPDATE_CHANNELS.join(', ')}`);
  if (opts.channel === 'stable' && opts.authFile) {
    throw new Error('--update-auth-file is for the internal channel only — a stable (public) package must not carry a credential');
  }
  let url;
  try {
    url = new URL(opts.url ?? DEFAULT_UPDATE_URL);
  } catch {
    throw new Error('--update-url is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('--update-url must be https');
  if (url.username || url.password || url.search || url.hash) throw new Error('--update-url must not carry credentials, a query or a fragment');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const publicKey = await readFile(deps.publicKeyFile);
  let type;
  try {
    type = createPublicKey({ key: publicKey, format: 'pem' }).asymmetricKeyType;
  } catch {
    throw new Error(`${deps.publicKeyFile} is not a PEM public key`);
  }
  if (type !== 'ed25519') throw new Error(`${deps.publicKeyFile} is not an Ed25519 key`);
  const config = { channel: opts.channel, url: url.href, publicKey };
  if (!opts.authFile) return { config };
  let secret = await readFile(resolve(opts.authFile));
  if (secret.charCodeAt(0) === 0xfeff) secret = secret.slice(1);
  secret = secret.trim();
  // 내용은 오류에도 넣지 않아요
  if (secret.length > 512 || !/^[^:\r\n]+:[^\r\n]+$/.test(secret)) throw new Error(`${opts.authFile} must hold one line in user:password form`);
  return { config, secret };
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 패키지 폴더에 update.json(·update.secret)을 쓰고 manifest.update 값을 돌려줘요(크기·sha256 — 엔진이 맞춰 봐요).
 * @param {string} dir 패키지(.partial) 폴더
 * @param {{ config: { channel: string, url: string, publicKey: string }, secret?: string }} u
 */
export async function writePackageUpdate(dir, u) {
  const configText = `${JSON.stringify(u.config, null, 2)}\n`;
  await fsp.writeFile(join(dir, 'update.json'), configText);
  const update = {
    channel: u.config.channel,
    config: { file: 'update.json', size: Buffer.byteLength(configText), sha256: sha256(configText) },
  };
  if (u.secret !== undefined) {
    await fsp.writeFile(join(dir, 'update.secret'), u.secret);
    update.secret = { file: 'update.secret', size: Buffer.byteLength(u.secret), sha256: sha256(u.secret) };
  }
  return update;
}
