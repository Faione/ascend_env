// 文件准备：按目录解析结果下载四个包到本地缓存，计算清单并流式打成 bundle.tar。
// 下载带断点续传与 SHA256 校验；同一 URL 的包按 URL 哈希缓存，任务间可复用。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256Hex, hashFile } from '../../shared/hash.js';
import type {
  Artifact,
  ArtifactSet,
  GeneratedFiles,
  Manifest,
  ReleaseSelection,
} from '../../shared/types.js';
import type { Logger } from '../observability/logger.js';
import { archivePathFor, buildManifest, type ManifestFileInput } from './manifest.js';
import { createArchive } from './archive.js';
import { downloadFile } from './download.js';

export interface BundleProgress {
  /** 0..1 的整体进度估计。 */
  ratio: number;
  detail: string;
  transferred: number;
  total?: number;
  bytesPerSecond?: number;
}

export interface BundleOptions {
  jobId: string;
  selection: ReleaseSelection;
  artifactSet: ArtifactSet;
  generated: GeneratedFiles;
  cacheRoot: string;
  signal?: AbortSignal;
  onProgress?: (p: BundleProgress) => void;
  logger: Logger;
}

export interface BundleResult {
  bundlePath: string;
  manifestPath: string;
  manifest: Manifest;
  totalBytes: number;
}

/** 按 URL 哈希得到缓存文件路径，文件名保留原始名以便校验与远端识别。 */
export function artifactCachePath(cacheRoot: string, a: Artifact): string {
  const key = sha256Hex(a.url).slice(0, 24);
  return join(cacheRoot, 'downloads', key, a.expectedName);
}

export class BundleService {
  /** 下载四包、生成清单与归档。幂等：同一 URL 已缓存时跳过下载。 */
  async build(opts: BundleOptions): Promise<BundleResult> {
    const { artifactSet, generated, jobId, cacheRoot, logger, signal } = opts;
    const bundleDir = join(cacheRoot, 'bundles', jobId);
    mkdirSync(bundleDir, { recursive: true });

    const files: ManifestFileInput[] = [];
    const localFiles: { path: string; localPath: string; size: number }[] = [];
    const total = artifactSet.artifacts.length;

    for (let i = 0; i < total; i++) {
      const a = artifactSet.artifacts[i];
      const dest = artifactCachePath(cacheRoot, a);
      mkdirSync(dirname(dest), { recursive: true });

      const { sha256, sizeBytes } = await ensureArtifact(a, dest, opts, i, total);

      files.push({ id: a.id, url: a.url, expectedName: a.expectedName, sha256, sizeBytes });
      localFiles.push({ path: archivePathFor(a.id, a.expectedName), localPath: dest, size: sizeBytes });
      opts.onProgress?.({
        ratio: (i + 1) / total,
        detail: `已准备 ${a.expectedName}`,
        transferred: sizeBytes,
        total: sizeBytes,
      });
    }

    const manifest = buildManifest({
      jobId,
      selection: opts.selection,
      torchVersion: artifactSet.torchVersion,
      torchNpuVersion: artifactSet.torchNpuVersion,
      files,
      generated,
    });
    const manifestString = JSON.stringify(manifest, null, 2);

    const manifestPath = join(bundleDir, 'manifest.json');
    writeFileSync(manifestPath, manifestString, 'utf8');

    const bundlePath = join(bundleDir, 'bundle.tar');
    logger.info('bundle.archive.started', '开始打包归档');
    const totalBytes = await createArchive(
      bundlePath,
      {
        strings: [
          { path: 'manifest.json', content: manifestString },
          { path: 'build/Dockerfile', content: generated.dockerfile },
          { path: 'build/entrypoint.sh', content: generated.entrypoint },
          { path: 'deploy/compose.yaml', content: generated.compose },
        ],
        files: localFiles,
      },
      signal,
    );
    logger.info('bundle.archive.completed', '归档打包完成', { bytes: totalBytes, files: localFiles.length });

    return { bundlePath, manifestPath, manifest, totalBytes };
  }
}

/** 下载或复用缓存；返回文件的实际 SHA256 与大小。 */
async function ensureArtifact(
  a: Artifact,
  dest: string,
  opts: BundleOptions,
  index: number,
  total: number,
): Promise<{ sha256: string; sizeBytes: number }> {
  const { logger, signal } = opts;

  if (existsSync(dest)) {
    const existing = await hashFile(dest);
    if (!a.sha256 || existing === a.sha256.toLowerCase()) {
      logger.info('bundle.download.cached', `复用已缓存文件: ${a.expectedName}`, { id: a.id });
      return { sha256: existing, sizeBytes: statSync(dest).size };
    }
    logger.warn('bundle.download.stale', `缓存校验值不符，重新下载: ${a.expectedName}`, { id: a.id });
  }

  logger.info('bundle.download.started', `开始下载: ${a.expectedName}`, { id: a.id });
  const result = await downloadFile({
    url: a.url,
    dest,
    sha256: a.sha256,
    signal,
    onProgress: (p) => {
      const within = p.total ? p.transferred / p.total : 0;
      opts.onProgress?.({
        ratio: (index + Math.max(0, Math.min(1, within))) / total,
        detail: `下载 ${a.expectedName}`,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      });
    },
  });
  logger.info('bundle.download.completed', `下载完成: ${a.expectedName}`, { id: a.id });
  return { sha256: result.sha256, sizeBytes: result.bytes };
}

// 供外部（workflow）复用清单校验。
export { validateManifest } from './manifest.js';