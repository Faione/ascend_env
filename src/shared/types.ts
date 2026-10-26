// 领域数据类型与 API DTO。前端与服务端共用这些契约（通过 esbuild 打包共享）。
// 认证凭据（密码、私钥、口令）不得进入任务快照，只允许在运行期进程内存中短暂存在。

// ===== 版本目录与解析结果 =====

export type SocModel = string;
export type CpuArch = 'x86_64';

export type ArtifactId = 'toolkit' | 'ops' | 'torch' | 'torch_npu';
export type ArtifactKind = 'run-installer' | 'wheel';

export interface Artifact {
  id: ArtifactId;
  kind: ArtifactKind;
  /** 受控目录中的可信下载 URL。 */
  url: string;
  /** 期望的落盘文件名，也用于远端构建脚本的版本/型号校验。 */
  expectedName: string;
  /** 官方校验值（若有）；下载后优先与它核对。 */
  sha256?: string;
}

export interface ArtifactSet {
  cannVersion: string;
  socModel: SocModel;
  cpuArch: CpuArch;
  pythonVersion: string;
  torchVersion: string;
  torchNpuVersion: string;
  artifacts: Artifact[];
}

// ===== 用户配置 =====

export interface ReleaseSelection {
  cannVersion: string;
  socModel: SocModel;
  cpuArch: CpuArch;
  pythonVersion: string;
}

export type AuthMethod = 'agent' | 'password' | 'privateKey';

export interface SshAuth {
  method: AuthMethod;
  /** method === 'password' 时使用。 */
  password?: string;
  /** method === 'privateKey' 时使用。 */
  privateKey?: string;
  passphrase?: string;
}

/** 不包含任何认证凭据的目标配置快照。 */
export interface TargetConfig {
  host: string;
  port: number;
  username: string;
  remoteRoot: string;
}

export interface ImageConfig {
  baseImage: string;
  mirrorDomain: string;
}

export interface RuntimeConfig {
  devices: string[];
  driverLibPath: string;
  dcmiPath: string;
  versionInfoPath: string;
  installInfoPath: string;
  projectRoot: string;
  workingDir: string;
}

/** 启动任务所需的完整输入（不含认证凭据，凭据在运行时单独传入）。 */
export interface JobConfig {
  release: ReleaseSelection;
  target: TargetConfig;
  image: ImageConfig;
  runtime: RuntimeConfig;
}

// ===== 生成文件 =====

export interface GeneratedFiles {
  dockerfile: string;
  entrypoint: string;
  compose: string;
}

// ===== 归档清单 =====

export interface ManifestEntry {
  id: ArtifactId;
  /** 归档内的相对路径，如 build/packages/toolkit.run。 */
  path: string;
  /** 官方来源 URL（受控目录）。 */
  url: string;
  /** 原始文件名。 */
  expectedName: string;
  sha256: string;
  sizeBytes: number;
}

export interface Manifest {
  schemaVersion: 1;
  jobId: string;
  selection: ReleaseSelection;
  torchVersion: string;
  torchNpuVersion: string;
  createdAt: string;
  files: ManifestEntry[];
  /** 生成文件的 SHA256（dockerfile/entrypoint/compose），用于解包后一致性核对。 */
  generated: Record<string, string>;
}

// ===== 任务/阶段状态 =====

export type StageName = 'resolve' | 'bundle' | 'sync' | 'image' | 'compose';
export type StageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StageState {
  name: StageName;
  status: StageStatus;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorSummary?: string;
  retryable?: boolean;
  /** 各阶段产物标识，如 bundle 路径、远端目录、镜像 ID。 */
  artifacts?: Record<string, string>;
}

export type JobStatus = 'draft' | 'ready' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobSnapshot {
  id: string;
  createdAt: string;
  status: JobStatus;
  config: JobConfig;
  resolved?: ArtifactSet;
  stages: StageState[];
  generated?: GeneratedFiles;
}

// ===== 日志与实时事件 DTO（observability 模块产出，api 转发） =====

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface ErrorInfo {
  code: string;
  name: string;
  summary: string;
  retryable: boolean;
}

export interface LogEvent {
  schemaVersion: 1;
  /** 任务内持久递增序号，用于分页与 SSE 断线续接。 */
  id: string;
  timestamp: string;
  level: LogLevel;
  component: string;
  event: string;
  message: string;
  context?: Partial<{
    jobId: string;
    stage: StageName;
    requestId: string;
    attempt: number;
  }>;
  data?: Record<string, unknown>;
  error?: ErrorInfo;
}

export interface StageProgress {
  stage: StageName;
  status: StageStatus;
  /** 0..1 的进度百分比。 */
  ratio: number;
  bytesTransferred?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  detail?: string;
  updatedAt: string;
}

// ===== API 响应 =====

export interface ApiErrorBody {
  error: {
    code: string;
    summary: string;
    retryable: boolean;
  };
}

export interface ResolveResponse {
  selection: ReleaseSelection;
  artifactSet: ArtifactSet;
}

/** GET /api/catalog 返回的受支持组合摘要。 */
export interface CatalogItem {
  cannVersion: string;
  cpuArch: CpuArch;
  pythonVersion: string;
  torchVersion: string;
  torchNpuVersion: string;
  socModels: SocModel[];
}

export interface JobSummary {
  id: string;
  createdAt: string;
  status: JobStatus;
  config: JobConfig;
}

export interface JobDetail extends JobSummary {
  resolved?: ArtifactSet;
  stages: StageState[];
  generated?: GeneratedFiles;
}

export interface RunInitOptions {
  auth: SshAuth;
  /** 首次连接时可选的会话级主机密钥确认（由客户端回填）。 */
  hostKeyConfirm?: string;
}