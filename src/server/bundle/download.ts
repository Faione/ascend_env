// 流式下载：http/https、跟随重定向、Range 断点续传、重试、超时、SHA256 增量计算与上传进度。
// 大安装包绝不整体读入内存；下载先写 `.part`，校验通过后再原子改名。

import { createHash, Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { AppError, ErrorCodes } from '../../shared/errors.js';

export interface Progress {
  transferred: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface DownloadOptions {
  url: string;
  /** 最终落盘路径；临时文件为 `${dest}.part`。 */
  dest: string;
  /** 官方校验值（若有），下载完成后对比。 */
  sha256?: string;
  signal?: AbortSignal;
  onProgress?: (p: Progress) => void;
  retries?: number;
  timeoutMs?: number;
}

export interface DownloadResult {
  bytes: number;
  sha256: string;
  resumed: boolean;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptDownload(opts);
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw toAbortError(err);
      if (attempt >= retries) break;
      const delay = 500 * 2 ** attempt;
      await delayOrAbort(delay, opts.signal);
    }
  }
  throw toAppError(lastErr, opts.url);
}

async function attemptDownload(opts: DownloadOptions): Promise<DownloadResult> {
  const part = `${opts.dest}.part`;
  const hash = createHash('sha256');
  let base = 0;
  if (existsSync(part)) {
    base = statSync(part).size;
    await hashExisting(hash, part);
  }

  const resumed = base > 0;
  await fetchOne(opts.url, opts, { resumeBytes: base, hash, part, base });
  const sha256 = hash.digest('hex');

  if (opts.sha256 && sha256 !== opts.sha256.toLowerCase()) {
    rmSync(part, { force: true });
    throw new AppError({
      code: ErrorCodes.CHECKSUM_MISMATCH,
      message: `下载校验失败（SHA256 不一致）: ${opts.url}`,
    });
  }

  renameSync(part, opts.dest);
  const total = statSync(opts.dest).size;
  return { bytes: total, sha256, resumed };
}

interface FetchState {
  resumeBytes: number;
  hash: Hash;
  part: string;
  base: number;
}

async function fetchOne(
  initialUrl: string,
  opts: DownloadOptions,
  state: FetchState,
  redirects = 0,
): Promise<void> {
  if (opts.signal?.aborted) throw abortError();
  const url = new URL(initialUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError({ code: ErrorCodes.DOWNLOAD_FAILED, message: `不支持的下载协议: ${url.protocol}` });
  }

  const headers: Record<string, string> = {};
  if (state.resumeBytes > 0) headers.Range = `bytes=${state.resumeBytes}-`;

  const response = await request(url, headers, opts);
  const status = response.statusCode ?? 0;

  if (status >= 300 && status < 400 && response.headers.location) {
    response.resume();
    if (redirects >= MAX_REDIRECTS) {
      throw new AppError({ code: ErrorCodes.DOWNLOAD_FAILED, message: `重定向次数过多: ${initialUrl}` });
    }
    const next = new URL(response.headers.location, url).toString();
    return fetchOne(next, opts, state, redirects + 1);
  }

  if (status !== 200 && status !== 206) {
    response.resume();
    throw new AppError({ code: ErrorCodes.DOWNLOAD_FAILED, message: `下载失败（HTTP ${status}）: ${initialUrl}` });
  }

  // 服务器未按 Range 返回 206 时，丢弃已写内容重新开始。
  const append = status === 206;
  const flags = append ? 'a' : 'w';
  if (!append) {
    state.base = 0;
    rmSync(state.part, { force: true });
  }

  const total = totalBytes(response, state.base, append);
  const write = createWriteStream(state.part, { flags });
  let received = 0;
  const started = Date.now();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    write.on('error', finish);
    response.on('data', (chunk: Buffer) => {
      state.hash.update(chunk);
      received += chunk.length;
      if (opts.signal?.aborted) {
        response.destroy();
        write.destroy();
        finish(abortError());
        return;
      }
      opts.onProgress?.({
        transferred: state.base + received,
        total,
        bytesPerSecond: rate(started, received),
      });
    });
    response.on('error', finish);
    response.on('end', () => write.end());
    response.on('close', () => finish());
    write.on('finish', () => finish());
    response.pipe(write);
  });

  if (opts.signal?.aborted) throw abortError();
}

async function request(
  url: URL,
  headers: Record<string, string>,
  opts: DownloadOptions,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? httpsGet : httpGet;
    const reqOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
      signal: opts.signal,
    };
    const req = lib(reqOptions, resolve);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', (err) => {
      if (opts.signal?.aborted) reject(abortError());
      else reject(new AppError({ code: ErrorCodes.DOWNLOAD_FAILED, message: `下载失败: ${err.message}`, cause: err }));
    });
  });
}

function totalBytes(response: IncomingMessage, base: number, append: boolean): number | undefined {
  const range = response.headers['content-range'];
  if (append && typeof range === 'string') {
    const m = /(\d+)$/.exec(range.trim());
    if (m) return Number(m[1]);
  }
  const len = response.headers['content-length'];
  if (typeof len === 'string') {
    const n = Number(len);
    return Number.isFinite(n) ? n + (append ? base : 0) : undefined;
  }
  return undefined;
}

function rate(started: number, received: number): number {
  const sec = (Date.now() - started) / 1000;
  return sec > 0 ? Math.round(received / sec) : 0;
}

async function hashExisting(hash: Hash, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path);
    s.on('data', (c) => hash.update(c as Buffer));
    s.on('error', reject);
    s.on('end', () => resolve());
  });
}

function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(abortError());
    });
  });
}

function abortError(): AppError {
  return new AppError({ code: ErrorCodes.JOB_CANCELLED, message: '操作已取消' });
}

function toAbortError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return abortError();
}

function toAppError(err: unknown, url: string): AppError {
  if (err instanceof AppError) return err;
  return new AppError({ code: ErrorCodes.DOWNLOAD_FAILED, message: `下载失败: ${url}`, cause: err });
}