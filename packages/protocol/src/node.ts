// Node 전용: net.Socket(named pipe)을 LineChannel로 감싸요.
import type { Socket } from 'node:net';
import { LineDecoder, type LineChannel } from './rpc.ts';

export function socketChannel(socket: Socket): LineChannel {
  const decoder = new LineDecoder();
  const lineCbs: ((line: string) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of lines) for (const cb of lineCbs) cb(line);
  });
  socket.on('close', fireClose);
  socket.on('error', () => socket.destroy());
  return {
    send(line) {
      if (closed) throw new Error('closed');
      socket.write(line + '\n');
    },
    onLine(cb) {
      lineCbs.push(cb);
    },
    onClose(cb) {
      if (closed) cb();
      else closeCbs.push(cb);
    },
    close() {
      socket.end();
      socket.destroy();
    },
  };
}
