// 版本目录解析。读取 catalog/catalog.json 中的受控组合，
// 将用户选择解析为 ArtifactSet；未知组合报错，绝不拼出未经验证的 URL。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ErrorCodes } from '../../shared/errors.js';
import type { ArtifactSet, CatalogItem, CpuArch, ReleaseSelection, SocModel } from '../../shared/types.js';
import { assertTorchNpuCompatible, validateArtifactSet } from '../../shared/validate.js';
import { catalogDir } from '../config.js';

interface FileRef {
  url: string;
  fileName: string;
}

interface OpsEntry extends FileRef {
  socModel: string;
}

interface Combination {
  cannVersion: string;
  cpuArch: string;
  pythonVersion: string;
  torchVersion: string;
  torchNpuVersion: string;
  toolkit: FileRef;
  torch: FileRef;
  torchNpu: FileRef;
  ops: OpsEntry[];
}

interface CatalogFile {
  schemaVersion: 1;
  note?: string;
  combinations: Combination[];
}

let cached: CatalogFile | undefined;

/** 读取并缓存目录；文件不可解析时抛 STORAGE_FAILED 之外的上游错误。 */
export function loadCatalog(): CatalogFile {
  if (cached) return cached;
  const path = join(catalogDir(), 'catalog.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as CatalogFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.combinations)) {
      throw new Error('catalog.json 结构不符合预期');
    }
    cached = parsed;
    return parsed;
  } catch (err) {
    throw new AppError({
      code: ErrorCodes.STORAGE_FAILED,
      message: `无法读取版本目录: ${path}`,
      cause: err,
    });
  }
}

/** 列出全部受支持组合，供前端版本选择下拉与 /api/catalog 使用。 */
export function listCatalog(): CatalogItem[] {
  return loadCatalog().combinations.map((c) => ({
    cannVersion: c.cannVersion,
    cpuArch: c.cpuArch as CpuArch,
    pythonVersion: c.pythonVersion,
    torchVersion: c.torchVersion,
    torchNpuVersion: c.torchNpuVersion,
    socModels: c.ops.map((o) => o.socModel).sort(),
  }));
}

/** 将用户选择解析为四个文件的 ArtifactSet。 */
export function resolveSelection(selection: ReleaseSelection): ArtifactSet {
  const combo = loadCatalog().combinations.find(
    (c) =>
      c.cannVersion === selection.cannVersion &&
      c.cpuArch === selection.cpuArch &&
      c.pythonVersion === selection.pythonVersion,
  );
  if (!combo) {
    throw new AppError({
      code: ErrorCodes.UNKNOWN_COMBINATION,
      message: `不支持的版本组合: CANN ${selection.cannVersion} / ${selection.cpuArch} / Python ${selection.pythonVersion}`,
    });
  }
  assertTorchNpuCompatible(combo.torchVersion, combo.torchNpuVersion);

  const ops = combo.ops.find((o) => o.socModel === selection.socModel);
  if (!ops) {
    throw new AppError({
      code: ErrorCodes.UNKNOWN_COMBINATION,
      message: `不支持的算子型号: ${selection.socModel}`,
    });
  }

  const set: ArtifactSet = {
    cannVersion: combo.cannVersion,
    socModel: ops.socModel as SocModel,
    cpuArch: combo.cpuArch as CpuArch,
    pythonVersion: combo.pythonVersion,
    torchVersion: combo.torchVersion,
    torchNpuVersion: combo.torchNpuVersion,
    artifacts: [
      { id: 'toolkit', kind: 'run-installer', url: combo.toolkit.url, expectedName: combo.toolkit.fileName },
      { id: 'ops', kind: 'run-installer', url: ops.url, expectedName: ops.fileName },
      { id: 'torch', kind: 'wheel', url: combo.torch.url, expectedName: combo.torch.fileName },
      { id: 'torch_npu', kind: 'wheel', url: combo.torchNpu.url, expectedName: combo.torchNpu.fileName },
    ],
  };
  validateArtifactSet(set);
  return set;
}