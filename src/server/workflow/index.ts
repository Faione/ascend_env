// 任务编排：顺序执行 resolve → bundle → sync → image → compose 五个阶段，
// 维护阶段与任务状态机、进度事件、取消与失败恢复。并发受限于单个运行任务。

import { randomBytes } from 'node:crypto';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import type {
  JobSnapshot,
  Manifest,
  RunInitOptions,
  StageName,
  StageProgress,
  StageState,
} from '../../shared/types.js';
import { validateJobConfig } from '../../shared/validate.js';
import { resolveSelection } from '../catalog/resolve.js';
import type { DataPaths } from '../config.js';
import { BundleService } from '../bundle/index.js';
import { imageTag, projectName, renderGenerated } from '../render.js';
import { SshClient } from '../ssh/index.js';
import * as workspace from '../workspace/index.js';
import * as image from '../image/index.js';
import * as compose from '../compose/index.js';
import type { CommandOutputStore } from '../observability/command-output.js';
import type { Logger } from '../observability/logger.js';
import type { Observability } from '../observability/index.js';
import type { SnapshotStore } from '../storage/snapshots.js';

const STAGES: StageName[] = ['resolve', 'bundle', 'sync', 'image', 'compose'];
const PROGRESS_INTERVAL_MS = 1000;

export interface WorkflowOptions {
  snapshots: SnapshotStore;
  observability: Observability;
  dataPaths: DataPaths;
  bundle: BundleService;
}

interface RunContext {
  snap: JobSnapshot;
  logger: Logger;
  commandOutput: CommandOutputStore;
  abort: AbortController;
  init: RunInitOptions;
  ssh?: SshClient;
  bundlePath?: string;
  manifest?: Manifest;
  lastEmit: Map<StageName, number>;
}

export class Workflow {
  private readonly running = new Map<string, AbortController>();
  private readonly progressSubs = new Map<string, Set<(p: StageProgress) => void>>();
  private readonly sshClients = new Map<string, SshClient>();

  constructor(private readonly opts: WorkflowOptions) {}

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /** 运行完成后保留的 SSH 连接，供终端桥接复用。 */
  getSsh(jobId: string): SshClient | undefined {
    return this.sshClients.get(jobId);
  }

  /** 订阅任务阶段/进度事件（供 SSE）。返回取消订阅函数。 */
  subscribeProgress(jobId: string, fn: (p: StageProgress) => void): () => void {
    let set = this.progressSubs.get(jobId);
    if (!set) {
      set = new Set();
      this.progressSubs.set(jobId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** 创建任务：解析目录并预渲染生成文件（解析错误在此即抛出）。 */
  create(rawConfig: unknown): JobSnapshot {
    const config = validateJobConfig(rawConfig);
    const id = generateJobId();
    const artifactSet = resolveSelection(config.release);
    const generated = renderGenerated(id, config);
    const snapshot: JobSnapshot = {
      id,
      createdAt: new Date().toISOString(),
      status: 'ready',
      config,
      resolved: artifactSet,
      generated,
      stages: STAGES.map((name): StageState => ({ name, status: 'pending' })),
    };
    this.opts.snapshots.save(snapshot);
    return snapshot;
  }

  get(jobId: string): JobSnapshot {
    const snap = this.opts.snapshots.load(jobId);
    if (!snap) throw new AppError({ code: ErrorCodes.NOT_FOUND, message: `任务不存在: ${jobId}` });
    return snap;
  }

  list(): JobSnapshot[] {
    return this.opts.snapshots.list();
  }

  async run(jobId: string, init: RunInitOptions): Promise<void> {
    await this.execute(jobId, init);
  }

  async retry(jobId: string, init: RunInitOptions): Promise<void> {
    await this.execute(jobId, init);
  }

  async cancel(jobId: string): Promise<void> {
    const ac = this.running.get(jobId);
    if (ac) {
      ac.abort();
      return;
    }
    const snap = this.opts.snapshots.load(jobId);
    if (!snap) throw new AppError({ code: ErrorCodes.NOT_FOUND, message: `任务不存在: ${jobId}` });
    throw new AppError({ code: ErrorCodes.JOB_INVALID_STATE, message: '任务当前未在运行' });
  }

  private async execute(jobId: string, init: RunInitOptions): Promise<void> {
    const snap = this.get(jobId);
    if (this.running.has(jobId)) {
      throw new AppError({ code: ErrorCodes.JOB_ALREADY_RUNNING, message: '任务已在运行' });
    }
    if (this.running.size > 0) {
      throw new AppError({ code: ErrorCodes.JOB_ALREADY_RUNNING, message: '已有任务在运行，请稍后再试' });
    }

    const startIndex = findStartIndex(snap.stages);
    if (startIndex >= STAGES.length) return; // 全部阶段已成功

    const abort = new AbortController();
    this.running.set(jobId, abort);
    const jobLog = this.opts.observability.jobLog(jobId);
    const logger = jobLog.logger.child({ context: { jobId } });

    const ctx: RunContext = {
      snap,
      logger,
      commandOutput: jobLog.commandOutput,
      abort,
      init,
      lastEmit: new Map(),
    };

    try {
      for (let i = startIndex; i < STAGES.length; i++) {
        snap.stages[i].status = 'pending';
        snap.stages[i].errorCode = undefined;
        snap.stages[i].errorSummary = undefined;
        snap.stages[i].retryable = undefined;
      }
      snap.status = 'running';
      this.opts.snapshots.save(snap);

      for (let i = startIndex; i < STAGES.length; i++) {
        const stageName = STAGES[i];
        const stage = snap.stages[i];
        stage.status = 'running';
        stage.startedAt = new Date().toISOString();
        this.opts.snapshots.save(snap);
        logger.info(`stage.${stageName}.started`, `阶段开始: ${stageName}`, { stage: stageName });
        this.emit(jobId, { stage: stageName, status: 'running', ratio: 0, updatedAt: new Date().toISOString() });

        try {
          await this.runStage(stageName, ctx);
          stage.status = 'succeeded';
          stage.finishedAt = new Date().toISOString();
          this.opts.snapshots.save(snap);
          logger.info(`stage.${stageName}.completed`, `阶段完成: ${stageName}`, { stage: stageName });
          this.emit(jobId, { stage: stageName, status: 'succeeded', ratio: 1, updatedAt: new Date().toISOString() });
        } catch (err) {
          const app = toAppError(err);
          const cancelled = abort.signal.aborted || app.code === ErrorCodes.JOB_CANCELLED;
          stage.status = cancelled ? 'cancelled' : 'failed';
          stage.finishedAt = new Date().toISOString();
          stage.errorCode = app.code;
          stage.errorSummary = app.message;
          stage.retryable = app.retryable;
          snap.status = cancelled ? 'cancelled' : 'failed';
          this.opts.snapshots.save(snap);
          if (cancelled) {
            logger.warn(`stage.${stageName}.cancelled`, `阶段取消: ${stageName}`, { stage: stageName });
            this.emit(jobId, { stage: stageName, status: 'cancelled', ratio: 0, updatedAt: new Date().toISOString() });
          } else {
            logger.error(`stage.${stageName}.failed`, `阶段失败: ${stageName}`, appErrorInfo(app), { stage: stageName });
            this.emit(jobId, { stage: stageName, status: 'failed', ratio: 0, updatedAt: new Date().toISOString() });
          }
          return;
        }
      }

      snap.status = 'succeeded';
      this.opts.snapshots.save(snap);
      logger.info('workflow.completed', '任务执行完成');
    } finally {
      try {
        jobLog.commandOutput.flush();
      } catch {
        // 输出落盘失败不掩盖主流程结果。
      }
      this.running.delete(jobId);
    }
  }

  private async runStage(stage: StageName, ctx: RunContext): Promise<void> {
    const { snap, logger, abort } = ctx;
    const config = snap.config;
    const jobId = snap.id;

    switch (stage) {
      case 'resolve': {
        const artifactSet = resolveSelection(config.release);
        snap.resolved = artifactSet;
        snap.generated = renderGenerated(jobId, config);
        snap.stages[0].artifacts = { cannVersion: artifactSet.cannVersion, socModel: artifactSet.socModel };
        logger.info('stage.resolve.resolved', `解析完成: CANN ${artifactSet.cannVersion} / ${artifactSet.socModel}`, {
          cannVersion: artifactSet.cannVersion,
          socModel: artifactSet.socModel,
          torchVersion: artifactSet.torchVersion,
          torchNpuVersion: artifactSet.torchNpuVersion,
        });
        return;
      }

      case 'bundle': {
        const result = await this.opts.bundle.build({
          jobId,
          selection: config.release,
          artifactSet: snap.resolved!,
          generated: snap.generated!,
          cacheRoot: this.opts.dataPaths.cacheDir,
          signal: abort.signal,
          logger,
          onProgress: (p) => this.throttled(ctx, jobId, 'bundle', p.ratio, p.detail, p.transferred, p.total, p.bytesPerSecond),
        });
        ctx.bundlePath = result.bundlePath;
        ctx.manifest = result.manifest;
        snap.stages[1].artifacts = {
          bundlePath: result.bundlePath,
          totalBytes: String(result.totalBytes),
        };
        return;
      }

      case 'sync': {
        const ssh = this.ensureSsh(ctx);
        await ssh.connect();
        if (ssh.hostFingerprint) {
          logger.info('ssh.host.fingerprint', `目标主机指纹: ${ssh.hostFingerprint}`, { fingerprint: ssh.hostFingerprint });
        }
        const wp = workspace.workspacePaths(config.target, jobId);
        const pre = await workspace.preflight(ssh, config.target, logger);
        if (!pre.writable) {
          throw new AppError({ code: ErrorCodes.WORKSPACE_SPACE_FAILED, message: '远端工作目录不可写，请检查权限' });
        }
        await workspace.createJobDirs(ssh, wp, logger);
        await workspace.uploadBundle(
          ssh,
          ctx.bundlePath!,
          wp,
          logger,
          (p) => this.throttled(ctx, jobId, 'sync', p.total ? p.transferred / p.total : 0, '上传归档', p.transferred, p.total),
          abort.signal,
        );
        await workspace.unpack(ssh, wp, logger);
        snap.stages[2].artifacts = { jobDir: wp.jobDir, workDir: wp.workDir };
        return;
      }

      case 'image': {
        const ssh = this.ensureSsh(ctx);
        const wp = workspace.workspacePaths(config.target, jobId);
        await image.preflight(ssh, { baseImage: config.image.baseImage }, logger);
        const torchFile = wheelFile(ctx.manifest!, 'torch');
        const torchNpuFile = wheelFile(ctx.manifest!, 'torch_npu');
        const imageId = await image.build(
          ssh,
          {
            workDir: wp.workDir,
            imageTag: imageTag(jobId),
            baseImage: config.image.baseImage,
            mirrorDomain: config.image.mirrorDomain,
            torchVersion: snap.resolved!.torchVersion,
            torchNpuVersion: snap.resolved!.torchNpuVersion,
            torchWheelFile: torchFile,
            torchNpuWheelFile: torchNpuFile,
            onOutput: (c) => ctx.commandOutput.append(c),
            signal: abort.signal,
          },
          logger,
        );
        snap.stages[3].artifacts = { imageId };
        return;
      }

      case 'compose': {
        const ssh = this.ensureSsh(ctx);
        const wp = workspace.workspacePaths(config.target, jobId);
        const copts = {
          cwd: wp.workDir,
          projectName: projectName(jobId),
          composeFile: wp.composeFile,
        };
        await compose.validateCompose(ssh, copts, logger);
        await compose.startCompose(ssh, copts, logger);
        const status = await compose.composeStatus(ssh, copts, logger);
        snap.stages[4].artifacts = { containers: JSON.stringify(status) };
        return;
      }
    }
  }

  private ensureSsh(ctx: RunContext): SshClient {
    if (!ctx.ssh) {
      ctx.ssh = new SshClient({
        target: ctx.snap.config.target,
        auth: ctx.init.auth,
        knownHostFingerprint: ctx.init.hostKeyConfirm,
        signal: ctx.abort.signal,
        logger: ctx.logger,
      });
      this.sshClients.set(ctx.snap.id, ctx.ssh);
    }
    return ctx.ssh;
  }

  private throttled(
    ctx: RunContext,
    jobId: string,
    stage: StageName,
    ratio: number,
    detail: string,
    bytesTransferred?: number,
    bytesTotal?: number,
    bytesPerSecond?: number,
  ): void {
    const now = Date.now();
    const last = ctx.lastEmit.get(stage) ?? 0;
    const isFinal = ratio >= 1;
    if (!isFinal && now - last < PROGRESS_INTERVAL_MS) return;
    ctx.lastEmit.set(stage, now);
    this.emit(jobId, {
      stage,
      status: 'running',
      ratio,
      detail,
      bytesTransferred,
      bytesTotal,
      bytesPerSecond,
      updatedAt: new Date().toISOString(),
    });
  }

  private emit(jobId: string, p: StageProgress): void {
    for (const fn of this.progressSubs.get(jobId) ?? []) {
      try {
        fn(p);
      } catch {
        // 忽略订阅者异常。
      }
    }
  }
}

function wheelFile(manifest: Manifest, id: 'torch' | 'torch_npu'): string {
  const entry = manifest.files.find((f) => f.id === id);
  if (!entry) throw new AppError({ code: ErrorCodes.INTERNAL, message: `清单缺少 ${id}` });
  return entry.expectedName;
}

function findStartIndex(stages: StageState[]): number {
  const idx = stages.findIndex((s) => s.status !== 'succeeded');
  return idx === -1 ? stages.length : idx;
}

function generateJobId(): string {
  const time = Date.now().toString(36);
  const rnd = randomBytes(4).toString('hex');
  return `job-${time}-${rnd}`;
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError({ code: ErrorCodes.INTERNAL, message: err instanceof Error ? err.message : String(err), cause: err });
}

function appErrorInfo(err: AppError): { code: string; name: string; summary: string; retryable: boolean } {
  return { code: err.code, name: 'AppError', summary: err.message, retryable: err.retryable };
}