// 输入校验与路径/文件名安全规则的单元测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ErrorCodes } from '../src/shared/errors.js';
import {
  isSafeAbsoluteLinuxPath,
  isSafeFileName,
  normalizeCpuArch,
  normalizeSocModel,
  validateImageConfig,
  validateJobConfig,
  validateReleaseSelection,
  validateRuntimeConfig,
  validateSshAuth,
  validateTargetConfig,
} from '../src/shared/validate.js';

test('validateReleaseSelection 接受合法版本组合', () => {
  const r = validateReleaseSelection({
    cannVersion: '9.1.0',
    socModel: '910B',
    cpuArch: 'amd64',
    pythonVersion: '3.10',
  });
  assert.equal(r.cannVersion, '9.1.0');
  assert.equal(r.socModel, '910b'); // 归一化为小写
  assert.equal(r.cpuArch, 'x86_64'); // amd64 归一化为 x86_64
  assert.equal(r.pythonVersion, '3.10');
});

test('validateReleaseSelection 拒绝非法 Toolkit 版本', () => {
  assert.throws(
    () => validateReleaseSelection({ cannVersion: 'abc', socModel: '910', cpuArch: 'x86_64', pythonVersion: '3.10' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.INVALID_INPUT,
  );
});

test('normalizeSocModel 拒绝空值', () => {
  assert.throws(() => normalizeSocModel(''), (e: unknown) => e instanceof AppError);
});

test('normalizeCpuArch 拒绝未知架构', () => {
  assert.throws(() => normalizeCpuArch('arm64'), (e: unknown) => e instanceof AppError);
});

test('validateTargetConfig 校验端口与远端路径', () => {
  const t = validateTargetConfig({
    host: '10.0.0.12',
    port: 22,
    username: 'root',
    remoteRoot: '/data/ascend',
  });
  assert.equal(t.port, 22);
  assert.equal(t.remoteRoot, '/data/ascend');
  // 端口缺省为 22。
  assert.equal(validateTargetConfig({ host: '10.0.0.12', username: 'root', remoteRoot: '/data' }).port, 22);
  // 非法端口与相对远端路径被拒绝。
  assert.throws(
    () => validateTargetConfig({ host: '10.0.0.12', port: 70000, username: 'root', remoteRoot: '/data' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.INVALID_INPUT,
  );
  assert.throws(
    () => validateTargetConfig({ host: '10.0.0.12', username: 'root', remoteRoot: 'data/ascend' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.INVALID_INPUT,
  );
});

test('validateTargetConfig 拒绝含 .. 的远端路径', () => {
  assert.throws(
    () => validateTargetConfig({ host: 'h', username: 'root', remoteRoot: '/data/../etc' }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.INVALID_INPUT,
  );
});

test('validateSshAuth 各认证方式', () => {
  assert.deepEqual(validateSshAuth({ method: 'agent' }), { method: 'agent' });
  assert.deepEqual(validateSshAuth({ method: 'password', password: 's3cret' }), {
    method: 'password',
    password: 's3cret',
  });
  assert.deepEqual(validateSshAuth({ method: 'privateKey', privateKey: 'key', passphrase: 'pp' }), {
    method: 'privateKey',
    privateKey: 'key',
    passphrase: 'pp',
  });
  assert.throws(() => validateSshAuth({ method: 'password' }), AppError);
  assert.throws(() => validateSshAuth({ method: 'privateKey' }), AppError);
  assert.throws(() => validateSshAuth({ method: 'token' }), AppError);
});

test('validateImageConfig 使用默认值并校验镜像站', () => {
  const i = validateImageConfig({});
  assert.equal(i.baseImage, 'ubuntu:22.04');
  assert.equal(i.mirrorDomain, 'http://mirrors.tools.huawei.com');
  assert.throws(() => validateImageConfig({ baseImage: 'bad image' }), AppError);
  assert.throws(() => validateImageConfig({ mirrorDomain: 'http://host/path' }), AppError);
});

test('validateRuntimeConfig 校验设备与绝对路径', () => {
  const r = validateRuntimeConfig({
    devices: ['/dev/davinci0'],
    driverLibPath: '/usr/local/Ascend/driver/lib64',
    dcmiPath: '/usr/local/dcmi',
    versionInfoPath: '/usr/local/Ascend/driver/version.info',
    installInfoPath: '/etc/ascend_install.info',
    projectRoot: '/workspace/ascend-dev',
    workingDir: '/workspace/ascend-dev/examples',
  });
  assert.deepEqual(r.devices, ['/dev/davinci0']);
  assert.throws(() => validateRuntimeConfig({ devices: [] }), AppError);
  assert.throws(
    () =>
      validateRuntimeConfig({
        devices: ['relative/path'],
        driverLibPath: '/a',
        dcmiPath: '/a',
        versionInfoPath: '/a',
        installInfoPath: '/a',
        projectRoot: '/a',
        workingDir: '/a',
      }),
    (e: unknown) => e instanceof AppError && e.code === ErrorCodes.INVALID_INPUT,
  );
});

test('validateJobConfig 组装完整配置', () => {
  const cfg = validateJobConfig({
    release: { cannVersion: '9.1.0', socModel: '910', cpuArch: 'x86_64', pythonVersion: '3.10' },
    target: { host: '10.0.0.12', port: 22, username: 'root', remoteRoot: '/data/ascend' },
    image: {},
    runtime: {
      devices: ['/dev/davinci0'],
      driverLibPath: '/usr/local/Ascend/driver/lib64',
      dcmiPath: '/usr/local/dcmi',
      versionInfoPath: '/usr/local/Ascend/driver/version.info',
      installInfoPath: '/etc/ascend_install.info',
      projectRoot: '/workspace/ascend-dev',
      workingDir: '/workspace/ascend-dev/examples',
    },
  });
  assert.equal(cfg.release.socModel, '910');
  assert.equal(cfg.image.baseImage, 'ubuntu:22.04');
});

test('isSafeAbsoluteLinuxPath 拒绝相对路径与逃逸', () => {
  assert.equal(isSafeAbsoluteLinuxPath('/a/b'), true);
  assert.equal(isSafeAbsoluteLinuxPath('a/b'), false);
  assert.equal(isSafeAbsoluteLinuxPath('/a/../b'), false);
  assert.equal(isSafeAbsoluteLinuxPath('/a/./b'), false);
});

test('isSafeFileName 规则', () => {
  assert.equal(isSafeFileName('toolkit.run'), true);
  assert.equal(isSafeFileName('../evil'), false);
  assert.equal(isSafeFileName('/abs'), false);
  assert.equal(isSafeFileName('..'), false);
});