# package:obsidian-ai-rewrite

代码：`packages/obsidian-ai-rewrite/`。面向 Obsidian Markdown 编辑器的插件，包内负责指令输入、图片读取、AI 流式请求、临时编辑器预览、差异确认和最终写回。业务词与约束由 [context:selection-rewrite](../../requirements/contexts/selection-rewrite.md) 定义。

## 边界与路径

- `manifest.json` 提供插件身份；`src/main.ts` 的 `AiRewritePlugin.onload` 注册命令、编辑器右键菜单、设置及文件切换处理，并管理单次会话从输入到确认的生命周期。
- `src/editor-views.ts` 关联 Obsidian 编辑器与 CodeMirror 视图；`src/selection-lock.ts` 的 `selectionGuard`、`lockedRange`、`applyLocked` 负责范围保护、预览和单事务写回；目标内容的保护规则见领域上下文。
- `src/prompt-modal.ts` 与 `src/images.ts` 接收指令和主动粘贴的图片；`src/context.ts` 的 `buildContext` 按字符额度截取选区（或光标）前后的原文；`src/ai.ts` 的 `streamRewrite` 经浏览器 `fetch` 请求配置的 Chat Completions 兼容接口并解析 SSE；`src/settings.ts` 保存接口、模型、上下文上限和密钥（插件 `data.json` 为明文）。
- `src/diff.ts` 与 `src/diff-modal.ts` 展示词级差异及过长内容的并排对比，提供应用、复制与丢弃入口；显示结果不等于写回正文。
- 根 `scripts/install-obsidian-plugin.mjs` 安装包的 `main.js`、`manifest.json`、`styles.css`：先校验目标插件 ID 和版本、备份旧文件到根 `.tmp/`，失败时恢复已替换文件；不修改目标 `data.json`。
