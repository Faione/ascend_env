// 任务快照持久化：原子写入、按 id 读取、列出历史任务。不保存任何凭据。

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobSnapshot } from '../../shared/types.js';

export interface SnapshotStoreOptions {
  root: string;
}

export class SnapshotStore {
  constructor(private readonly root: string) {}

  private jobDir(id: string): string {
    return join(this.root, id);
  }

  private snapshotPath(id: string): string {
    return join(this.jobDir(id), 'snapshot.json');
  }

  /** 原子保存：先写临时文件再改名，避免中途崩溃留下半截快照。 */
  save(snapshot: JobSnapshot): void {
    const dir = this.jobDir(snapshot.id);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'snapshot.json.tmp');
    const target = this.snapshotPath(snapshot.id);
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  load(id: string): JobSnapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.snapshotPath(id), 'utf8')) as JobSnapshot;
    } catch {
      return undefined;
    }
  }

  /** 按创建时间倒序列出全部历史任务快照。 */
  list(): JobSnapshot[] {
    const ids = this.existingIds();
    const snapshots: JobSnapshot[] = [];
    for (const id of ids) {
      const s = this.load(id);
      if (s) snapshots.push(s);
    }
    return snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  private existingIds(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }
}