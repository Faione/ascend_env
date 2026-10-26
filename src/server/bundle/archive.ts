// 归档生成：用 tar-stream 流式打出无压缩 bundle.tar，不把大安装包读入内存。
// 包文件本身已压缩，首版不重复压缩；条目名在写入前统一校验，杜绝绝对路径与 `..` 逃逸。

import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pack } from 'tar-stream';
import type { Pack } from 'tar-stream';
import { AppError, ErrorCodes } from '../../shared/errors.js';

export interface StringEntry {
  path: string;
  content: string;
}

export interface FileEntry {
  path: string;
  localPath: string;
  size: number;
}

export interface ArchiveInput {
  strings: StringEntry[];
  files: FileEntry[];
  directories?: string[];
}

const DIRECTORIES = ['build', 'build/packages', 'deploy'];

function assertSafeEntry(path: string): void {
  const ok =
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((s) => s !== '..' && s !== '.');
  if (!ok) {
    throw new AppError({ code: ErrorCodes.ARCHIVE_FAILED, message: `归档内路径不合法: ${path}` });
  }
}

/** 流式生成归档，返回归档字节数。 */
export function createArchive(outputPath: string, input: ArchiveInput, signal?: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const tar = pack();

    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      const appErr =
        err instanceof AppError
          ? err
          : new AppError({ code: ErrorCodes.ARCHIVE_FAILED, message: `归档失败: ${String(err)}`, cause: err });
      reject(appErr);
    };

    tar.pipe(output);

    const pending: Promise<void>[] = [];
    for (const dir of input.directories ?? DIRECTORIES) {
      const d = dir.endsWith('/') ? dir : `${dir}/`;
      assertSafeEntry(d);
      pending.push(addDirectory(tar, d));
    }
    for (const s of input.strings) {
      assertSafeEntry(s.path);
      tar.entry({ name: s.path, mode: 0o644 }, s.content);
    }
    for (const f of input.files) {
      assertSafeEntry(f.path);
      const size = f.size >= 0 ? f.size : statSync(f.localPath).size;
      pending.push(addFile(tar, f.path, f.localPath, size));
    }

    Promise.all(pending).then(
      () => {
        if (signal?.aborted) return fail(abortErr());
        tar.finalize();
      },
      fail,
    );

    if (signal) {
      signal.addEventListener('abort', () => {
        tar.destroy(abortErr());
        output.destroy();
      });
    }

    output.on('error', fail);
    output.on('finish', () => {
      if (!settled) {
        settled = true;
        resolve(statSync(outputPath).size);
      }
    });
  });
}

function addDirectory(tar: Pack, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entry = tar.entry({ name, type: 'directory' }, (err) => (err ? reject(err) : resolve()));
    entry.end(null);
  });
}

function addFile(tar: Pack, name: string, localPath: string, size: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const entry = tar.entry({ name, size, mode: 0o644 }, (err) => (err ? reject(err) : resolve()));
    const read = createReadStream(localPath);
    read.on('error', reject);
    entry.on('error', reject);
    read.on('data', (chunk) => {
      if (!entry.write(chunk)) {
        read.pause();
        entry.once('drain', () => read.resume());
      }
    });
    read.on('end', () => entry.end(null));
  });
}

function abortErr(): AppError {
  return new AppError({ code: ErrorCodes.JOB_CANCELLED, message: '操作已取消' });
}