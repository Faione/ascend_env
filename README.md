# Ascend 环境部署工具

本仓库用于开发一个静态 HTML 控制界面，完成 Ascend CANN 安装包准备、上传、镜像构建和容器启动。浏览器页面负责配置与展示；本地辅助服务负责文件下载、SSH/SFTP 和远端命令执行。交互终端通过辅助服务连接目标服务器。

当前状态：首版实现已完成——包括版本目录解析、打包下载、SSH/SFTP 上传与构建、镜像构建、Compose 容器启动、交互终端，以及原生 TypeScript + xterm.js 的静态前端。

## 快速开始

```bash
npm install
npm run build       # 编译服务并生成前端静态资源（dist/web）
npm start           # 启动本地服务（默认 http://127.0.0.1:6750）
```

然后浏览器打开 `http://127.0.0.1:6750` 配置版本、目标服务器与运行参数，创建任务并运行。服务只监听回环地址，SSH 凭据仅在服务端进程内存中短暂存在，不写入任务快照或日志。完整 CLI 说明见 [docs/cli.md](docs/cli.md)。

## 测试

```bash
npm test            # 31 个单元测试，覆盖校验、目录解析、归档、Compose 渲染、存储、可观测性、编排状态机
npm run typecheck   # 类型检查
```

由于无真实 NPU 主机，端到端部署（设备挂载、镜像构建、交互终端）仅验证到模拟集成阶段，未宣称端到端通过。

## 文档

- [Agent 开发约束与必读顺序](AGENTS.md)
- [开发计划](docs/development-plan.md)
- [软件架构与模块职责](docs/architecture.md)
- [分级日志与可观测性设计](docs/logging-design.md)
- [CLI 说明要求](docs/cli.md)
- [现有环境脚本](reference/environment/)

`reference/environment/` 是从现有环境目录复制的参考基线，保留原始版本用于对照；应用运行使用的可生成模板位于 `templates/`。
