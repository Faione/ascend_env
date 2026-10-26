// Compose YAML 程序化渲染：镜像标签、容器名、设备与只读卷路径均从配置注入，避免手写缩进或注入错误。
// 生成的 YAML 与 bundle 内的 deploy/compose.yaml 一致，构建后由本模块校验与启动。

import { stringify } from 'yaml';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import type { RuntimeConfig } from '../../shared/types.js';
import { shellQuote, type SshClient } from '../ssh/index.js';
import type { Logger } from '../observability/logger.js';

export interface ComposeInput {
  serviceName: string;
  containerName: string;
  imageTag: string;
  runtime: RuntimeConfig;
}

/** 生成 Compose YAML。设备节点与驱动的只读绑定均来自 RuntimeConfig。 */
export function renderComposeYaml(input: ComposeInput): string {
  const { runtime, serviceName, containerName, imageTag } = input;
  const bind = (source: string, target: string) => ({ type: 'bind', source, target, read_only: true });

  const volumes = [
    bind(runtime.dcmiPath, runtime.dcmiPath),
    bind(runtime.driverLibPath, runtime.driverLibPath),
    bind(runtime.versionInfoPath, runtime.versionInfoPath),
    bind(runtime.installInfoPath, runtime.installInfoPath),
    bind(runtime.projectRoot, '/workspace/ascend-dev'),
  ];

  const doc = {
    services: {
      [serviceName]: {
        image: imageTag,
        pull_policy: 'never',
        container_name: containerName,
        working_dir: runtime.workingDir,
        command: ['sleep', 'infinity'],
        devices: runtime.devices.map((d) => `${d}:${d}`),
        volumes,
      },
    },
  };

  return `# 该文件由本工具生成，请勿手工修改。\n${stringify(doc)}`;
}

export interface ComposeCommandOptions {
  cwd: string;
  projectName: string;
  composeFile: string;
}

/** 校验 Compose 文件（docker compose config）。 */
export async function validateCompose(
  ssh: SshClient,
  opts: ComposeCommandOptions,
  logger: Logger,
): Promise<void> {
  logger.info('compose.validate.started', '开始校验 Compose 配置', { projectName: opts.projectName });
  const res = await ssh.exec(`docker compose -p ${shellQuote(opts.projectName)} -f ${shellQuote(opts.composeFile)} config`, {
    cwd: opts.cwd,
  });
  if (res.code !== 0) {
    throw new AppError({ code: ErrorCodes.COMPOSE_VALIDATION_FAILED, message: 'Compose 配置校验失败' });
  }
  logger.info('compose.validate.completed', 'Compose 配置校验通过');
}

/** 启动容器（docker compose up -d）。 */
export async function startCompose(
  ssh: SshClient,
  opts: ComposeCommandOptions,
  logger: Logger,
): Promise<void> {
  logger.info('compose.up.started', '启动容器');
  const res = await ssh.exec(`docker compose -p ${shellQuote(opts.projectName)} -f ${shellQuote(opts.composeFile)} up -d`, {
    cwd: opts.cwd,
  });
  if (res.code !== 0) {
    throw new AppError({ code: ErrorCodes.COMPOSE_UP_FAILED, message: '容器启动失败' });
  }
  logger.info('compose.up.completed', '容器已启动');
}

export interface ContainerStatus {
  name?: string;
  service?: string;
  state?: string;
  status?: string;
}

/** 查询该项目容器状态。 */
export async function composeStatus(
  ssh: SshClient,
  opts: ComposeCommandOptions,
  logger: Logger,
): Promise<ContainerStatus[]> {
  const res = await ssh.exec(`docker compose -p ${shellQuote(opts.projectName)} -f ${shellQuote(opts.composeFile)} ps --format json`, {
    cwd: opts.cwd,
  });
  const out: ContainerStatus[] = [];
  for (const line of res.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      out.push({
        name: typeof obj.Name === 'string' ? obj.Name : undefined,
        service: typeof obj.Service === 'string' ? obj.Service : undefined,
        state: typeof obj.State === 'string' ? obj.State : undefined,
        status: typeof obj.Status === 'string' ? obj.Status : undefined,
      });
    } catch {
      // 忽略无法解析的行。
    }
  }
  logger.info('compose.status.queried', '查询容器状态完成', { containers: out.length });
  return out;
}