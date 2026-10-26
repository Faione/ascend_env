// 生成文件汇总：把静态 Dockerfile/entrypoint 模板与 Compose 渲染合并为可供预览与归档的 GeneratedFiles。
// 镜像/容器名以 jobId 派生，保证任务间隔离，不与历史镜像/容器串扰。

import type { GeneratedFiles, JobConfig } from '../shared/types.js';
import { renderComposeYaml } from './compose/index.js';
import { renderDockerfile, renderEntrypoint } from './image/index.js';

export const SERVICE_NAME = 'ascend';

export function imageTag(jobId: string): string {
  return `ascend-dev:${jobId}`;
}

export function containerName(jobId: string): string {
  return `ascend-run-${jobId}`;
}

/** Compose 项目名，用于 `docker compose -p`，避免不同任务在同一目录下冲突。 */
export function projectName(jobId: string): string {
  return `ascend-${jobId}`;
}

/** 依据任务配置生成全部构建文件。 */
export function renderGenerated(jobId: string, config: JobConfig): GeneratedFiles {
  return {
    dockerfile: renderDockerfile(),
    entrypoint: renderEntrypoint(),
    compose: renderComposeYaml({
      serviceName: SERVICE_NAME,
      containerName: containerName(jobId),
      imageTag: imageTag(jobId),
      runtime: config.runtime,
    }),
  };
}