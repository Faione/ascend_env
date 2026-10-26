// 稳定错误码与统一的应用错误类型。
// 错误码是诊断与前端展示的契约，改名会破坏已有任务记录与页面文案，因此保持稳定。

export const ErrorCodes = {
  INVALID_INPUT: 'invalid_input',
  NOT_FOUND: 'not_found',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',

  // catalog：组合解析与可信链接
  UNKNOWN_COMBINATION: 'catalog.unknown_combination',
  UNKNOWN_URL: 'catalog.unknown_url',

  // bundle：下载、缓存、归档
  DOWNLOAD_FAILED: 'bundle.download_failed',
  CHECKSUM_MISMATCH: 'bundle.checksum_mismatch',
  INSUFFICIENT_SPACE: 'bundle.insufficient_space',
  ARCHIVE_FAILED: 'bundle.archive_failed',

  // ssh：连接与认证
  SSH_CONNECT_FAILED: 'ssh.connect_failed',
  SSH_AUTH_FAILED: 'ssh.auth_failed',
  SSH_HOST_KEY_CHANGED: 'ssh.host_key_changed',
  SSH_HOST_KEY_UNKNOWN: 'ssh.host_key_unknown',

  // workspace：远端工作区与传输
  WORKSPACE_UPLOAD_FAILED: 'workspace.upload_failed',
  WORKSPACE_SPACE_FAILED: 'workspace.space_failed',
  WORKSPACE_UNPACK_FAILED: 'workspace.unpack_failed',
  REMOTE_HASH_MISMATCH: 'workspace.hash_mismatch',

  // image：构建
  IMAGE_PREFLIGHT_FAILED: 'image.preflight_failed',
  IMAGE_BUILD_FAILED: 'image.build_failed',
  DOCKER_DENIED: 'image.docker_denied',

  // compose：运行管理
  COMPOSE_VALIDATION_FAILED: 'compose.validation_failed',
  COMPOSE_UP_FAILED: 'compose.up_failed',

  // terminal：交互终端
  TERMINAL_NOT_RUNNING: 'terminal.not_running',
  TERMINAL_FAILED: 'terminal.failed',

  // storage / observability
  STORAGE_FAILED: 'storage.failed',
  OBSERVABILITY_DEGRADED: 'observability.degraded',

  // workflow：编排
  JOB_ALREADY_RUNNING: 'workflow.already_running',
  JOB_INVALID_STATE: 'workflow.invalid_state',
  JOB_CANCELLED: 'workflow.cancelled',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface AppErrorOptions {
  code: ErrorCode;
  /** 面向用户的安全摘要；不得包含凭据、原始命令或私钥内容。 */
  message: string;
  retryable?: boolean;
  /** 原始异常，仅本地 DEBUG 诊断模式允许记录其脱敏堆栈。 */
  cause?: unknown;
  /** 结构化补充信息，默认不写入日志，除非调用方显式脱敏。 */
  details?: unknown;
}

/**
 * 统一应用错误。`message` 记作 `summary` 并保证安全；
 * 真实命令输出、密码等敏感内容只能放在 `details`，由调用方决定是否脱敏记录。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(opts: AppErrorOptions) {
    super(opts.message);
    this.name = 'AppError';
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** 将任意异常规范化为 AppError；未知异常归为 INTERNAL 并沿用原 message（剥离堆栈）。 */
export function toAppError(err: unknown, fallbackCode: ErrorCode = ErrorCodes.INTERNAL): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AppError({ code: fallbackCode, message, cause: err });
}