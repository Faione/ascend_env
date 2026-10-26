// 终端桥接：通过 SSH PTY 执行 `docker compose exec`，把 WebSocket 与容器 shell 双向连接。
// 仅允许连接本任务启动的容器服务，不提供任意目标主机 shell。

import { shellQuote, type PtySession, type SshClient } from '../ssh/index.js';

export interface TerminalOptions {
  projectName: string;
  composeFile: string;
  serviceName: string;
  cols: number;
  rows: number;
}

/** 打开任务容器的交互式 bash 终端。 */
export function openComposeTerminal(ssh: SshClient, opts: TerminalOptions): Promise<PtySession> {
  const command =
    `docker compose -p ${shellQuote(opts.projectName)} -f ${shellQuote(opts.composeFile)} ` +
    `exec ${shellQuote(opts.serviceName)} bash`;
  return ssh.openPty({ command, cols: opts.cols, rows: opts.rows });
}