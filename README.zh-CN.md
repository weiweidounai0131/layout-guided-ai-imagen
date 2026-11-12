# Sketch AI Imagen

[English](README.md) | **简体中文**

这是一个面向 Codex 的本地、可控版式工作流插件。面向用户分发的公开 workflow Skill 名称是 `sketch-ai-imagen`，调用方式是 `@sketch-ai-imagen`。

名称边界是刻意保留的：

- 公开 Skill：`sketch-ai-imagen`，只提供工作流说明和调用入口。
- 插件 bundle / marketplace plugin name：`layout-guided-ai-imagen`。
- MCP server、`ui://layout-guided-ai-imagen/...` 资源、session schema 和内部数据根：继续使用 `layout-guided-ai-imagen`，用于兼容已有安装和会话。

不要把旧的 `layout-guided-ai-imagen-workflow` 作为第二个 Skill 安装；已有调用应迁移为 `@sketch-ai-imagen`。

## 安装

推荐使用发布包 `sketch-ai-imagen-codex-plugin-0.2.11.zip`，详见包内 [INSTALL.md](INSTALL.md)。Codex CLI 当前通过本地 marketplace 安装插件，而不是直接把 ZIP 当作 plugin selector：先解压，再将解压目录作为 marketplace 中 `plugins/layout-guided-ai-imagen` 的内容，最后运行 `codex plugin marketplace add` 和 `codex plugin add layout-guided-ai-imagen@<marketplace>`。

## 运行边界

本地画板先验证 `PosterBrief`、生成候选并等待用户在工作台中选择和确认；没有真实的用户 UI 确认时，不会进入图像生成。版式候选由产品自有目录和本地确定性评分提供，不声称是 OpenAI 的完整官方版式清单，也不把 schematic 缩略图当作实际画布缩略图。

核心运行文件包含离线 Fabric vendor，Node 运行时要求 `>=18`。发布 ZIP 不含 `node_modules`、开发证据大图、session/output 或生成图；完整开发测试需按 `package-lock.json` 安装依赖。真实 Codex Desktop iframe、宿主模型回调和真实生图仍按验证报告标记为未验证，不应由本地协议 smoke 外推。
