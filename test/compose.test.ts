// Compose YAML 渲染单元测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderComposeYaml } from '../src/server/compose/index.js';

const runtime = {
  devices: ['/dev/davinci0', '/dev/davinci_manager'],
  driverLibPath: '/usr/local/Ascend/driver/lib64',
  dcmiPath: '/usr/local/dcmi',
  versionInfoPath: '/usr/local/Ascend/driver/version.info',
  installInfoPath: '/etc/ascend_install.info',
  projectRoot: '/workspace/ascend-dev',
  workingDir: '/workspace/ascend-dev/examples',
};

test('renderComposeYaml 注入镜像标签、设备与只读卷', () => {
  const yaml = renderComposeYaml({
    serviceName: 'ascend',
    containerName: 'ascend-run-job-1',
    imageTag: 'ascend-dev:job-1',
    runtime,
  });
  assert.match(yaml, /image: ascend-dev:job-1/);
  assert.match(yaml, /container_name: ascend-run-job-1/);
  assert.match(yaml, /\/dev\/davinci0:\/dev\/davinci0/);
  assert.match(yaml, /\/dev\/davinci_manager:\/dev\/davinci_manager/);
  assert.match(yaml, /read_only: true/);
  assert.match(yaml, /pull_policy: never/);
  assert.match(yaml, /sleep/);
  // working_dir 反映到容器工作目录。
  assert.match(yaml, /working_dir: \/workspace\/ascend-dev\/examples/);
});