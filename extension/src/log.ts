import * as vscode from 'vscode';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  debug(msg: string): void;
  show(): void;
}

export function createLogger(context: vscode.ExtensionContext): Logger {
  const ch = vscode.window.createOutputChannel('Mark42', { log: true });
  context.subscriptions.push(ch);
  return {
    info: (m) => ch.info(m),
    warn: (m) => ch.warn(m),
    error: (m, e) => ch.error(e === undefined ? m : `${m}: ${e instanceof Error ? e.message : String(e)}`),
    debug: (m) => ch.debug(m),
    show: () => ch.show(true),
  };
}
