// 镜像构建：渲染 Dockerfile（模板静态）、docker/compose 预检、受控 docker build 并回传日志与镜像 ID。
// 无 Docker 权限时在构建前即以 DOCKER_DENIED 停止，绝不自动提权 sudo。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import { templatesDir } from '../config.js';
import type { Logger } from '../observability/logger.js';
import { shellQuote, type SshClient } from '../ssh/index.js';

/** Dockerfile 与入口脚本是版本控制内模板，直接作为构建依据。 */
export function renderDockerfile(): string {
  return readFileSync(join(templatesDir(), 'Dockerfile'), 'utf8');
}

export function renderEntrypoint(): string {
  return readFileSync(join(templatesDir(), 'entrypoint.sh'), 'utf8');
}

export interface PreflightOptions {
  baseImage: string;
}

/** 预检：docker info、基础镜像存在且为 amd64。无权限时抛 DOCKER_DENIED。 */
export async function preflight(ssh: SshClient, opts: PreflightOptions, logger: Logger): Promise<void> {
  logger.info('image.preflight.started', '检查 Docker 可用性');
  const info = await ssh.exec('docker info');
  if (info.code !== 0) {
    const combined = `${info.stdout}\n${info.stderr}`;
    if (/permission denied|cannot connect to the Docker daemon/i.test(combined)) {
      throw new AppError({ code: ErrorCodes.DOCKER_DENIED, message: '当前 SSH 用户无 Docker 权限，请加入 docker 组或改用有权限的用户' });
    }
    throw new AppError({ code: ErrorCodes.IMAGE_PREFLIGHT_FAILED, message: 'Docker daemon 不可用' });
  }
  const arch = await ssh.exec(`docker image inspect --format '{{.Architecture}}' ${shellQuote(opts.baseImage)}`);
  if (arch.code !== 0) {
    throw new AppError({ code: ErrorCodes.IMAGE_PREFLIGHT_FAILED, message: `基础镜像不可用: ${opts.baseImage}` });
  }
  const a = arch.stdout.trim();
  if (a !== 'amd64' && a !== 'x86_64') {
    throw new AppError({ code: ErrorCodes.IMAGE_PREFLIGHT_FAILED, message: `基础镜像架构不是 amd64（实际 ${a || '未知'}）` });
  }
  logger.info('image.preflight.passed', 'Docker 预检通过', { baseImage: opts.baseImage });
}

export interface BuildOptions {
  workDir: string;
  imageTag: string;
  baseImage: string;
  mirrorDomain: string;
  torchVersion: string;
  torchNpuVersion: string;
  torchWheelFile: string;
  torchNpuWheelFile: string;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** 在远端执行 docker build，回传合并日志，成功后返回镜像 ID。 */
export async function build(ssh: SshClient, opts: BuildOptions, logger: Logger): Promise<string> {
  logger.info('image.build.started', '开始构建镜像', { imageTag: opts.imageTag });
  const command =
    `docker build --pull=false --platform linux/amd64 --progress=plain ` +
    `--build-arg BASE_IMAGE=${shellQuote(opts.baseImage)} ` +
    `--build-arg MIRROR_DOMAIN=${shellQuote(opts.mirrorDomain)} ` +
    `--build-arg TORCH_VERSION=${shellQuote(opts.torchVersion)} ` +
    `--build-arg TORCH_NPU_VERSION=${shellQuote(opts.torchNpuVersion)} ` +
    `--build-arg TORCH_WHEEL_FILE=${shellQuote(opts.torchWheelFile)} ` +
    `--build-arg TORCH_NPU_WHEEL_FILE=${shellQuote(opts.torchNpuWheelFile)} ` +
    `-f build/Dockerfile -t ${shellQuote(opts.imageTag)} build`;

  const res = await ssh.exec(command, {
    cwd: opts.workDir,
    env: { DOCKER_BUILDKIT: '1' },
    onOutput: opts.onOutput,
  });
  if (opts.signal?.aborted) {
    throw new AppError({ code: ErrorCodes.JOB_CANCELLED, message: '操作已取消' });
  }
  if (res.code !== 0) {
    throw new AppError({ code: ErrorCodes.IMAGE_BUILD_FAILED, message: `镜像构建失败（退出码 ${res.code}）` });
  }

  const id = await ssh.exec(`docker image inspect --format '{{.Id}}' ${shellQuote(opts.imageTag)}`);
  const imageId = id.stdout.trim();
  if (!imageId) {
    throw new AppError({ code: ErrorCodes.IMAGE_BUILD_FAILED, message: '无法读取镜像 ID' });
  }
  logger.info('image.build.completed', '镜像构建成功', { imageId });
  return imageId;
}