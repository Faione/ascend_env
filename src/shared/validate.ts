// 输入规范化与校验。所有从 HTTP/CLI 进入的配置先经此处校验，
// 产生不可变的领域数据；远端路径不拼接不受信任的 shell 命令。

import { AppError, ErrorCodes } from './errors.js';
import type {
  ArtifactSet,
  CpuArch,
  ImageConfig,
  JobConfig,
  ReleaseSelection,
  RuntimeConfig,
  SocModel,
  SshAuth,
  TargetConfig,
} from './types.js';

const RE_HOST = /^[A-Za-z0-9._-]+$/;
const RE_VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;
const RE_TORCHNPU_VERSION = /^[0-9]+(\.[0-9]+){1,2}(\.post[0-9]+)?$/;
const RE_USERNAME = /^[A-Za-z0-9._-]+$/;
const RE_BASE_IMAGE = /^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$/;
const RE_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AppError({ code: ErrorCodes.INVALID_INPUT, message });
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 拒绝绝对路径中的 `.` / `..` 段，避免归档解包与远端挂载时逃逸。 */
export function isSafeAbsoluteLinuxPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  const segments = path.split('/').filter((s) => s.length > 0);
  return segments.every((s) => s !== '.' && s !== '..');
}

export function normalizeSocModel(v: unknown): SocModel {
  assert(isNonEmptyString(v), '算子型号（socModel）不能为空');
  return v.toLowerCase();
}

export function normalizeCpuArch(v: unknown): CpuArch {
  assert(isNonEmptyString(v), 'CPU 架构不能为空');
  const arch = v.toLowerCase();
  // 首版只支持 x86_64/amd64 包；amd64 在目录中映射到 x86_64 安装包。
  assert(arch === 'x86_64' || arch === 'amd64', `不支持的 CPU 架构: ${v}`);
  return 'x86_64';
}

export function validateReleaseSelection(v: unknown): ReleaseSelection {
  assert(typeof v === 'object' && v !== null, '版本选择不能为空');
  const r = v as Record<string, unknown>;
  assert(isNonEmptyString(r.cannVersion) && RE_VERSION.test(r.cannVersion), 'Toolkit 版本必须是数字版本，如 9.1.0');
  assert(isNonEmptyString(r.pythonVersion), 'Python 版本不能为空');
  return {
    cannVersion: r.cannVersion,
    socModel: normalizeSocModel(r.socModel),
    cpuArch: normalizeCpuArch(r.cpuArch),
    pythonVersion: r.pythonVersion,
  };
}

export function validateTargetConfig(v: unknown): TargetConfig {
  assert(typeof v === 'object' && v !== null, '目标服务器配置不能为空');
  const t = v as Record<string, unknown>;
  assert(isNonEmptyString(t.host) || RE_HOST.test(String(t.host)), '主机名格式不合法');
  const port = t.port === undefined ? 22 : Number(t.port);
  assert(Number.isInteger(port) && port >= 1 && port <= 65535, 'SSH 端口必须是 1-65535 的整数');
  assert(isNonEmptyString(t.username) && RE_USERNAME.test(t.username), '用户名格式不合法');
  assert(isNonEmptyString(t.remoteRoot) && isSafeAbsoluteLinuxPath(t.remoteRoot), '远端工作目录必须是绝对 Linux 路径且不含 . / .. 段');
  return {
    host: String(t.host),
    port,
    username: String(t.username),
    remoteRoot: String(t.remoteRoot),
  };
}

export function validateSshAuth(v: unknown): SshAuth {
  assert(typeof v === 'object' && v !== null, 'SSH 认证配置不能为空');
  const a = v as Record<string, unknown>;
  const method = a.method;
  assert(method === 'agent' || method === 'password' || method === 'privateKey', '不支持的 SSH 认证方式');
  if (method === 'password') assert(isNonEmptyString(a.password), '密码认证需要提供密码');
  if (method === 'privateKey') assert(isNonEmptyString(a.privateKey), '私钥认证需要提供私钥内容');
  return {
    method,
    ...(a.password !== undefined ? { password: String(a.password) } : {}),
    ...(a.privateKey !== undefined ? { privateKey: String(a.privateKey) } : {}),
    ...(a.passphrase !== undefined ? { passphrase: String(a.passphrase) } : {}),
  };
}

export function validateImageConfig(v: unknown): ImageConfig {
  assert(typeof v === 'object' && v !== null, '镜像配置不能为空');
  const i = v as Record<string, unknown>;
  const baseImage = isNonEmptyString(i.baseImage) ? i.baseImage : 'ubuntu:22.04';
  assert(RE_BASE_IMAGE.test(baseImage), '基础镜像名格式不合法');
  const mirrorDomain = isNonEmptyString(i.mirrorDomain) ? i.mirrorDomain : 'http://mirrors.tools.huawei.com';
  assert(RE_ORIGIN.test(mirrorDomain), '镜像站必须是不带路径的 http(s) origin');
  return { baseImage, mirrorDomain };
}

export function validateRuntimeConfig(v: unknown): RuntimeConfig {
  assert(typeof v === 'object' && v !== null, '运行配置不能为空');
  const r = v as Record<string, unknown>;
  const devices = Array.isArray(r.devices) ? r.devices : [];
  assert(devices.length > 0, '至少需要一个 NPU 设备节点');
  devices.forEach((d) => assert(isNonEmptyString(d) && isSafeAbsoluteLinuxPath(String(d)), `设备节点不合法: ${d}`));
  const reqAbs = (name: string): string => {
    assert(isNonEmptyString(r[name]) && isSafeAbsoluteLinuxPath(String(r[name])), `${name} 必须是绝对 Linux 路径`);
    return String(r[name]);
  };
  return {
    devices: devices.map(String),
    driverLibPath: reqAbs('driverLibPath'),
    dcmiPath: reqAbs('dcmiPath'),
    versionInfoPath: reqAbs('versionInfoPath'),
    installInfoPath: reqAbs('installInfoPath'),
    projectRoot: reqAbs('projectRoot'),
    workingDir: reqAbs('workingDir'),
  };
}

export function validateJobConfig(v: unknown): JobConfig {
  assert(typeof v === 'object' && v !== null, '任务配置不能为空');
  const c = v as Record<string, unknown>;
  return {
    release: validateReleaseSelection(c.release),
    target: validateTargetConfig(c.target),
    image: validateImageConfig(c.image),
    runtime: validateRuntimeConfig(c.runtime),
  };
}

/** 校验目录解析结果的关键不变量，避免被污染数据破坏后续流程。 */
export function validateArtifactSet(set: ArtifactSet): void {
  assert(isNonEmptyString(set.cannVersion), 'ArtifactSet 缺少 cannVersion');
  assert(set.artifacts.length === 4, 'ArtifactSet 必须恰好包含四个文件');
  const ids = new Set(set.artifacts.map((a) => a.id));
  assert(ids.size === 4, 'ArtifactSet 文件 id 重复');
  for (const id of ['toolkit', 'ops', 'torch', 'torch_npu']) {
    assert(ids.has(id as ArtifactSet['artifacts'][number]['id']), `ArtifactSet 缺少 ${id}`);
  }
  for (const a of set.artifacts) {
    assert(isSafeFileName(a.expectedName), `文件名不合法: ${a.expectedName}`);
  }
}

const RE_FILE_NAME = /^[A-Za-z0-9._%+-]+$/;
export function isSafeFileName(name: string): boolean {
  return RE_FILE_NAME.test(name) && !name.includes('..') && name !== '.' && name !== '..';
}

export function assertTorchNpuCompatible(torch: string, torchNpu: string): void {
  assert(RE_TORCHNPU_VERSION.test(torchNpu), 'TorchNPU 版本必须形如 2.10.0.post4');
  assert(torchNpu === torch || torchNpu.startsWith(`${torch}.post`), 'TorchNPU 版本必须与 Torch 版本匹配');
}