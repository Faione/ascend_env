// 归档清单构建与校验的单元测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256Hex } from '../src/shared/hash.js';
import {
  archivePathFor,
  buildManifest,
  validateManifest,
} from '../src/server/bundle/manifest.js';
import type { GeneratedFiles } from '../src/shared/types.js';

const selection = { cannVersion: '9.1.0', socModel: '910b', cpuArch: 'x86_64', pythonVersion: '3.10' } as const;

const generated: GeneratedFiles = {
  dockerfile: 'FROM ubuntu:22.04\n',
  entrypoint: '#!/usr/bin/env bash\n',
  compose: 'services: {}\n',
};

const files = [
  { id: 'toolkit' as const, url: 'https://x/toolkit.run', expectedName: 'Ascend-cann-toolkit_9.1.0_linux-x86_64.run', sha256: 'a'.repeat(64), sizeBytes: 100 },
  { id: 'ops' as const, url: 'https://x/ops.run', expectedName: 'Ascend-cann-910b-ops_9.1.0_linux-x86_64.run', sha256: 'b'.repeat(64), sizeBytes: 200 },
  { id: 'torch' as const, url: 'https://x/torch.whl', expectedName: 'torch-2.10.0+cpu-cp310-cp310-manylinux_2_28_x86_64.whl', sha256: 'c'.repeat(64), sizeBytes: 300 },
  { id: 'torch_npu' as const, url: 'https://x/torch_npu.whl', expectedName: 'torch_npu-2.10.0.post4-cp310-cp310-manylinux_2_28_x86_64.whl', sha256: 'd'.repeat(64), sizeBytes: 400 },
];

test('archivePathFor 对 .run 统一改名、wheel 保留原名', () => {
  assert.equal(archivePathFor('toolkit', 'whatever.run'), 'build/packages/toolkit.run');
  assert.equal(archivePathFor('ops', 'whatever.run'), 'build/packages/ops.run');
  assert.equal(archivePathFor('torch', 'torch.whl'), 'build/packages/torch.whl');
});

test('buildManifest 记录来源、路径与生成文件哈希', () => {
  const m = buildManifest({ jobId: 'job-1', selection, torchVersion: '2.10.0', torchNpuVersion: '2.10.0.post4', files, generated });
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.files.length, 4);
  assert.equal(m.files[0].path, 'build/packages/toolkit.run');
  assert.equal(m.generated.dockerfile, sha256Hex(generated.dockerfile));
  assert.equal(m.generated.compose, sha256Hex(generated.compose));
});

test('validateManifest 通过合法清单并拒绝异常', () => {
  const m = buildManifest({ jobId: 'job-1', selection, torchVersion: '2.10.0', torchNpuVersion: '2.10.0.post4', files, generated });
  assert.doesNotThrow(() => validateManifest(m));

  const bad = { ...m, files: m.files.slice(0, 3) };
  assert.throws(() => validateManifest(bad));

  const badPath = { ...m, files: m.files.map((f, i) => (i === 0 ? { ...f, path: 'etc/passwd' } : f)) };
  assert.throws(() => validateManifest(badPath));

  const badHash = { ...m, files: m.files.map((f, i) => (i === 0 ? { ...f, sha256: 'zzz' } : f)) };
  assert.throws(() => validateManifest(badHash));
});