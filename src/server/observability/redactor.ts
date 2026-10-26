// 脱敏：在所有输出通道（文件、控制台、SSE、页面）之前统一处理，
// 保证密码、私钥、口令、令牌及签名 URL 不外泄。

const MAX_FIELD_LENGTH = 2000;

const SENSITIVE_NAME = /password|passwd|secret|token|privatekey|private_key|passphrase|authorization|cookie|credential/i;

// 常见签名/凭据查询参数，替换其值。
const SENSITIVE_QUERY = /([?&](?:token|access_token|signature|sig|x-amz-signature|x-amz-credential|secret|password|passwd|key|expires|sp)=)[^&\s]+/gi;
// URL 用户信息（user:pass@host）。
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/gi;

export class Redactor {
  private readonly secrets = new Set<string>();

  /** 注册一个已知的敏感值（如运行时密码、私钥、口令），后续字符串中出现即被替换。 */
  registerSecret(value: unknown): void {
    if (typeof value === 'string' && value.length > 0) {
      this.secrets.add(value);
    }
  }

  registerSecrets(values: Iterable<unknown>): void {
    for (const v of values) this.registerSecret(v);
  }

  redactString(value: string): string {
    let out = value;
    for (const s of this.secrets) {
      if (s.length > 0) out = out.split(s).join('[redacted]');
    }
    out = out.replace(URL_USERINFO, '$1[redacted]@').replace(SENSITIVE_QUERY, '$1[redacted]');
    return truncate(out);
  }

  redactField(name: string, value: unknown): unknown {
    if (SENSITIVE_NAME.test(name)) return '[redacted]';
    return this.redactValue(value);
  }

  redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redactString(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.redactField(k, v);
      }
      return out;
    }
    return value;
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_FIELD_LENGTH)}…[truncated]`;
}