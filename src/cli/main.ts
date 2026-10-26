#!/usr/bin/env node
// 本地入口：解析命令行参数，装配可观测性、存储、下载与编排服务并启动 HTTP/WS 服务。
// CLI 只负责装配与生命周期，不复制业务规则；所有业务逻辑走 server 层模块。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataPaths } from '../server/config.js';
import { Observability } from '../server/observability/index.js';
import { SnapshotStore } from '../server/storage/snapshots.js';
import { BundleService } from '../server/bundle/index.js';
import { Workflow } from '../server/workflow/index.js';
import { ApiServer } from '../server/api/index.js';

const VERSION = '0.1.0';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6750;

const HELP = `ascend-env —— Ascend CANN 环境部署工具

用法:
  ascend-env [命令] [选项]

命令:
  start      启动本地服务并打开静态控制界面（默认命令）
  help       显示本帮助
  version    显示版本号

选项（start）:
  --host <地址>   监听的地址，默认 ${DEFAULT_HOST}（仅回环地址安全）
  --port <端口>   监听端口，默认 ${DEFAULT_PORT}

示例:
  ascend-env start
  ascend-env start --port 6750

运行前提:
  - 本机安装 Node.js 20+，并已执行 npm install。
  - 启动前先运行 npm run build 生成前端静态资源与编译后的服务代码。
  - 目标 Linux 服务器需安装 Docker、可用的 Docker Compose，并允许 SSH/SFTP 访问。

说明:
  服务只监听回环地址，不对外暴露；浏览器访问 http://127.0.0.1:<端口>。
  SSH 密码/私钥仅在服务端进程内存中短暂存在，不会写入任务快照或日志。

退出码:
  0  成功启动并优雅退出
  1  参数错误或启动失败
`;

interface ParsedArgs {
  command: 'start' | 'help' | 'version';
  host: string;
  port: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: ParsedArgs['command'] = 'start';
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const rest = argv.slice();

  const first = rest[0];
  if (first === 'help' || first === '--help' || first === '-h') command = 'help';
  else if (first === 'version' || first === '--version' || first === '-v') command = 'version';
  else if (first === 'start') rest.shift();
  else if (first !== undefined && !first.startsWith('-')) command = 'start';

  if (command === 'start') {
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--host' || arg === '-H') {
        host = rest[++i];
        if (!host) throw new Error(`缺少 --host 的值`);
      } else if (arg === '--port' || arg === '-p') {
        const raw = rest[++i];
        const n = Number(raw);
        if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`非法端口: ${raw}`);
        port = n;
      } else {
        throw new Error(`未知参数: ${arg}`);
      }
    }
  }

  return { command, host, port };
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`运行 'ascend-env help' 查看用法。\n`);
    return 1;
  }

  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`ascend-env ${VERSION}\n`);
    return 0;
  }

  const paths = getDataPaths();
  const observability = new Observability(paths);
  const snapshots = new SnapshotStore(paths.jobsDir);
  const bundle = new BundleService();
  const workflow = new Workflow({ snapshots, observability, dataPaths: paths, bundle });

  const webRoot = resolve(paths.appRoot, 'dist', 'web');
  if (!existsSync(resolve(webRoot, 'index.html'))) {
    observability.service.warn('cli.web.missing', '未找到编译后的前端资源，请先运行 npm run build', { webRoot });
  }

  const api = new ApiServer({ workflow, observability, dataPaths: paths, webRoot });
  const { port } = await api.start(args.port);
  observability.service.info('cli.started', `服务已启动`, { host: args.host, port });

  const shutdown = async (signal: string) => {
    observability.service.info('cli.stopping', `收到 ${signal}，正在关闭`);
    try {
      await api.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 控制台给出可直接访问的地址（回环地址，仅本机可访问）。
  process.stdout.write(`\nAscend 环境部署工具已启动: http://${args.host}:${port}\n`);
  process.stdout.write(`按 Ctrl+C 退出。\n`);

  return 0;
}

main().then(
  (code) => {
    // 退出码非 0 表示应在完成 fn 启动输出后退出；0 表示服务已监听并持续运行，等待信号。
    if (code !== 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);