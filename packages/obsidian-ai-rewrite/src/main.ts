import { EditorView } from '@codemirror/view';
import { Editor, FileSystemAdapter, MarkdownFileInfo, MarkdownView, Notice, Platform, Plugin, TFile, editorInfoField } from 'obsidian';
import { streamRewrite, validateSettings, type RewriteRuntime } from './ai';
import { buildContext } from './context';
import { DiffModal } from './diff-modal';
import { createSelectionExtension, findEditorView } from './editor-views';
import { PromptModal, type PromptDraft } from './prompt-modal';
import { SelectionPreview } from './selection-lock';
import { AiSettingTab, DEFAULT_SETTINGS, normalizeContextLimit, normalizeFileReadScope, type AiSettings } from './settings';
import { extractUrls, readWebPages } from './web';

/** Rule: 流式更新按帧调度，但至少间隔该毫秒数才真正合并一次，避免每帧都触发编辑器重排。 */
const FLUSH_INTERVAL_MS = 80;

interface RewriteSession {
	editor: Editor;
	view: EditorView;
	file: TFile;
	info: MarkdownFileInfo;
	original: string;
	selection: SelectionPreview;
	status: 'prompt' | 'stream' | 'review';
}

export default class AiRewritePlugin extends Plugin {
	settings!: AiSettings;
	private views = new Set<EditorView>();
	private prompt: PromptModal | null = null;
	private review: DiffModal | null = null;
	private session: RewriteSession | null = null;
	private controller: AbortController | null = null;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() as Partial<AiSettings> };
		this.settings.contextLimit = normalizeContextLimit(this.settings.contextLimit);
		this.settings.fileReadScope = normalizeFileReadScope(this.settings.fileReadScope);
		this.registerEditorExtension(createSelectionExtension(this.views));
		this.addSettingTab(new AiSettingTab(this.app, this));
		this.addCommand({
			id: 'rewrite-selection',
			name: '用 AI 改写或生成内容',
			editorCallback: (editor: Editor, info: MarkdownFileInfo) => this.openPrompt(editor, info),
		});
		this.addCommand({
			id: 'cancel-rewrite',
			name: '取消正在进行的 AI 改写',
			checkCallback: (checking) => {
				if (this.session) {
					if (this.session.status === 'prompt') return false;
					if (!checking) this.cancel(this.session);
					return true;
				}
				const orphaned = [...this.views].filter((view) => SelectionPreview.isLocked(view));
				if (!orphaned.length) return false;
				if (!checking) {
					for (const view of orphaned) SelectionPreview.release(view);
					if (orphaned.some((view) => SelectionPreview.isLocked(view))) {
						new Notice('预览未能清除，请重启 Obsidian 并重新打开笔记');
					}
				}
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
			menu.addItem((item) => item.setTitle('使用AI改写').setIcon('sparkles')
				.onClick(() => this.openPrompt(editor, info)));
		}));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.session && (file !== this.session.file || !this.valid(this.session))) {
				this.cancel(this.session);
			}
		}));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private valid(session: RewriteSession): boolean {
		const cm = (session.editor as Editor & { cm?: EditorView }).cm;
		const file = session.view.state.field(editorInfoField, false)?.file;
		return this.session === session && (this.views.has(session.view) || cm === session.view) &&
			(file === session.file || (!file && session.info.file === session.file && session.view.dom.isConnected));
	}

	private openPrompt(editor: Editor, info: MarkdownFileInfo): void {
		if (this.session) {
			new Notice('请先完成或取消当前生成');
			return;
		}
		const problem = validateSettings(this.settings);
		if (problem) {
			new Notice(problem);
			return;
		}
		const file = info.file;
		const view = findEditorView(this.views, editor, info, this.app.workspace.getActiveViewOfType(MarkdownView));
		if (!file || !view) {
			new Notice('无法定位当前 Markdown 编辑器，请切换到编辑模式重试');
			return;
		}
		if (editor.listSelections().length !== 1) {
			new Notice('暂不支持多个选区，请只保留一个光标或选区');
			return;
		}
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const original = editor.getRange(editor.getCursor('from'), editor.getCursor('to'));
		const selection = SelectionPreview.open(view, from, to, original);
		if (!selection) {
			new Notice('选区与当前笔记不一致，请重新选择后重试');
			return;
		}
		const session: RewriteSession = { editor, view, file, info, original, selection, status: 'prompt' };
		this.session = session;
		this.showPrompt(session, null);
	}

	/** Flow: 打开输入框；draft 非空时恢复上次的指令与图片（生成失败后重试）。 */
	private showPrompt(session: RewriteSession, draft: PromptDraft | null): void {
		const modal = new PromptModal(this.app, !!session.original, draft, (instruction, images) => {
			void this.submit(session, instruction, images);
		}, (submitted) => {
			if (this.prompt === modal) this.prompt = null;
			if (!submitted && this.session === session) this.cancel(session);
		});
		this.prompt = modal;
		modal.open();
	}

	private async submit(session: RewriteSession, instruction: string, images: string[]): Promise<void> {
		if (!this.valid(session)) {
			this.cancel(session, '文件已变化，生成已取消');
			return;
		}
		session.status = 'stream';
		const range = session.selection.start();
		if (!range) {
			this.cancel(session, '选区已失效，生成已取消');
			return;
		}
		const controller = new AbortController();
		this.controller = controller;
		// Rule: 上下文在提交时从当前文档取，只用于理解语境，不扩大锁定与写回范围。
		const context = buildContext(session.view.state.doc.toString(), range.from, range.to, this.settings.contextLimit);
		let flushFrame: number | null = null;
		let lastFlushAt = 0;
		// Effect: 用 requestAnimationFrame 按帧调度（后台标签页不空转），并保证最小间隔；思考与正文合并成一次事务。
		const flush = (): void => {
			if (this.valid(session)) session.selection.flush();
		};
		const scheduleFlush = (): void => {
			if (flushFrame !== null) return;
			flushFrame = window.requestAnimationFrame(() => {
				flushFrame = null;
				const now = Date.now();
				if (now - lastFlushAt < FLUSH_INTERVAL_MS) {
					scheduleFlush();
					return;
				}
				lastFlushAt = now;
				flush();
			});
		};
		const pushThinking = (text: string) => {
			if (!this.valid(session)) throw new Error('文件已变化');
			session.selection.appendReasoning(text);
			scheduleFlush();
		};
		const pushProgress = (id: string, text: string, done: boolean) => {
			if (this.valid(session)) session.selection.progress(id, text, done);
		};
		try {
			// Effect: 链接与检索进度写进预览卡片的过程面板；失败由外层统一取消并提示，原文不变。
			const urls = extractUrls(instruction);
			if (urls.length) pushProgress('links', `正在读取 ${urls.length} 个链接…`, false);
			const pages = await readWebPages(urls, controller.signal);
			if (urls.length) pushProgress('links', `已读取 ${urls.length} 个链接`, true);
			const result = await streamRewrite({ ...this.settings }, session.original, context, instruction, images, pages, {
				delta: (delta) => {
					if (!this.valid(session)) throw new Error('文件已变化');
					session.selection.appendText(delta);
					scheduleFlush();
				},
				// Effect: 工具轮的说明文字不是最终结果，丢弃后只保留最终回答。
				reset: () => {
					if (this.valid(session)) session.selection.reset();
				},
				reasoning: pushThinking,
				progress: pushProgress,
			}, controller.signal, this.readRuntime());
			if (!this.valid(session)) throw new Error('文件已变化');
			session.selection.complete(result);
			this.controller = null;
			session.status = 'review';
			const modal = new DiffModal(this.app, session.original, result, () => {
				if (!this.valid(session)) throw new Error('文件已变化，请重新生成');
				session.selection.apply(result);
				this.session = null;
			}, () => {
				if (this.review === modal) this.review = null;
				if (this.session === session) this.cancel(session);
			});
			this.review = modal;
			modal.open();
		} catch (error) {
			if (this.session !== session) return;
			const message = error instanceof Error ? error.message : '生成失败，原文未改变';
			if (this.valid(session) && session.selection.retry()) {
				// Effect: 生成失败且选区仍有效时回到输入框，保留已输入的指令与图片。
				this.controller?.abort();
				this.controller = null;
				session.status = 'prompt';
				new Notice(message);
				this.showPrompt(session, { instruction, images });
				return;
			}
			this.cancel(session, message);
		} finally {
			if (flushFrame !== null) window.cancelAnimationFrame(flushFrame);
		}
	}

	/** Flow: 组合文件读取需要的运行环境；手机版或非文件系统适配器时不可用。 */
	private readRuntime(): RewriteRuntime {
		const adapter = this.app.vault.adapter;
		const filesystem = adapter instanceof FileSystemAdapter;
		return {
			desktop: Platform.isDesktopApp && filesystem,
			vaultRoot: filesystem ? adapter.getBasePath() : '',
		};
	}

	private cancel(session: RewriteSession, message?: string): void {
		if (this.session !== session) return;
		this.session = null;
		this.controller?.abort();
		this.controller = null;
		this.prompt?.close();
		this.review?.dismiss();
		if (this.views.has(session.view) || (session.editor as Editor & { cm?: EditorView }).cm === session.view) {
			SelectionPreview.release(session.view);
		}
		if (message) new Notice(message);
	}

	onunload(): void {
		if (this.session) this.cancel(this.session);
		this.views.clear();
	}
}
