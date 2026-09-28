# 架构范围索引

- `workspace`：根 `package.json` 定义 `packages/*` 工作区，并将构建、检查和安装命令指向插件包；`scripts/install-obsidian-plugin.mjs` 负责将构建产物安装到已有 Obsidian 插件目录。新增包仍归同一个根 `.codestable/`。
- `package:obsidian-ai-rewrite`：[Obsidian AI 改写插件](packages/obsidian-ai-rewrite.md)，代码位置 `packages/obsidian-ai-rewrite/`；公开边界由 `manifest.json` 的插件 ID、`src/main.ts` 的 Obsidian 命令和编辑器菜单，以及 `src/ai.ts` 的外部 Chat Completions 请求构成。领域映射：[context:selection-rewrite](../requirements/contexts/selection-rewrite.md)。

先按代码路径定位包页；只有出现跨包契约时才建立 `architecture/shared/` 页面。
