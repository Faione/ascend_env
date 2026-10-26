// 前端单页逻辑：加载版本目录、组装配置、创建/运行任务、订阅 SSE 日志与进度，
// 预览生成文件、下载归档，并在任务成功后通过 WebSocket 桥接容器终端（xterm.js）。
// 页面只通过同源 HTTP/WS 接口访问辅助服务，不直接接触 SSH 或目标服务器。

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

// ===== 与 shared/types.ts 对齐的 DTO（浏览器侧轻量副本，避免引入 node 依赖） =====

type StageName = 'resolve' | 'bundle' | 'sync' | 'image' | 'compose';
type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type JobStatus = 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface CatalogItem {
  cannVersion: string;
  cpuArch: string;
  pythonVersion: string;
  torchVersion: string;
  torchNpuVersion: string;
  socModels: string[];
}

interface Artifact {
  id: string;
  url: string;
  expectedName: string;
}

interface ArtifactSet {
  cannVersion: string;
  socModel: string;
  cpuArch: string;
  pythonVersion: string;
  torchVersion: string;
  torchNpuVersion: string;
  artifacts: Artifact[];
}

interface StageState {
  name: StageName;
  status: StageStatus;
  errorSummary?: string;
}

interface GeneratedFiles {
  dockerfile: string;
  entrypoint: string;
  compose: string;
}

interface JobDetail {
  id: string;
  createdAt: string;
  status: JobStatus;
  config: JobConfig;
  stages: StageState[];
  generated?: GeneratedFiles;
}

interface ReleaseSelection {
  cannVersion: string;
  socModel: string;
  cpuArch: string;
  pythonVersion: string;
}

interface TargetConfig { host: string; port: number; username: string; remoteRoot: string; }
interface ImageConfig { baseImage: string; mirrorDomain: string; }
interface RuntimeConfig {
  devices: string[];
  driverLibPath: string;
  dcmiPath: string;
  versionInfoPath: string;
  installInfoPath: string;
  projectRoot: string;
  workingDir: string;
}
interface JobConfig {
  release: ReleaseSelection;
  target: TargetConfig;
  image: ImageConfig;
  runtime: RuntimeConfig;
}

interface LogEvent {
  id: string;
  timestamp: string;
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  component: string;
  event: string;
  message: string;
}

interface StageProgress {
  stage: StageName;
  status: StageStatus;
  ratio: number;
  detail?: string;
}

interface ApiErrorBody {
  error: { code: string; summary: string; retryable: boolean };
}

type AuthMethod = 'agent' | 'password' | 'privateKey';

interface SshAuth {
  method: AuthMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

// ===== 全局状态 =====

let catalog: CatalogItem[] = [];
let currentJobId: string | null = null;
let currentDetail: JobDetail | null = null;
let eventSource: EventSource | null = null;
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;

const STAGE_LABELS: Record<StageName, string> = {
  resolve: '解析',
  bundle: '打包',
  sync: '上传',
  image: '构建镜像',
  compose: '启动容器',
};

// ===== 工具 =====

function $(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`缺少元素 #${id}`);
  return n;
}
function val(id: string): string {
  return ($(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value.trim();
}
function setText(id: string, text: string): void {
  $(id).textContent = text;
}
function setStatus(text: string, cls: 'ok' | 'error' | ''): void {
  const el = $('form-status');
  el.textContent = text;
  el.className = `status-line ${cls}`.trim();
}

class HttpError extends Error {
  constructor(readonly body: Partial<ApiErrorBody>) {
    super(body.error?.summary ?? '请求失败');
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // 非 JSON 响应忽略。
    }
    throw new HttpError(body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stageName(name: string): StageName {
  return name as StageName;
}

// ===== 目录加载 =====

async function loadCatalog(): Promise<void> {
  const items = await api<CatalogItem[]>('/api/catalog');
  catalog = items;

  const by = (key: keyof CatalogItem) => [...new Set(items.map((i) => String(i[key])))];
  fillSelect('cann-version', by('cannVersion'));
  fillSelect('cpu-arch', by('cpuArch'));
  fillSelect('python-version', by('pythonVersion'));

  refreshSocOptions();
  const baseSelect = $('cann-version');
  baseSelect.addEventListener('change', refreshSocOptions);
  $('cpu-arch').addEventListener('change', refreshSocOptions);
  $('python-version').addEventListener('change', refreshSocOptions);
}

function fillSelect(id: string, values: string[]): void {
  const sel = $(id) as HTMLSelectElement;
  sel.innerHTML = values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function refreshSocOptions(): void {
  const cann = val('cann-version');
  const arch = val('cpu-arch');
  const py = val('python-version');
  const combo = catalog.find((c) => c.cannVersion === cann && c.cpuArch === arch && c.pythonVersion === py);
  const sel = $('soc-model') as HTMLSelectElement;
  const models = combo?.socModels ?? [];
  sel.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  void refreshResolve();
}

async function refreshResolve(): Promise<void> {
  const selection = buildSelection();
  if (!selection) return;
  try {
    const res = await api<{ artifactSet: ArtifactSet }>('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({ selection }),
    });
    const s = res.artifactSet;
    const names = s.artifacts.map((a) => a.expectedName).join('　');
    setText(
      'resolve-hint',
      `Torch ${s.torchVersion} / TorchNPU ${s.torchNpuVersion}　≡　${names}`,
    );
  } catch (err) {
    setText('resolve-hint', `解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildSelection(): ReleaseSelection | null {
  const cann = val('cann-version');
  const soc = val('soc-model');
  const arch = val('cpu-arch');
  const py = val('python-version');
  if (!cann || !soc || !arch || !py) return null;
  return { cannVersion: cann, socModel: soc, cpuArch: arch, pythonVersion: py };
}

// ===== 表单收集 =====

function buildJobConfig(): JobConfig {
  const selection = buildSelection();
  if (!selection) throw new Error('请先完整选择版本');
  const devices = val('runtime-devices')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    release: selection,
    target: {
      host: val('target-host'),
      port: Number(val('target-port') || '22'),
      username: val('target-username'),
      remoteRoot: val('target-remote-root'),
    },
    image: { baseImage: val('image-base'), mirrorDomain: val('image-mirror') },
    runtime: {
      devices,
      driverLibPath: val('runtime-driver'),
      dcmiPath: val('runtime-dcmi'),
      versionInfoPath: val('runtime-version'),
      installInfoPath: val('runtime-install'),
      projectRoot: val('runtime-project'),
      workingDir: val('runtime-workdir'),
    },
  };
}

function buildRunBody(): { auth: SshAuth; hostKeyConfirm?: string } {
  const method = ($('auth-method') as HTMLSelectElement).value as AuthMethod;
  const auth: SshAuth = { method };
  if (method === 'password') auth.password = val('auth-password');
  if (method === 'privateKey') {
    auth.privateKey = val('auth-private-key');
    const pp = val('auth-passphrase');
    if (pp) auth.passphrase = pp;
  }
  const hk = val('auth-host-key');
  const body: { auth: SshAuth; hostKeyConfirm?: string } = { auth };
  if (hk) body.hostKeyConfirm = hk;
  return body;
}

// ===== 任务操作 =====

async function createJob(): Promise<void> {
  setStatus('正在创建任务…', '');
  try {
    const detail = await api<JobDetail>('/api/jobs', { method: 'POST', body: JSON.stringify(buildJobConfig()) });
    bindJob(detail);
    setStatus(`任务已创建: ${detail.id}`, 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

function bindJob(detail: JobDetail): void {
  currentJobId = detail.id;
  currentDetail = detail;
  setText('job-id', detail.id);
  renderStages(detail.stages);
  renderGenerated(detail.generated);
  updateControls(detail.status);
  void loadLogs(detail.id);
}

async function runJob(kind: 'run' | 'retry'): Promise<void> {
  if (!currentJobId) return;
  setStatus(kind === 'run' ? '正在启动任务…' : '正在重试…', '');
  try {
    await api<{ id: string }>(`/api/jobs/${currentJobId}/${kind}`, {
      method: 'POST',
      body: JSON.stringify(buildRunBody()),
    });
    setStatus('任务已启动', 'ok');
    openEvents(currentJobId);
    void refreshDetail(currentJobId);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

async function cancelJob(): Promise<void> {
  if (!currentJobId) return;
  try {
    await api<{ id: string }>(`/api/jobs/${currentJobId}/cancel`, { method: 'POST' });
    setStatus('已请求取消', 'ok');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

async function refreshDetail(id: string): Promise<void> {
  const detail = await api<JobDetail>(`/api/jobs/${id}`);
  currentDetail = detail;
  renderStages(detail.stages);
  renderGenerated(detail.generated);
  updateControls(detail.status);
}

function updateControls(status: JobStatus): void {
  ($('btn-run') as HTMLButtonElement).disabled = status === 'running' || status === 'succeeded';
  ($('btn-retry') as HTMLButtonElement).disabled = status !== 'failed' && status !== 'cancelled';
  ($('btn-cancel') as HTMLButtonElement).disabled = status !== 'running';
  ($('btn-terminal') as HTMLButtonElement).disabled = status !== 'succeeded';
}

// ===== 阶段与进度显示 =====

function renderStages(stages: StageState[]): void {
  const ul = $('stages');
  ul.innerHTML = stages
    .map(
      (s) =>
        `<li class="${s.status}"><span class="dot"></span>${escapeHtml(STAGE_LABELS[stageName(s.name)])}${
          s.errorSummary ? `：${escapeHtml(s.errorSummary)}` : ''
        }</li>`,
    )
    .join('');
}

function updateProgress(p: StageProgress): void {
  const fill = $('progress-fill');
  fill.style.width = `${Math.round(p.ratio * 100)}%`;
  const pct = Math.round(p.ratio * 100);
  setText('progress-label', p.detail ? `${STAGE_LABELS[p.stage]} ${pct}% · ${p.detail}` : `${STAGE_LABELS[p.stage]} ${pct}%`);
  if (currentDetail) {
    const st = currentDetail.stages.find((s) => s.name === p.stage);
    if (st) {
      st.status = p.status;
      if (p.status !== 'running') st.status = p.status;
    }
    renderStages(currentDetail.stages);
  }
  if (p.status === 'succeeded' || p.status === 'failed' || p.status === 'cancelled') {
    void refreshDetail(currentJobId as string);
  }
}

// ===== 日志 =====

function appendLog(e: LogEvent): void {
  const pre = $('log-output');
  const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '';
  const line = document.createElement('div');
  line.className = `lvl-${e.level}`;
  line.textContent = `${time} [${e.level}] ${e.message}`;
  pre.appendChild(line);
  pre.scrollTop = pre.scrollHeight;
}

async function loadLogs(id: string): Promise<void> {
  const res = await api<{ events: LogEvent[] }>(`/api/jobs/${id}/logs`);
  $('log-output').textContent = '';
  for (const e of res.events) appendLog(e);
}

function openEvents(id: string): void {
  if (eventSource) eventSource.close();
  const es = new EventSource(`/api/jobs/${id}/events`);
  eventSource = es;
  es.addEventListener('log', (ev) => {
    try {
      appendLog(JSON.parse((ev as MessageEvent).data) as LogEvent);
    } catch {
      // 忽略坏帧。
    }
  });
  es.addEventListener('progress', (ev) => {
    try {
      updateProgress(JSON.parse((ev as MessageEvent).data) as StageProgress);
    } catch {
      // 忽略坏帧。
    }
  });
}

// ===== 生成文件预览与归档下载 =====

function renderGenerated(gen?: GeneratedFiles): void {
  const tabs = $('generated-tabs');
  if (!gen) {
    tabs.innerHTML = '';
    $('generated-content').textContent = '';
    setText('generated-hint', '创建任务后可在运行前预览 Dockerfile / Compose 等生成文件。');
    ($('bundle-link') as HTMLAnchorElement).hidden = true;
    return;
  }
  setText('generated-hint', '');
  const mapping: { label: string; key: keyof GeneratedFiles }[] = [
    { label: 'Dockerfile', key: 'dockerfile' },
    { label: 'entrypoint.sh', key: 'entrypoint' },
    { label: 'compose.yaml', key: 'compose' },
  ];
  tabs.innerHTML = mapping
    .map((m, i) => `<button data-key="${m.key}" class="${i === 0 ? 'active' : ''}">${m.label}</button>`)
    .join('');
  tabs.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const key = (b as HTMLButtonElement).dataset.key as keyof GeneratedFiles;
      $('generated-content').textContent = gen[key] ?? '';
    }),
  );
  $('generated-content').textContent = gen.dockerfile;
  updateBundleLink();
}

function updateBundleLink(): void {
  const link = $('bundle-link') as HTMLAnchorElement;
  if (!currentJobId) {
    link.hidden = true;
    return;
  }
  link.href = `/api/jobs/${currentJobId}/bundle`;
  link.hidden = false;
}

// ===== 终端 =====

function wireTerminal(): void {
  $('btn-terminal').addEventListener('click', () => openTerminal());
}

function openTerminal(): void {
  if (!currentJobId) return;
  if (terminal) return;
  const container = $('terminal');
  container.textContent = '';
  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    theme: { background: '#0f172a', foreground: '#e2e8f0' },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();
  setText('terminal-hint', '已连接容器 shell。');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/jobs/${currentJobId}/terminal`);

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as { type: string; data?: string; code?: number; message?: string };
      if (msg.type === 'output' && msg.data != null) terminal?.write(msg.data);
      else if (msg.type === 'error') setText('terminal-hint', `终端错误: ${msg.message}`);
      else if (msg.type === 'exit') {
        setText('terminal-hint', `终端已退出（exit ${msg.code ?? ''}）`);
      }
    } catch {
      // 忽略坏帧。
    }
  };
  ws.onclose = () => {
    setText('terminal-hint', '终端连接已关闭。');
  };

  terminal.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
  });
  terminal.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
}

// ===== 表单联动 =====

function wireAuthFields(): void {
  const method = $('auth-method') as HTMLSelectElement;
  const sync = () => {
    ($('auth-password-group') as HTMLElement).hidden = method.value !== 'password';
    ($('auth-key-group') as HTMLElement).hidden = method.value !== 'privateKey';
  };
  method.addEventListener('change', sync);
  sync();
}

function wireTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll<HTMLElement>('.tab-pane').forEach((p) => p.classList.remove('active'));
      ($(`tab-${t.dataset.tab}`) as HTMLElement).classList.add('active');
      if (t.dataset.tab === 'terminal' && terminal) fitAddon?.fit();
    }),
  );
}

// ===== 初始化 =====

function bindStaticControls(): void {
  $('btn-create').addEventListener('click', () => void createJob());
  $('btn-run').addEventListener('click', () => void runJob('run'));
  $('btn-retry').addEventListener('click', () => void runJob('retry'));
  $('btn-cancel').addEventListener('click', () => void cancelJob());
  wireAuthFields();
  wireTabs();
  wireTerminal();
}

async function init(): Promise<void> {
  bindStaticControls();
  try {
    await loadCatalog();
  } catch (err) {
    setStatus(`目录加载失败: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

void init();