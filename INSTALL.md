# Sketch AI Imagen 0.2.11 离线安装说明

## 1. 解压与准备本地 marketplace

Codex CLI 的插件安装入口是 marketplace。ZIP 本身是可复制的插件根目录，解压后应能直接看到 `.codex-plugin/plugin.json`。下面的命令示例把它放进一个临时本地 marketplace；也可以把同一目录复制到你自己的受信任 marketplace。

```sh
unzip sketch-ai-imagen-codex-plugin-0.2.11.zip -d /path/to/marketplace/plugins/layout-guided-ai-imagen
mkdir -p /path/to/marketplace/.agents/plugins
```

在 `/path/to/marketplace/.agents/plugins/marketplace.json` 写入（`name` 可按需要改成唯一的本地 marketplace 名）：

```json
{
  "name": "sketch-ai-imagen-local",
  "interface": { "displayName": "Sketch AI Imagen" },
  "plugins": [
    {
      "name": "layout-guided-ai-imagen",
      "source": { "source": "local", "path": "./plugins/layout-guided-ai-imagen" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

然后运行：

```sh
codex plugin marketplace add /path/to/marketplace
codex plugin add layout-guided-ai-imagen@sketch-ai-imagen-local
```

`layout-guided-ai-imagen` 是兼容用的内部 plugin ID；这不改变公开 Skill 名称。

## 2. 重启与验证

重启 Codex Desktop/CLI，确认插件已启用：

```sh
codex plugin list --json
```

Skill 发现中应只有一个公开工作流 Skill：`sketch-ai-imagen`。在新任务中使用 `@sketch-ai-imagen`，先运行 `prepare --session <id> --brief-file <brief.json>` 或通过已挂载的 MCP 工具打开工作台；不要使用旧的 `layout-guided-ai-imagen-workflow` 名称，也不要在未经过用户 UI 选择和确认时生图。

可在不创建旧 session、不调用图像生成的前提下做本地准备 smoke：

```sh
node scripts/layout-guided-ai-imagen.mjs --help
node scripts/layout-guided-ai-imagen.mjs prepare --session fresh-sketch-check --brief-file /path/to/brief.json
```

## 3. 离线依赖边界

- ZIP 不含 `node_modules`，避免把开发缓存和平台特定二进制带入分发包。
- `web/vendor/fabric.js` 已随包提供；核心本地服务和画板要求 Node.js `>=18`，不需要联网下载运行时依赖。
- 若要运行完整 `npm test`、Playwright 浏览器 smoke 或开发工具，请在可联网环境按 `package-lock.json` 执行 `npm ci`，并按测试环境提供 Playwright 模块；这些不是离线插件核心运行的前置条件。
- 真实 Codex Desktop iframe、宿主模型自动回调和图像生成能力取决于目标宿主/工具权限，本包不伪造这些能力。

## 4. 回滚

先禁用或移除 `layout-guided-ai-imagen@sketch-ai-imagen-local`，再恢复安装前保留的 0.2.10 plugin cache/marketplace 副本并重启 Codex。回滚只替换插件代码，不删除已有 session、confirmation 或用户产物；不要使用递归删除整个 Codex 数据目录。

## 5. 兼容命名

公开调用名从 `layout-guided-ai-imagen-workflow` 迁移为 `sketch-ai-imagen`。bundle、MCP、session 和资源 URI 仍保留 `layout-guided-ai-imagen`，因此旧的内部 session 不需要迁移；不要同时暴露两个同描述的公开 Skill。
