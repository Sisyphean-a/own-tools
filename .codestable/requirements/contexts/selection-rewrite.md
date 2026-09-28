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

**上下文**：选区（或光标）前后自动附带的原文，只用于理解语境与保持连贯，受字符上限约束，不是改写对象。_避免_：选区内容、整篇笔记。

**链接正文**：指令中 http/https 链接读取到的网页文本，只作为回答、总结或核实的资料，受链接额度约束，可能被截断。_避免_：笔记内容、上下文。

**检索结果**：开启联网搜索时模型经 `web_search` 从 Tavily 获取的网页摘要，只作为回答或写作的依据，不写入笔记。_避免_：链接正文、上下文。

**过程记录**：思考内容和链接读取、联网检索等工具进度，只显示在预览卡片的过程区，随应用或丢弃一起消失。_避免_：待确认结果、笔记内容。

**文件正文**：模型经 `read_file` 读取到的本地文件文本，只作为回答或写作的资料，受读取范围和行数上限约束。_避免_：笔记正文、链接正文。

**应用**：用户确认后将待确认结果替换原选区，或插入到锁定的光标位置。_避免_：流式预览。

## 稳定规则

- 一次只处理一个改写目标；输入、流式生成和审阅期间结果只显示在临时预览中。只有用户选择应用才写回笔记；确认框只能通过“应用/丢弃”离开，误点外部、Esc 或关闭按钮都不丢弃待确认结果。依据：`src/main.ts` 的 `openPrompt`、`submit`，`src/diff-modal.ts` 的 `DiffModal`、`dismiss`，`src/selection-lock.ts` 的 `applyLocked`。
- 应用前核对会话关联的文件、目标范围和原文；目标变化时拒绝应用，不覆盖不相关修改。编辑器内的锁不保证阻止其他插件或外部文件修改。依据：`src/main.ts` 的 `valid`、`submit`，`src/selection-lock.ts` 的 `selectionGuard`、`applyLocked`。
- 提交时只发送用户指令、选中文字、选区（或光标）前后的受限上下文、主动粘贴的图片和指令中链接的网页正文（最多 3 个，共享 16000 字额度，多个链接均分并在段落边界截断），不发送整篇笔记或文件名；上下文两侧共享设置中的字符额度（默认合计 4000 字，可设为 0 关闭），超限时从远端截断并用 `…` 标注，紧邻选区的内容一定保留，一侧不足额度时剩余额度转给另一侧；`reasoning_content` 不显示、不写回，仅在带 tools 的请求中按接口要求回传给服务端。依据：`src/ai.ts` 的 `streamRewrite`、`src/context.ts` 的 `buildContext`、`src/settings.ts` 的 `contextLimit`、`src/prompt-modal.ts` 的 `pasteImages`、`src/web.ts` 的 `readWebPages`。
- 联网搜索默认关闭；开启并配置密钥后，模型自行决定是否调用 `web_search`（query/topic/timeRange），一次请求最多 10 轮；额度用尽后不再提供工具并要求模型基于已有资料收敛作答，不把额度问题当作错误抛给用户；工具轮的中间说明文字不进入待确认结果。依据：`src/ai.ts` 的 `streamRewrite`、`src/search.ts` 的 `WEB_SEARCH_TOOL`、`src/main.ts` 的 `submit`。
- 思考内容与工具进度只显示在预览卡片的过程区（可折叠，高度不超过窗口的一半）；无新内容超过 8 秒时显示等待提示，便于区分卡住和仍在响应；不写入笔记。依据：`src/selection-lock.ts` 的 `PreviewWidget`、`appendThinking`、`setProgress`、`quietHint`、`styles.css` 的 `.ai-rewrite-process-body`。
- 文件读取默认关闭且仅桌面版（Electron）可用；范围可为仅笔记库或任意本地路径，前者拒绝库外路径；只有只读能力，单次受行数与字符上限约束，截断时说明续读位置；不存在、目录、无权限、二进制、编码无法识别都明确失败，不静默跳过；读取到的文件内容会随请求发送给 AI 服务。依据：`src/files.ts` 的 `FILE_READ_TOOL`、`readLocalFile`、`src/ai.ts` 的 `runTool`、`src/settings.ts` 的 `fileReadScope`。
- 生成失败且选区仍有效时自动回到输入框并保留已输入的指令与图片，不要求用户重新输入；选区失效或文件变化时才直接取消并保留原文。依据：`src/main.ts` 的 `submit`、`showPrompt`、`src/prompt-modal.ts` 的 `PromptDraft`。
- 携带工具的请求会在载荷里附带当前时间（含星期与时区），时效判断以它为准，模型不得沿用训练数据里的日期。依据：`src/ai.ts` 的 `formatCurrentTime`、`TIME_PROMPT`。
- 流式请求超过 120 秒没有收到任何新数据会自动中断并明确提示，回到输入框保留指令与图片；思考与正文的高频流式更新用 `requestAnimationFrame` 按帧调度、至少间隔 80ms 合并成一次事务，预览卡片只更新已有文本节点的 `data`（不重建节点、不强制布局）；过程区内容始终是纯文本，不做 Markdown 解析或语法高亮，最多保留最近 12000 字。依据：`src/ai.ts` 的 `STALL_TIMEOUT_MS`、`stallPromise`、`src/main.ts` 的 `scheduleFlush`、`FLUSH_INTERVAL_MS`、`src/selection-lock.ts` 的 `SelectionPreview.flush`、`setTextData`、`MAX_THINKING_CHARS`。
- 搜索失败（网络错误、非 2xx、无效数据）时不生成回答，明确提示并保留原文；查询词会发送给配置的搜索服务，检索结果随请求交给模型。依据：`src/search.ts` 的 `searchWeb`、`src/settings.ts` 的 `searchEnabled`、`searchEndpoint`、`searchApiKey`。
- 链接不可达、返回非 2xx、不是网页文本或没有可读正文时明确失败并保留原文，不静默跳过后让模型编造网页内容。依据：`src/web.ts` 的 `readWebPages`、`src/main.ts` 的 `submit`。
