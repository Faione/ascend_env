// 任务快照持久化与日志存储的单元测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../src/server/storage/snapshots.js';
import type { JobSnapshot } from '../src/shared/types.js';

function makeSnapshot(id: string, createdAt: string): JobSnapshot {
  return {
    id,
    createdAt,
    status: 'ready',
    config: {
      release: { cannVersion: '9.1.0', socModel: '910', cpuArch: 'x86_64', pythonVersion: '3.10' },
      target: { host: '10.0.0.1', port: 22, username: 'root', remoteRoot: '/data/ascend' },
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
    },
    stages: [
      { name: 'resolve', status: 'pending' },
      { name: 'bundle', status: 'pending' },
      { name: 'sync', status: 'pending' },
      { name: 'image', status: 'pending' },
      { name: 'compose', status: 'pending' },
    ],
  };
}

test('SnapshotStore 原子保存、按 id 读取与按时间倒序列出', () => {
  const root = mkdtempSync(join(tmpdir(), 'ascend-snap-'));
  const store = new SnapshotStore(root);

  store.save(makeSnapshot('job-1', '2026-01-01T00:00:00.000Z'));
  store.save(makeSnapshot('job-2', '2026-01-02T00:00:00.000Z'));

  const loaded = store.load('job-1');
  assert.ok(loaded);
  assert.equal(loaded!.id, 'job-1');
  assert.equal(loaded!.stages.length, 5);

  // 不保存任何凭据：快照文件内不出现 SSH 密码相关字段。
  const raw = readFileSync(join(root, 'job-1', 'snapshot.json'), 'utf8');
  assert.ok(!/password|privateKey|passphrase/i.test(raw));

  const list = store.list();
  assert.deepEqual(list.map((s) => s.id), ['job-2', 'job-1']); // 倒序

  assert.equal(store.load('missing'), undefined);
});