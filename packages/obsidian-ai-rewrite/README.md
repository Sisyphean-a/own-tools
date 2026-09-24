# AI Selection Rewrite（Obsidian 插件）

在 Markdown 编辑器选中文字，右键选择 **使用AI改写**，或运行命令 **用 AI 改写选中文字**（可在 Obsidian 快捷键设置中绑定）。输入要求按 Enter 后对话框立即关闭，AI 输出会逐段写入原选区，选区在此期间高亮并锁定；Shift + Enter 换行，提交前 Esc 取消。生成中可通过命令 **取消正在进行的 AI 改写** 停止请求并恢复原文。成功后可使用撤销一次恢复原文；请求失败、截断或空响应会恢复原文。

## 本地安装与升级

在仓库根运行 `npm install && npm run build`。将 `packages/obsidian-ai-rewrite/` 下的 `main.js`、`manifest.json`、`styles.css` 复制到笔记库 `.obsidian/plugins/obsidian-ai-rewrite/`（升级时覆盖这三个文件），然后在 **设置 → 第三方插件** 中重新加载或重新启用插件。

首次安装默认使用 DeepSeek 的 `https://api.deepseek.com/chat/completions` 和 `deepseek-flash`，需要填写 DeepSeek API 密钥；也支持提供流式 SSE 与浏览器跨域访问的 OpenAI 兼容服务。**升级不会覆盖已保存的接口、模型和密钥**：如果旧版已经配置 OpenAI，请在设置中手动改成 DeepSeek 的接口、模型和密钥，以免将旧密钥发给另一家服务。默认不发起网络请求，只有提交指令才发送选中文本和指令（不发送笔记全文或文件名）。密钥保存在插件 `data.json` 中，**明文、可能被笔记库同步功能同步**；请勿分享该文件，泄漏时请轮换。

流式输出会暂时写入笔记，失败时自动恢复；外部同步或其他插件在此期间仍可能读取临时文本。锁定只拦截本编辑器中的普通编辑事务，无法阻止其他插件绕过 CodeMirror 过滤器、外部同步或磁盘编辑；若原文件已切走或选区遭外部修改而不能安全恢复，会提示人工检查。流式接口不兼容或跨域受阻时明确报错，不会假装流式输出。

## 开发

在仓库根运行 `npm test`、`npm run lint`、`npm run build`。未内置快捷键，避免与用户已有配置冲突。
