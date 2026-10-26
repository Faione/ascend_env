# Ascend 环境部署工具

本仓库用于开发一个静态 HTML 控制界面，完成 Ascend CANN 安装包准备、上传、镜像构建和容器启动。浏览器页面负责配置与展示；本地辅助服务负责文件下载、SSH/SFTP 和远端命令执行。交互终端通过辅助服务连接目标服务器。

当前阶段已完成需求分析和仓库初始化，尚未实现部署功能。

- [开发计划](docs/development-plan.md)
- [软件架构与模块职责](docs/architecture.md)
- [现有环境脚本](reference/environment/)

`reference/environment/` 是从现有环境目录复制的参考基线，后续实现应保留原始版本用于对照，并在应用目录中维护可生成的 Dockerfile 和 Compose 模板。
