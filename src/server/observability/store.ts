// 按任务/服务的 JSON Lines 追加存储，带分段轮转与基于递增 id 的分页/续接。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { LogEvent, LogLevel } from '../../shared/types.js';
import { LEVEL_ORDER } from './logger.js';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  message: string;
  context?: LogEvent['context'];
  data?: Record<string, unknown>;
  error?: LogEvent['error'];
}

export interface LogStoreOptions {
  /** events.jsonl 的完整路径。 */
  filePath: string;
  /** id 前缀，service 或 jobId，形如 "job-123:42"。 */
  idScope: string;
  maxBytes?: number;
  maxSegments?: number;
}

export interface ReadQuery {
  afterId?: string;
  level?: LogLevel;
  limit?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 5;

export class LogStore {
  private nextId = 0;
  private readonly maxBytes: number;
  private readonly maxSegments: number;
  private readonly subscribers = new Set<(e: LogEvent) => void>();

  constructor(private readonly opts: LogStoreOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    mkdirSync(dirname(opts.filePath), { recursive: true });
    this.resetSequence();
  }

  /** 追加一条记录，分配递增 id、写盘并广播给订阅者。 */
  append(record: LogRecord): LogEvent {
    const event: LogEvent = { schemaVersion: 1, id: this.formatId(++this.nextId), ...record };
    this.appendLine(event);
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // 订阅者异常不阻塞日志写入。
      }
    }
    return event;
  }

  subscribe(fn: (e: LogEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** 按游标/级别分页读取；events 文件按时间顺序从旧到新读取。 */
  read(query: ReadQuery = {}): LogEvent[] {
    const minLevel = query.level ?? 'INFO';
    const afterSeq = query.afterId ? parseSeq(query.afterId) : 0;
    const out: LogEvent[] = [];
    const limit = query.limit ?? 1000;
    for (const file of this.chronologicalFiles()) {
      for (const e of this.parseFile(file)) {
        const seq = parseSeq(e.id);
        if (seq <= afterSeq) continue;
        if (LEVEL_ORDER[e.level] < LEVEL_ORDER[minLevel]) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  // ===== 内部 =====

  private formatId(n: number): string {
    return `${this.opts.idScope}:${n}`;
  }

  private appendLine(event: LogEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    const file = this.opts.filePath;
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > this.maxBytes) {
      this.rotate();
    }
    appendFileSync(file, line, 'utf8');
  }

  private rotate(): void {
    rmSync(this.segmentPath(this.maxSegments - 1), { force: true });
    for (let i = this.maxSegments - 1; i >= 1; i--) {
      const from = i === 1 ? this.opts.filePath : this.segmentPath(i - 1);
      if (existsSync(from)) renameSync(from, this.segmentPath(i));
    }
    // 当前 events.jsonl 被重命名为 events.1.jsonl，下次写入会新建。
  }

  private segmentPath(i: number): string {
    return this.opts.filePath.replace(/\.jsonl$/, `.${i}.jsonl`);
  }

  /** 返回时间顺序（最旧 → 最新）的文件列表。 */
  private chronologicalFiles(): string[] {
    const files: string[] = [];
    for (let i = this.maxSegments - 1; i >= 1; i--) {
      const p = this.segmentPath(i);
      if (existsSync(p)) files.push(p);
    }
    if (existsSync(this.opts.filePath)) files.push(this.opts.filePath);
    return files;
  }

  private parseFile(file: string): LogEvent[] {
    try {
      const text = readFileSync(file, 'utf8');
      const events: LogEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as LogEvent);
        } catch {
          // 跳过损坏行，不影响其余事件。
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  private resetSequence(): void {
    let max = 0;
    for (const file of this.chronologicalFiles()) {
      for (const e of this.parseFile(file)) {
        max = Math.max(max, parseSeq(e.id));
      }
    }
    this.nextId = max;
  }
}

function parseSeq(id: string): number {
  const idx = id.lastIndexOf(':');
  if (idx < 0) return 0;
  const n = Number(id.slice(idx + 1));
  return Number.isFinite(n) ? n : 0;
}