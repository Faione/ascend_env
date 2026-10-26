// 任务编排状态机的单元测试：使用注入的假下载服务与不可达 SSH 目标，
// 验证 create/get 与「resolve、bundle 成功 → sync 失败」的失败状态迁移。
// 不依赖真实 NPU 主机或网络，仅覆盖到模拟集成阶段。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workflow } from '../src/server/workflow/index.js';
import { Observability } from '../src/server/observability/index.js';
import { SnapshotStore } from '../src/server/storage/snapshots.js';
import type { BundleService } from '../src/server/bundle/index.js';
import type { DataPaths } from '../src/server/config.js';
import type { JobConfig, Manifest, RunInitOptions } from '../src/shared/types.js';

function makePaths(): DataPaths {
  const dir = mkdtempSync(join(tmpdir(), 'ascend-wf-'));
  return {
    appRoot: dir,
    dataDir: dir,
    logsDir: join(dir, 'logs'),
    cacheDir: join(dir, 'cache'),
    jobsDir: join(dir, 'jobs'),
    catalogDir: join(dir, 'catalog'),
    templatesDir: join(dir, 'templates'),
  };
}

const config: JobConfig = {
  release: { cannVersion: '9.1.0', socModel: '910b', cpuArch: 'x86_64', pythonVersion: '3.10' },
  // 指向必然拒绝连接的本机端口，驱动 sync 阶段失败，无需真实 SSH 服务。
  target: { host: '127.0.0.1', port: 1, username: 'root', remoteRoot: '/data/ascend' },
  image: { baseImage: 'ubuntu:22.04', mirrorDomain: 'http://mirrors.tools.huawei.com' },
  runtime: {
    devices: ['/dev/davinci0'],
    driverLibPath: '/usr/local/Ascend/driver/lib64',
    dcmiPath: '/usr/local/dcmi',
    versionInfoPath: '/usr/local/Ascend/driver/version.info',
    installInfoPath: '/etc/ascend_install.info',
    projectRoot: '/workspace/ascend-dev',
    workingDir: '/workspace/ascend-dev/examples',
  },
};

function makeManifest(jobId: string): Manifest {
  return {
    schemaVersion: 1,
    jobId,
    selection: config.release,
    torchVersion: '2.10.0',
    torchNpuVersion: '2.10.0.post4',
    createdAt: new Date().toISOString(),
    files: [
      { id: 'toolkit', path: 'build/packages/toolkit.run', url: 'https://x/t.run', expectedName: 'toolkit.run', sha256: 'a'.repeat(64), sizeBytes: 1 },
      { id: 'ops', path: 'build/packages/ops.run', url: 'https://x/o.run', expectedName: 'ops.run', sha256: 'b'.repeat(64), sizeBytes: 1 },
      { id: 'torch', path: 'build/packages/torch.whl', url: 'https://x/t.whl', expectedName: 'torch.whl', sha256: 'c'.repeat(64), sizeBytes: 1 },
      { id: 'torch_npu', path: 'build/packages/torch_npu.whl', url: 'https://x/tn.whl', expectedName: 'torch_npu.whl', sha256: 'd'.repeat(64), sizeBytes: 1 },
    ],
    generated: { dockerfile: 'a', entrypoint: 'b', compose: 'c' },
  };
}

function makeWorkflow() {
  const paths = makePaths();
  const observability = new Observability(paths);
  const snapshots = new SnapshotStore(paths.jobsDir);
  // 假下载服务：避免真实网络下载，直接返回清单与虚构归档路径。
  const fakeBundle = {
    async build(opts: { jobId: string }) {
      return {
        bundlePath: join(paths.cacheDir, 'bundles', opts.jobId, 'bundle.tar'),
        manifestPath: join(paths.cacheDir, 'bundles', opts.jobId, 'manifest.json'),
        manifest: makeManifest(opts.jobId),
        totalBytes: 1234,
      };
    },
  } as unknown as BundleService;
  const workflow = new Workflow({ snapshots, observability, dataPaths: paths, bundle: fakeBundle });
  return { paths, snapshots, workflow };
}

test('Workflow.create 生成含五阶段与生成文件的快照', () => {
  const { workflow, snapshots } = makeWorkflow();
  const snap = workflow.create(config);
  assert.equal(snap.status, 'ready');
  assert.equal(snap.stages.length, 5);
  assert.deepEqual(snap.stages.map((s) => s.status), ['pending', 'pending', 'pending', 'pending', 'pending']);
  assert.ok(snap.generated?.dockerfile);
  assert.ok(snap.generated?.compose);
  assert.equal(snap.resolved?.socModel, '910b');
  // 已持久化，可通过 get 读取。
  assert.equal(workflow.get(snap.id).id, snap.id);
  assert.equal(snapshots.load(snap.id)?.id, snap.id);
});

test('Workflow.get 对不存在任务抛出 NOT_FOUND', () => {
  const { workflow } = makeWorkflow();
  assert.throws(() => workflow.get('missing'), /任务不存在/);
});

test('Workflow.run 在 sync 阶段失败时保留 resolve/bundle 检查点', async () => {
  const { workflow } = makeWorkflow();
  const snap = workflow.create(config);
  const init: RunInitOptions = { auth: { method: 'agent' } };

  await workflow.run(snap.id, init);

  const after = workflow.get(snap.id);
  assert.equal(after.stages[0].status, 'succeeded'); // resolve
  assert.equal(after.stages[1].status, 'succeeded'); // bundle
  assert.equal(after.stages[2].status, 'failed'); // sync（无真实 SSH 服务）
  assert.ok(after.stages[2].errorCode);
  assert.equal(after.status, 'failed');
});