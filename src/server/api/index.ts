// 本地 HTTP 服务：静态资源、配置校验入口、HTTP API、SSE 日志/进度与终端 WebSocket。
// 只监听回环地址；对浏览器来源做同源校验；终端输出视为不可信文本由前端转义展示。

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { AppError, ErrorCodes, toAppError } from '../../shared/errors.js';
import type { JobSnapshot, RunInitOptions } from '../../shared/types.js';
import { validateReleaseSelection, validateSshAuth } from '../../shared/validate.js';
import { listCatalog, resolveSelection } from '../catalog/resolve.js';
import { SERVICE_NAME, projectName } from '../render.js';
import { workspacePaths } from '../workspace/index.js';
import { openComposeTerminal } from '../terminal/index.js';
import type { DataPaths } from '../config.js';
import type { Observability } from '../observability/index.js';

export interface ApiOptions {
  workflow: import('../workflow/index.js').Workflow;
  observability: Observability;
  dataPaths: DataPaths;
  webRoot: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const SSE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export class ApiServer {
  private server?: Server;
  private wss?: WebSocketServer;

  constructor(private readonly opts: ApiOptions) {}

  async start(port: number): Promise<{ port: number }> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;

    this.wss = new WebSocketServer({ noServer: true });
    const wss = this.wss;
    server.on('upgrade', (req, socket, head) => {
      if (!this.isLocalOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      const path = pathnameOf(req);
      if (path.startsWith('/api/jobs/') && path.endsWith('/terminal')) {
        wss.handleUpgrade(req, socket, head, (ws) => this.handleTerminal(ws, req, path));
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', () => resolveListen());
    });

    const addr = server.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    return { port: bound };
  }

  async close(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.close();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = pathnameOf(req);
      if (!path.startsWith('/api/')) {
        this.serveStatic(req, res, path);
        return;
      }
      if (!this.isLocalOrigin(req.headers.origin)) {
        reject(res, 403, 'forbidden');
        return;
      }
      await this.route(req, res, path);
    } catch (err) {
      this.sendError(res, err);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/api/catalog') {
      this.sendJson(res, 200, { items: listCatalog() });
      return;
    }
    if (method === 'POST' && path === '/api/resolve') {
      const body = await readJson(req);
      const selection = validateReleaseSelection(body?.selection);
      this.sendJson(res, 200, { selection, artifactSet: resolveSelection(selection) });
      return;
    }
    if (method === 'POST' && path === '/api/jobs') {
      const body = await readJson(req);
      const snap = this.opts.workflow.create(body);
      this.sendJson(res, 201, this.toDetail(snap));
      return;
    }
    if (method === 'GET' && path === '/api/jobs') {
      this.sendJson(res, 200, { jobs: this.opts.workflow.list().map((s) => this.toSummary(s)) });
      return;
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)(\/.*)?$/.exec(path);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const rest = jobMatch[2] ?? '';
      if (rest === '' && method === 'GET') {
        this.sendJson(res, 200, this.toDetail(this.opts.workflow.get(jobId)));
        return;
      }
      if (rest === '/run' && method === 'POST') {
        const init = await this.parseRunInit(req);
        this.opts.workflow.run(jobId, init).catch((err) => this.logRunError(jobId, err));
        this.sendJson(res, 202, { id: jobId, status: 'running' });
        return;
      }
      if (rest === '/retry' && method === 'POST') {
        const init = await this.parseRunInit(req);
        this.opts.workflow.retry(jobId, init).catch((err) => this.logRunError(jobId, err));
        this.sendJson(res, 202, { id: jobId, status: 'running' });
        return;
      }
      if (rest === '/cancel' && method === 'POST') {
        await this.opts.workflow.cancel(jobId);
        this.sendJson(res, 200, { id: jobId, status: 'cancelled' });
        return;
      }
      if (rest === '/logs' && method === 'GET') {
        this.sendLogs(req, res, jobId);
        return;
      }
      if (rest === '/events' && method === 'GET') {
        this.sendEvents(req, res, jobId);
        return;
      }
      if (rest === '/bundle' && method === 'GET') {
        this.sendBundle(res, jobId);
        return;
      }
      if (rest === '/generated' && method === 'GET') {
        const snap = this.opts.workflow.get(jobId);
        this.sendJson(res, 200, { generated: snap.generated });
        return;
      }
    }

    this.sendError(res, new AppError({ code: ErrorCodes.NOT_FOUND, message: `未找到接口: ${method} ${path}` }));
  }

  private async parseRunInit(req: IncomingMessage): Promise<RunInitOptions> {
    const body = await readJson(req);
    const auth = validateSshAuth(body?.auth);
    const init: RunInitOptions = { auth };
    if (typeof body?.hostKeyConfirm === 'string' && body.hostKeyConfirm) {
      init.hostKeyConfirm = body.hostKeyConfirm;
    }
    return init;
  }

  private logRunError(jobId: string, err: unknown): void {
    const app = toAppError(err);
    this.opts.observability.service.warn('workflow.run.error', `任务 ${jobId} 执行出错: ${app.message}`);
  }

  // ===== SSE / 日志 =====

  private sendLogs(req: IncomingMessage, res: ServerResponse, jobId: string): void {
    const q = urlQuery(req);
    const jobLog = this.opts.observability.jobLog(jobId);
    const afterId = typeof q.afterId === 'string' ? q.afterId : undefined;
    const level = (typeof q.level === 'string' ? q.level : 'INFO') as
      | 'TRACE'
      | 'DEBUG'
      | 'INFO'
      | 'WARN'
      | 'ERROR'
      | 'FATAL';
    const limit = typeof q.limit === 'string' ? Number(q.limit) || 1000 : 1000;
    const events = jobLog.store.read({ afterId, level, limit });
    this.sendJson(res, 200, { events, hasMore: events.length >= limit });
  }

  private sendEvents(req: IncomingMessage, res: ServerResponse, jobId: string): void {
    const jobLog = this.opts.observability.jobLog(jobId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // 断线重连：按 Last-Event-ID 补发日志事件。
    const lastId = req.headers['last-event-id'];
    const replay = jobLog.store.read({ afterId: typeof lastId === 'string' ? lastId : undefined });
    for (const e of replay) {
      res.write(`id: ${e.id}\nevent: log\ndata: ${JSON.stringify(e)}\n\n`);
    }

    const unLog = jobLog.store.subscribe((e) => {
      res.write(`id: ${e.id}\nevent: log\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const unProg = this.opts.workflow.subscribeProgress(jobId, (p) => {
      res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

    res.on('close', () => {
      unLog();
      unProg();
      clearInterval(heartbeat);
    });
  }

  private sendBundle(res: ServerResponse, jobId: string): void {
    const snap = this.opts.workflow.get(jobId);
    const bundlePath = snap.stages.find((s) => s.name === 'bundle')?.artifacts?.bundlePath;
    if (!bundlePath || !existsSync(bundlePath)) {
      this.sendError(res, new AppError({ code: ErrorCodes.NOT_FOUND, message: '归档尚未生成' }));
      return;
    }
    const name = `bundle-${snap.id}.tar`;
    res.writeHead(200, {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': statSync(bundlePath).size,
    });
    const stream = createReadStream(bundlePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ===== 终端 =====

  private async handleTerminal(ws: WebSocket, _req: IncomingMessage, path: string): Promise<void> {
    const jobId = decodeURIComponent(path.split('/')[3] ?? '');
    try {
      const snap = this.opts.workflow.get(jobId);
      if (snap.status !== 'succeeded') {
        ws.send(JSON.stringify({ type: 'error', message: '容器尚未就绪' }));
        ws.close();
        return;
      }
      const ssh = this.opts.workflow.getSsh(jobId);
      if (!ssh?.connected) {
        ws.send(JSON.stringify({ type: 'error', message: 'SSH 会话已断开，请重新执行任务' }));
        ws.close();
        return;
      }
      const wp = workspacePaths(snap.config.target, jobId);
      const pty = await openComposeTerminal(ssh, {
        projectName: projectName(jobId),
        composeFile: wp.composeFile,
        serviceName: SERVICE_NAME,
        cols: 80,
        rows: 24,
      });

      pty.onData((data) => ws.send(JSON.stringify({ type: 'output', data })));
      pty.onClose((code) => {
        ws.send(JSON.stringify({ type: 'exit', code }));
        ws.close();
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
          if (msg.type === 'input' && typeof msg.data === 'string') pty.write(msg.data);
          else if (msg.type === 'resize' && msg.cols && msg.rows) pty.resize(msg.cols, msg.rows);
        } catch {
          // 忽略无法解析的帧。
        }
      });
      ws.on('close', () => pty.close());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: toAppError(err).message }));
      ws.close();
    }
  }

  // ===== 静态资源 =====

  private serveStatic(_req: IncomingMessage, res: ServerResponse, path: string): void {
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const file = normalize(join(this.opts.webRoot, rel));
    if (!file.startsWith(resolve(this.opts.webRoot)) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const type = SSE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ===== 工具 =====

  private toSummary(s: JobSnapshot) {
    return { id: s.id, createdAt: s.createdAt, status: s.status, config: s.config };
  }

  private toDetail(s: JobSnapshot) {
    return {
      id: s.id,
      createdAt: s.createdAt,
      status: s.status,
      config: s.config,
      resolved: s.resolved,
      stages: s.stages,
      generated: s.generated,
    };
  }

  private isLocalOrigin(origin: string | undefined): boolean {
    if (!origin || origin === 'null') return true;
    try {
      const host = new URL(origin).hostname;
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    } catch {
      return false;
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    const app = toAppError(err);
    const status = app.code === ErrorCodes.NOT_FOUND ? 404 : app.code === ErrorCodes.INVALID_INPUT ? 400 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: app.code, summary: app.message, retryable: app.retryable } }));
  }
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}

function urlQuery(req: IncomingMessage): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of new URL(req.url ?? '/', 'http://localhost').searchParams) q[k] = v;
  return q;
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: { code: 'forbidden', summary: message, retryable: false } }));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new AppError({ code: ErrorCodes.INVALID_INPUT, message: '请求体过大' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text) as Record<string, unknown>);
      } catch {
        rejectPromise(new AppError({ code: ErrorCodes.INVALID_INPUT, message: '请求体不是合法 JSON' }));
      }
    });
    req.on('error', rejectPromise);
  });
}