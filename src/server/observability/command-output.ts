// 受控命令输出（如 Docker build 的 stdout/stderr）独立保存：脱敏、限量、保留最新内容，
// 与应用事件分开展示，避免海量构建行淹没阶段时间线。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Redactor } from './redactor.js';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export class CommandOutputStore {
  private chunks: string[] = [];
  private totalBytes = 0;
  private _truncated = false;
  private readonly subscribers = new Set<(chunk: string) => void>();

  constructor(
    private readonly filePath: string,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
    private readonly redactor?: Redactor,
  ) {}

  /** 追加一段输出；超出容量时丢弃最旧内容并置截断标记。 */
  append(raw: string): void {
    const chunk = this.redactor ? this.redactor.redactString(raw) : raw;
    this.chunks.push(chunk);
    this.totalBytes += Buffer.byteLength(chunk);
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift() ?? '';
      this.totalBytes -= Buffer.byteLength(dropped);
      this._truncated = true;
    }
    for (const fn of this.subscribers) {
      try {
        fn(chunk);
      } catch {
        // 忽略订阅者异常。
      }
    }
  }

  subscribe(fn: (chunk: string) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** 当前完整内容（已限量）。 */
  snapshot(): string {
    return this.chunks.join('');
  }

  get truncated(): boolean {
    return this._truncated;
  }

  /** 落盘（构建结束后调用）。 */
  flush(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, this.snapshot(), 'utf8');
  }

  /** 读取历史文件内容，供重启后查看。 */
  static read(filePath: string): string {
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
}