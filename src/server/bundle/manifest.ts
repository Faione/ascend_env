// 归档清单的构建与校验。清单记录每个文件的官方来源、归档内路径、SHA256 与大小，
// 解包后据此在远端做一致性复核；生成文件的哈希也纳入，防止内容被篡改。

import { AppError, ErrorCodes } from '../../shared/errors.js';
import { sha256Hex } from '../../shared/hash.js';
import type {
  ArtifactId,
  GeneratedFiles,
  Manifest,
  ManifestEntry,
  ReleaseSelection,
} from '../../shared/types.js';
import { isSafeFileName } from '../../shared/validate.js';

/** 归档内相对路径规则：.run 统一改名，wheel 保留原名。 */
export function archivePathFor(id: ArtifactId, expectedName: string): string {
  if (id === 'toolkit') return 'build/packages/toolkit.run';
  if (id === 'ops') return 'build/packages/ops.run';
  return `build/packages/${expectedName}`;
}

export interface ManifestFileInput {
  id: ArtifactId;
  url: string;
  expectedName: string;
  sha256: string;
  sizeBytes: number;
}

export interface ManifestInput {
  jobId: string;
  selection: ReleaseSelection;
  torchVersion: string;
  torchNpuVersion: string;
  files: ManifestFileInput[];
  generated: GeneratedFiles;
  createdAt?: string;
}

export function buildManifest(input: ManifestInput): Manifest {
  const files: ManifestEntry[] = input.files.map((f) => ({
    id: f.id,
    path: archivePathFor(f.id, f.expectedName),
    url: f.url,
    expectedName: f.expectedName,
    sha256: f.sha256,
    sizeBytes: f.sizeBytes,
  }));
  return {
    schemaVersion: 1,
    jobId: input.jobId,
    selection: input.selection,
    torchVersion: input.torchVersion,
    torchNpuVersion: input.torchNpuVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files,
    generated: {
      dockerfile: sha256Hex(input.generated.dockerfile),
      entrypoint: sha256Hex(input.generated.entrypoint),
      compose: sha256Hex(input.generated.compose),
    },
  };
}

/** 校验清单关键不变量，供解包前后复用。 */
export function validateManifest(m: Manifest): void {
  const bad = (msg: string) => new AppError({ code: ErrorCodes.ARCHIVE_FAILED, message: msg });
  if (m.schemaVersion !== 1) throw bad('清单 schemaVersion 不是 1');
  if (!m.jobId || !m.torchVersion || !m.torchNpuVersion) throw bad('清单缺少必要字段');
  if (!Array.isArray(m.files) || m.files.length !== 4) throw bad('清单必须包含四个文件');
  for (const f of m.files) {
    if (!isSafeFileName(f.expectedName)) throw bad(`文件名不合法: ${f.expectedName}`);
    if (!/^build\/packages\/[A-Za-z0-9._%+-]+$/.test(f.path)) throw bad(`归档路径不合法: ${f.path}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw bad(`SHA256 格式不合法: ${f.expectedName}`);
    if (!Number.isInteger(f.sizeBytes) || f.sizeBytes <= 0) throw bad(`大小不合法: ${f.expectedName}`);
  }
}