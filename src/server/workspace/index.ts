// 远端工作区：预检存储与写权限、创建任务目录、带断点续传上传归档、SHA256 复核与安全解包。
// 上传写 `.part`，校验通过后原子改名，避免半截文件被误用；解包用受控 tar 命令并限定 -C 目标目录。

import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SFTPWrapper, Stats as SftpStats } from 'ssh2';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import { hashFile } from '../../shared/hash.js';
import type { TargetConfig } from '../../shared/types.js';
import type { Logger } from '../observability/logger.js';
import { shellQuote, type SshClient } from '../ssh/index.js';

export interface WorkspacePaths {
  jobDir: string;
  incomingDir: string;
  workDir: string;
  buildDir: string;
  deployDir: string;
  bundlePart: string;
  bundleTar: string;
  composeFile: string;
}

export function workspacePaths(target: TargetConfig, jobId: string): WorkspacePaths {
  const jobDir = join(target.remoteRoot, 'jobs', jobId);
  return {
    jobDir,
    incomingDir: join(jobDir, 'incoming'),
    workDir: join(jobDir, 'work'),
    buildDir: join(jobDir, 'work', 'build'),
    deployDir: join(jobDir, 'work', 'deploy'),
    bundlePart: join(jobDir, 'incoming', 'bundle.tar.part'),
    bundleTar: join(jobDir, 'incoming', 'bundle.tar'),
    composeFile: join(jobDir, 'work', 'deploy', 'compose.yaml'),
  };
}

export interface WorkspacePreflight {
  remoteRoot: string;
  writable: boolean;
  availableBytes?: number;
}

/** 检查远端根目录可创建/可写，并读取剩余空间。 */
export async function preflight(ssh: SshClient, target: TargetConfig, logger: Logger): Promise<WorkspacePreflight> {
  logger.info('workspace.preflight.started', '开始检查远端工作目录', { remoteRoot: target.remoteRoot });
  const root = shellQuote(target.remoteRoot);
  const mk = await ssh.exec(`mkdir -p ${root}`);
  if (mk.code !== 0) {
    throw new AppError({
      code: ErrorCodes.WORKSPACE_SPACE_FAILED,
      message: `无法创建远端工作目录: ${target.remoteRoot}`,
    });
  }
  const write = await ssh.exec(`test -w ${root} && echo writable || echo not-writable`);
  const writable = write.stdout.trim() === 'writable';
  if (!writable) {
    logger.warn('workspace.preflight.readonly', '远端工作目录不可写', undefined);
  }
  let availableBytes: number | undefined;
  const df = await ssh.exec(`df -Pk ${root}`);
  if (df.code === 0) {
    const lines = df.stdout.trim().split('\n');
    const data = lines[lines.length - 1];
    const fields = data.split(/\s+/);
    const availKiB = Number(fields[3]);
    if (Number.isFinite(availKiB)) availableBytes = availKiB * 1024;
  }
  logger.info('workspace.preflight.completed', '远端工作目录预检完成', { writable, availableBytes });
  return { remoteRoot: target.remoteRoot, writable, availableBytes };
}

/** 创建任务隔离目录 incoming/ 与 work/。 */
export async function createJobDirs(ssh: SshClient, paths: WorkspacePaths, logger: Logger): Promise<void> {
  logger.info('workspace.dirs.started', '开始创建远端任务目录', { jobDir: paths.jobDir });
  const res = await ssh.exec(
    `mkdir -p ${shellQuote(paths.incomingDir)} ${shellQuote(paths.workDir)}`,
  );
  if (res.code !== 0) {
    throw new AppError({
      code: ErrorCodes.WORKSPACE_UPLOAD_FAILED,
      message: `无法创建远端任务目录: ${paths.jobDir}`,
    });
  }
  logger.info('workspace.dirs.completed', '远端任务目录已就绪');
}

export interface UploadProgress {
  transferred: number;
  total: number;
}

/** 上传归档到 `.part`（支持按远端已有字节续传），校验远端 SHA256 后原子改名。 */
export async function uploadBundle(
  ssh: SshClient,
  localPath: string,
  paths: WorkspacePaths,
  logger: Logger,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<number> {
  const localSize = statSync(localPath).size;
  const sftp = await ssh.sftp();
  const offset = await remotePartSize(sftp, paths.bundlePart, localSize);
  logger.info('workspace.upload.started', '开始上传归档', { bytes: localSize, resumeOffset: offset });
  await putFileResumable(sftp, localPath, paths.bundlePart, offset, onProgress, signal);

  const sha = await hashFile(localPath);
  logger.info('workspace.upload.verifying', '开始远端 SHA256 校验');
  const remote = await ssh.exec(`sha256sum ${shellQuote(paths.bundlePart)}`);
  if (remote.code !== 0) {
    throw new AppError({ code: ErrorCodes.WORKSPACE_UPLOAD_FAILED, message: '远端 SHA256 校验命令失败' });
  }
  const remoteHash = remote.stdout.trim().split(/\s+/)[0].toLowerCase();
  if (remoteHash !== sha) {
    throw new AppError({ code: ErrorCodes.REMOTE_HASH_MISMATCH, message: '上传后远端 SHA256 不一致' });
  }
  logger.info('workspace.upload.verified', '归档已上传并通过 SHA256 校验', { sha256: sha });

  const mv = await ssh.exec(`mv -f ${shellQuote(paths.bundlePart)} ${shellQuote(paths.bundleTar)}`);
  if (mv.code !== 0) {
    throw new AppError({ code: ErrorCodes.WORKSPACE_UPLOAD_FAILED, message: '归档改名失败' });
  }
  logger.info('workspace.upload.completed', '归档上传完成', { bytes: localSize });
  return localSize;
}

/** 安全解包到 work/ 并校验关键标记文件存在。 */
export async function unpack(ssh: SshClient, paths: WorkspacePaths, logger: Logger): Promise<void> {
  logger.info('workspace.unpack.started', '开始解包归档', { workDir: paths.workDir });
  const tar = await ssh.exec(`tar -xf ${shellQuote(paths.bundleTar)} -C ${shellQuote(paths.workDir)}`);
  if (tar.code !== 0) {
    throw new AppError({ code: ErrorCodes.WORKSPACE_UNPACK_FAILED, message: '远端解包失败' });
  }
  const check = await ssh.exec(
    `test -f ${shellQuote(paths.buildDir + '/Dockerfile')} && test -f ${shellQuote(paths.composeFile)} && echo ok`,
  );
  if (check.stdout.trim() !== 'ok') {
    throw new AppError({ code: ErrorCodes.WORKSPACE_UNPACK_FAILED, message: '解包后缺少必需文件' });
  }
  logger.info('workspace.unpack.completed', '归档解包完成');
}

async function remotePartSize(sftp: SFTPWrapper, path: string, localSize: number): Promise<number> {
  try {
    const st = await sftpStat(sftp, path);
    if (st.size > 0 && st.size < localSize) return st.size;
  } catch {
    // 无 `.part` 或不可读：从 0 开始。
  }
  return 0;
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<SftpStats> {
  return new Promise((resolve, reject) => sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats))));
}

function putFileResumable(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  offset: number,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const localSize = statSync(localPath).size;
  return new Promise<void>((resolve, reject) => {
    const read = createReadStream(localPath, { start: offset });
    const write = sftp.createWriteStream(remotePath, { flags: offset > 0 ? 'a' : 'w', mode: 0o644 });
    let transferred = offset;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    write.on('error', fail);
    write.on('close', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    read.on('error', fail);
    read.on('data', (chunk) => {
      transferred += (chunk as Buffer).length;
      onProgress?.({ transferred, total: localSize });
    });
    read.pipe(write);
    if (signal) {
      signal.addEventListener('abort', () => {
        read.destroy();
        write.destroy();
        fail(new AppError({ code: ErrorCodes.JOB_CANCELLED, message: '操作已取消' }));
      });
    }
  });
}