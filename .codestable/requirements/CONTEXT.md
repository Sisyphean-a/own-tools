---
scope: workspace
---

# 领域上下文

工作区以 `packages/*` 容纳多个工具包；目前只有一个实现包。包边界不自动成为领域边界，领域事实由下列上下文拥有。

## 作用域

- [context:selection-rewrite](contexts/selection-rewrite.md)：在 Obsidian 中对选中内容改写或在光标处生成，并决定是否应用结果。代码位置：`packages/obsidian-ai-rewrite/`。

工作区暂无跨上下文共用的业务术语或规则；不创建空的 `shared/` 页面。
