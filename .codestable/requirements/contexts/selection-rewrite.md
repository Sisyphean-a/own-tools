---
scope: context:selection-rewrite
code-paths:
  - packages/obsidian-ai-rewrite
---

# 选区改写领域上下文

用户在 Obsidian Markdown 编辑器中选定一段内容或放置光标，提交写作要求，审阅 AI 结果后自行决定是否写入笔记。

## 通用语言

**改写目标**：本次会话锁定的单个选区；选区为空时是当前光标的插入位置。_避免_：整篇笔记、多选区。

**待确认结果**：模型完成输出后供用户比较、复制或丢弃的文本，尚未成为笔记正文。_避免_：已应用内容。

**应用**：用户确认后将待确认结果替换原选区，或插入到锁定的光标位置。_避免_：流式预览。

## 稳定规则

- 一次只处理一个改写目标；输入、流式生成和审阅期间结果只显示在临时预览中。只有用户选择应用才写回笔记；关闭或丢弃保留原文。依据：`src/main.ts` 的 `openPrompt`、`submit`，`src/diff-modal.ts` 的 `DiffModal`，`src/selection-lock.ts` 的 `applyLocked`。
- 应用前核对会话关联的文件、目标范围和原文；目标变化时拒绝应用，不覆盖不相关修改。编辑器内的锁不保证阻止其他插件或外部文件修改。依据：`src/main.ts` 的 `valid`、`submit`，`src/selection-lock.ts` 的 `selectionGuard`、`applyLocked`。
- 提交时只发送用户指令、选中文字和主动粘贴的图片，不发送整篇笔记或文件名；`reasoning_content` 不作为结果写回。依据：`src/ai.ts` 的 `streamRewrite`、`src/prompt-modal.ts` 的 `pasteImages`。
