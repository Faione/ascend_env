// SSH 连接适配：封装 ssh2 的连接/认证、主机密钥指纹校验、受控命令执行与 PTY 通道。
// 所有远端命令由固定操作拼接，路径经引用转义；密码/私钥只在连接配置内使用，不进入日志。

import { createHash } from 'node:crypto';
import { Client, type ConnectConfig, type SFTPWrapper, type ExecOptions } from 'ssh2';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import type { SshAuth, TargetConfig } from '../../shared/types.js';
import type { Logger } from '../observability/logger.js';

export interface SshOptions {
  target: TargetConfig;
  auth: SshAuth;
  /** 已保存的 OpenSSH SHA256 指纹（"SHA256:..."）；首次连接为空，连接后回填 hostFingerprint。 */
  knownHostFingerprint?: string;
  signal?: AbortSignal;
  logger: Logger;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  signal?: string;
}

export interface ExecOptions2 {
  cwd?: string;
  env?: Record<string, string>;
  /** 将 stdout+stderr 合并回调（用于构建日志）。 */
  onOutput?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  timeoutMs?: number;
}

export interface PtyOptions {
  cols: number;
  rows: number;
  term?: string;
  command: string;
}

export interface PtySession {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: (code?: number, signal?: string) => void): void;
  close(): void;
}

/** OpenSSH 风格 SHA256 指纹，形如 "SHA256:<base64>"。 */
export function computeHostFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest}`;
}

function normalizeFingerprint(fp: string): string {
  return fp.replace(/^SHA256:/i, '').replace(/\s+/g, '');
}

export class SshClient {
  private client?: Client;
  private _hostFingerprint?: string;
  private _connected = false;

  constructor(private readonly opts: SshOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  /** 连接成功后回填目标主机指纹。 */
  get hostFingerprint(): string | undefined {
    return this._hostFingerprint;
  }

  /** 建立连接；认证失败/主机密钥变化/网络错误分别映射稳定错误码。 */
  async connect(): Promise<void> {
    if (this._connected) return;
    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let settled = false;
      let mismatch = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(mapConnectError(err, mismatch));
      };

      client.on('error', fail);
      client.on('ready', () => {
        if (settled) return;
        settled = true;
        this._connected = true;
        this.opts.logger.info('ssh.connected', 'SSH 连接已建立', {
          host: this.opts.target.host,
          port: this.opts.target.port,
          username: this.opts.target.username,
        });
        resolve();
      });

      const config = this.buildConfig((key) => {
        const fp = computeHostFingerprint(key);
        this._hostFingerprint = fp;
        if (this.opts.knownHostFingerprint) {
          const ok = normalizeFingerprint(fp) === normalizeFingerprint(this.opts.knownHostFingerprint);
          if (!ok) mismatch = true;
          return ok;
        }
        return true;
      });

      client.connect(config);

      if (this.opts.signal) {
        this.opts.signal.addEventListener('abort', () => {
          client.end();
          fail(new AppError({ code: ErrorCodes.JOB_CANCELLED, message: '操作已取消' }));
        });
      }
    });
  }

  private buildConfig(hostVerifier: (key: Buffer) => boolean): ConnectConfig {
    const { target, auth } = this.opts;
    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: 30_000,
      keepaliveInterval: 15_000,
      hostVerifier,
    };
    if (auth.method === 'agent') {
      if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK;
    } else if (auth.method === 'password') {
      config.password = auth.password;
    } else {
      config.privateKey = auth.privateKey;
      if (auth.passphrase) config.passphrase = auth.passphrase;
    }
    return config;
  }

  private requireClient(): Client {
    if (!this.client || !this._connected) {
      throw new AppError({ code: ErrorCodes.SSH_CONNECT_FAILED, message: 'SSH 连接未建立' });
    }
    return this.client;
  }

  /** 执行受控命令，返回退出码与合并输出；可配置工作目录与流式回调。 */
  async exec(command: string, opts: ExecOptions2 = {}): Promise<ExecResult> {
    await this.connect();
    const client = this.requireClient();
    const full = opts.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command;
    return new Promise<ExecResult>((resolve, reject) => {
      const execOpts: ExecOptions = {};
      if (opts.env) execOpts.env = opts.env;
      client.exec(full, execOpts, (err, stream) => {
        if (err) {
          reject(new AppError({ code: ErrorCodes.SSH_CONNECT_FAILED, message: `远端命令执行失败: ${err.message}`, cause: err }));
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('data', (d: Buffer) => {
          const s = d.toString();
          stdout += s;
          opts.onOutput?.(s);
          opts.onStdout?.(s);
        });
        stream.stderr.on('data', (d) => {
          const s = d.toString();
          stderr += s;
          opts.onOutput?.(s);
          opts.onStderr?.(s);
        });
        stream.on('close', (code: unknown, signal: unknown) => {
          const c = typeof code === 'number' ? code : -1;
          this.opts.logger.debug('ssh.exec.completed', '远端命令执行完成', {
            code: c,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
          });
          resolve({ stdout, stderr, code: c, signal: typeof signal === 'string' ? signal : undefined });
        });
        if (opts.timeoutMs) {
          setTimeout(() => {
            try {
              stream.signal('KILL');
            } catch {
              stream.destroy();
            }
          }, opts.timeoutMs);
        }
      });
    });
  }

  /** 打开一个交互式 PTY（用于 docker compose exec 终端桥接）。 */
  async openPty(opts: PtyOptions): Promise<PtySession> {
    await this.connect();
    const client = this.requireClient();
    return new Promise<PtySession>((resolve, reject) => {
      client.exec(opts.command, { pty: { term: opts.term ?? 'xterm-256color', cols: opts.cols, rows: opts.rows } }, (err, stream) => {
        if (err) {
          reject(new AppError({ code: ErrorCodes.SSH_CONNECT_FAILED, message: `PTY 打开失败: ${err.message}`, cause: err }));
          return;
        }
        let closed = false;
        let closeCb: ((code?: number, signal?: string) => void) | undefined;
        stream.on('close', (code: unknown, signal: unknown) => {
          closed = true;
          closeCb?.(typeof code === 'number' ? code : undefined, typeof signal === 'string' ? signal : undefined);
        });
        stream.stderr.on('data', () => {
          /* terminal 合并到 stdout；stderr 忽略以避免重复。 */
        });
        resolve({
          write: (data) => {
            if (!closed) stream.write(data);
          },
          resize: (cols, rows) => {
            if (!closed) stream.setWindow(rows, cols, 0, 0);
          },
          onData: (cb) => stream.on('data', (d: Buffer) => cb(d.toString())),
          onClose: (cb) => {
            closeCb = cb;
          },
          close: () => {
            if (!closed) stream.close();
          },
        });
      });
    });
  }

  /** 取得 SFTP 会话（供上传/远端文件操作复用）。 */
  async sftp(): Promise<SFTPWrapper> {
    await this.connect();
    const client = this.requireClient();
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new AppError({ code: ErrorCodes.WORKSPACE_UPLOAD_FAILED, message: `SFTP 不可用: ${err.message}`, cause: err }));
          return;
        }
        resolve(sftp);
      });
    });
  }

  close(): void {
    if (this.client && this._connected) {
      this._connected = false;
      try {
        this.client.end();
      } catch {
        // 忽略关闭异常。
      }
    }
  }
}

/** 单引号转义，供远端命令路径引用，防止注入。 */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

function mapConnectError(err: Error, mismatch: boolean): AppError {
  const msg = err.message ?? '';
  if (mismatch || /host key/i.test(msg)) {
    return new AppError({ code: ErrorCodes.SSH_HOST_KEY_CHANGED, message: '目标主机密钥与已保存指纹不一致', cause: err });
  }
  if (/authentication|auth.*fail|no supported methods/i.test(msg)) {
    return new AppError({ code: ErrorCodes.SSH_AUTH_FAILED, message: 'SSH 认证失败，请检查用户名与认证方式', cause: err });
  }
  return new AppError({ code: ErrorCodes.SSH_CONNECT_FAILED, message: `SSH 连接失败: ${msg}`, cause: err });
}