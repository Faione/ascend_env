// 可观测性装配：单例 Redactor、服务级日志（含控制台兜底）、按任务的日志与命令输出。

import { join } from 'node:path';
import type { DataPaths } from '../config.js';
import { CommandOutputStore } from './command-output.js';
import { LevelControl, Logger } from './logger.js';
import { Redactor } from './redactor.js';
import { LogStore } from './store.js';

export interface JobLog {
  store: LogStore;
  level: LevelControl;
  logger: Logger;
  commandOutput: CommandOutputStore;
  /** events.jsonl 路径，供 api 读取。 */
  eventsPath: string;
}

export class Observability {
  readonly redactor = new Redactor();
  readonly serviceLevel = new LevelControl('INFO');
  readonly serviceStore: LogStore;
  readonly service: Logger;
  private readonly jobLogs = new Map<string, JobLog>();

  constructor(readonly paths: DataPaths) {
    this.serviceStore = new LogStore({
      filePath: join(paths.logsDir, 'service.jsonl'),
      idScope: 'service',
    });
    this.service = new Logger(
      this.serviceStore,
      { component: 'service', threshold: () => this.serviceLevel.level },
      this.redactor,
    );
    // 控制台兜底：服务事件同步输出，便于启动失败与本机排障。
    this.serviceStore.subscribe((e) => {
      const err = e.level === 'WARN' || e.level === 'ERROR' || e.level === 'FATAL';
      const line = `[${e.level}] ${e.component} ${e.event} ${e.message}`;
      if (err) process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    });
  }

  /** 取得（或创建）任务级日志与命令输出。 */
  jobLog(jobId: string): JobLog {
    let log = this.jobLogs.get(jobId);
    if (log) return log;
    const eventsPath = join(this.paths.logsDir, 'jobs', jobId, 'events.jsonl');
    const store = new LogStore({ filePath: eventsPath, idScope: jobId });
    const level = new LevelControl('INFO');
    const logger = new Logger(
      store,
      { component: 'workflow', context: { jobId }, threshold: () => level.level },
      this.redactor,
    );
    const commandOutput = new CommandOutputStore(
      join(this.paths.logsDir, 'jobs', jobId, 'build-output.log'),
      20 * 1024 * 1024,
      this.redactor,
    );
    log = { store, level, logger, commandOutput, eventsPath };
    this.jobLogs.set(jobId, log);
    return log;
  }
}