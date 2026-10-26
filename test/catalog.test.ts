// 版本目录解析单元测试（读取仓库内 catalog.json，确保证据与组合解析逻辑）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ErrorCodes } from '../src/shared/errors.js';
import { listCatalog, resolveSelection } from '../src/server/catalog/resolve.js';

test('listCatalog 返回受支持组合', () => {
  const items = listCatalog();
  assert.ok(items.length > 0);
  const first = items[0];
  assert.equal(first.cannVersion, '9.1.0');
  assert.equal(first.cpuArch, 'x86_64');
  assert.equal(first.pythonVersion, '3.10');
  assert.ok(first.socModels.includes('910b'));
  assert.ok(first.socModels.includes('950'));
});

test('resolveSelection 解析 910b 组合为四个文件', () => {
  const set = resolveSelection({
    cannVersion: '9.1.0',
    socModel: '910b',
    cpuArch: 'x86_64',
    pythonVersion: '3.10',
  });
  assert.equal(set.artifacts.length, 4);
  const ids = set.artifacts.map((a) => a.id).sort();
  assert.deepEqual(ids, ['ops', 'toolkit', 'torch', 'torch_npu']);
  const ops = set.artifacts.find((a) => a.id === 'ops')!;
  assert.match(ops.expectedName, /910b/);
  // URL 来自受控目录，必须为 http(s)。
  for (const a of set.artifacts) assert.match(a.url, /^https?:\/\//);
});

test('resolveSelection 拒绝未知组合', () => {
  assert.throws(
    () => resolveSelection({ cannVersion: '0.0.0', socModel: '910', cpuArch: 'x86_64', pythonVersion: '3.10' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.UNKNOWN_COMBINATION,
  );
});

test('resolveSelection 拒绝未知算子型号', () => {
  assert.throws(
    () => resolveSelection({ cannVersion: '9.1.0', socModel: '310p', cpuArch: 'x86_64', pythonVersion: '3.10' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.UNKNOWN_COMBINATION,
  );
});