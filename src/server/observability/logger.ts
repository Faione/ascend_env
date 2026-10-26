// Logger 门面：统一分级、子上下文、阈值过滤与稳定事件名，业务模块通过注入获得。

import type { ErrorInfo, LogLevel, StageName } from '../../shared/types.js';
import type { Redactor } from './redactor.js';
import type { LogStore } from './store.js';

export const LEVEL_ORDER: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
};

export interface LogContext {
  jobId?: string;
  stage?: StageName;
  requestId?: string;
  attempt?: number;
}

/** 可动态调整的阈值（服务级或任务级）。 */
export class LevelControl {
  constructor(public level: LogLevel = 'INFO') {}
  set(level: LogLevel): void {
    this.level = level;
  }
}

export interface LoggerOptions {
  component: string;
  context?: LogContext;
  threshold: () => LogLevel;
}

export class Logger {
  constructor(
    private readonly store: LogStore,
    private readonly opts: LoggerOptions,
    private readonly redactor: Redactor,
  ) {}

  child(extra: { component?: string; context?: LogContext }): Logger {
    return new Logger(
      this.store,
      {
        component: extra.component ?? this.opts.component,
        context: { ...this.opts.context, ...(extra.context ?? {}) },
        threshold: this.opts.threshold,
      },
      this.redactor,
    );
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.opts.threshold()];
  }

  trace(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('TRACE', event, message, data);
  }
  debug(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('DEBUG', event, message, data);
  }
  info(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('INFO', event, message, data);
  }
  warn(event: string, message: string, data?: Record<string, unknown>): void {
    this.log('WARN', event, message, data);
  }
  error(event: string, message: string, error?: ErrorInfo, data?: Record<string, unknown>): void {
    this.log('ERROR', event, message, data, error);
  }
  fatal(event: string, message: string, error?: ErrorInfo, data?: Record<string, unknown>): void {
    this.log('FATAL', event, message, data, error);
  }

  private log(
    level: LogLevel,
    event: string,
    message: string,
    data?: Record<string, unknown>,
    error?: ErrorInfo,
  ): void {
    if (!this.enabled(level)) return;
    this.store.append({
      timestamp: new Date().toISOString(),
      level,
      component: this.opts.component,
      event,
      message: this.redactor.redactString(message),
      context: this.opts.context,
      data: data ? (this.redactor.redactValue(data) as Record<string, unknown>) : undefined,
      error: error ? { ...error, summary: this.redactor.redactString(error.summary) } : undefined,
    });
  }
}

/** 从异常构造 ErrorInfo（不含堆栈/原文，便于日志）。 */
export function errorToInfo(err: Error, retryable = false): ErrorInfo {
  return { code: 'internal', name: err.name, summary: err.message, retryable };
}