import { EditorView } from '@codemirror/view';
import { Editor, FileSystemAdapter, MarkdownFileInfo, MarkdownView, Notice, Platform, Plugin, TFile, editorInfoField } from 'obsidian';
import { streamRewrite, validateSettings, type RewriteRuntime } from './ai';
import { STYLE_NEIGHBOR_LIMIT, buildContext, clipStyleSample, currentStyleSample, pickNeighborNotes, withHistory, withStyleSamples, type RewriteTurn } from './context';
import { DiffModal } from './diff-modal';
import { createSelectionExtension, findEditorView } from './editor-views';
import { PromptModal, type PromptDraft } from './prompt-modal';
import { SelectionPreview } from './selection-lock';
import { AiSettingTab, DEFAULT_SETTINGS, normalizeContextLimit, normalizeFileReadScope, normalizeStylePreset, normalizeStyleScope, type AiSettings } from './settings';
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
	/** 同一目标已应用的轮次，继续对话时随请求发送。 */
	turns: RewriteTurn[];
	status: 'prompt' | 'stream' | 'review';
}

/** 应用后仍可继续的范围：内容被用户改动或切换文件后失效。 */
interface Followup {
	file: TFile;
	from: number;
	to: number;
	text: string;
	turns: RewriteTurn[];
}

export default class AiRewritePlugin extends Plugin {
	settings!: AiSettings;
	private views = new Set<EditorView>();
	private prompt: PromptModal | null = null;
	private review: DiffModal | null = null;
	private session: RewriteSession | null = null;
	private followup: Followup | null = null;
	private controller: AbortController | null = null;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() as Partial<AiSettings> };
		this.settings.contextLimit = normalizeContextLimit(this.settings.contextLimit);
		this.settings.fileReadScope = normalizeFileReadScope(this.settings.fileReadScope);
		this.settings.stylePreset = normalizeStylePreset(this.settings.stylePreset);
		this.settings.styleScope = normalizeStyleScope(this.settings.styleScope);
		this.registerEditorExtension(createSelectionExtension(this.views));
		this.addSettingTab(new AiSettingTab(this.app, this));
		this.addCommand({
			id: 'rewrite-selection',
			name: '用 AI 改写或生成内容',
			editorCallback: (editor: Editor, info: MarkdownFileInfo) => this.openPrompt(editor, info),
		});
		this.addCommand({
			id: 'continue-rewrite',
			name: '继续修改上一次 AI 结果',
			editorCheckCallback: (checking, editor, info) => {
				if (!this.canContinue(editor, info)) return false;
				if (!checking) this.continueSession(editor, info);
				return true;
			},
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
			// Flow: 光标所在内容正好是上次应用的结果时，菜单里直接提供继续入口。
			if (this.canContinue(editor, info)) {
				menu.addItem((item) => item.setTitle('继续修改上一次 AI 结果').setIcon('history')
					.onClick(() => this.continueSession(editor, info)));
			}
		}));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.session && (file !== this.session.file || !this.valid(this.session))) {
				this.cancel(this.session);
			}
			if (this.followup && file !== this.followup.file) this.followup = null;
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
		// Rule: 开新会话即放弃上一次结果的继续入口，避免“继续”指向上一个目标。
		this.followup = null;
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
		const session: RewriteSession = { editor, view, file, info, original, selection, turns: [], status: 'prompt' };
		this.session = session;
		selection.setCancelHandler(() => this.cancel(session, '已取消生成'));
		this.showPrompt(session, null);
	}

	/** Flow: 打开输入框；draft 非空时恢复上次的指令与图片（生成失败后重试）。 */
	private showPrompt(session: RewriteSession, draft: PromptDraft | null): void {
		const modal = new PromptModal(this.app, !!session.original, draft, this.historyHint(session), (instruction, images) => {
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
			// Rule: 上下文在提交时从当前文档取，只用于理解语境，不扩大锁定与写回范围。
			const doc = session.view.state.doc.toString();
			// Failure: 风格样本读取失败也走统一失败路径，回到输入框重试，正文不变。
			const samples = await this.styleSamples(session, doc, range);
			const context = withStyleSamples(withHistory(buildContext(doc, range.from, range.to, this.settings.contextLimit), session.turns), samples);
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
				const applied = session.selection.apply(result);
				const turns = [...session.turns, { instruction, result }];
				this.followup = { file: session.file, from: applied.from, to: applied.to, text: result, turns };
				this.session = null;
				// Effect: 应用后给出可点击的继续入口，避免用户以为只能重新生成。
				this.notifyApplied(session);
			}, () => {
				if (this.review === modal) this.review = null;
				if (this.session === session) this.cancel(session);
			}, () => {
				// Flow: 继续修改不写回笔记，保留锁定目标和已应用历史，回到输入框并预填上一轮指令。
				this.review = null;
				if (this.session !== session || !this.valid(session)) return;
				session.status = 'prompt';
				this.showPrompt(session, { instruction, images });
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

	/** Flow: 显示已带上的历史轮数和上一条要求，让用户知道接着哪一轮说话。 */
	private historyHint(session: RewriteSession): string | null {
		const last = session.turns[session.turns.length - 1];
		if (!last) return null;
		const instruction = last.instruction.length > 80 ? `${last.instruction.slice(0, 80)}…` : last.instruction;
		return `已带上 ${session.turns.length} 轮修改；上一条要求：${instruction}`;
	}

	/** Effect: 应用后提示可点击继续；点击时重新核对目标内容，已被改动就不再锁定。 */
	private notifyApplied(session: RewriteSession): void {
		const notice = new Notice('已应用。点击这里继续修改，会带上刚才的对话。', 8000);
		// Rule: minAppVersion 为 1.1.0，只能用兼容旧版的 noticeEl；messageEl 需要 1.8.7。
		notice.noticeEl.addClass('ai-rewrite-continue-notice');
		notice.noticeEl.addEventListener('click', () => {
			notice.hide();
			if (this.canContinue(session.editor, session.info)) this.continueSession(session.editor, session.info);
			else new Notice('结果已改动或已切换文件，无法继续上一次修改');
		});
	}

	/** Rule: 只有目标内容仍与上次结果完全一致时才允许继续，用户已改动时不覆盖。 */
	private canContinue(editor: Editor, info: MarkdownFileInfo): boolean {
		const followup = this.followup;
		if (!followup || this.session || info.file !== followup.file) return false;
		return editor.getRange(editor.offsetToPos(followup.from), editor.offsetToPos(followup.to)) === followup.text;
	}

	private continueSession(editor: Editor, info: MarkdownFileInfo): void {
		const followup = this.followup;
		if (!followup) return;
		const view = findEditorView(this.views, editor, info, this.app.workspace.getActiveViewOfType(MarkdownView));
		const selection = view ? SelectionPreview.open(view, followup.from, followup.to, followup.text) : null;
		if (!view || !selection) {
			this.followup = null;
			new Notice('结果内容已变化，无法继续上一次修改');
			return;
		}
		this.followup = null;
		view.dispatch({ selection: { anchor: followup.from, head: followup.to }, scrollIntoView: true });
		const session: RewriteSession = {
			editor,
			view,
			file: followup.file,
			info,
			original: followup.text,
			selection,
			turns: followup.turns,
			status: 'prompt',
		};
		this.session = session;
		selection.setCancelHandler(() => this.cancel(session, '已取消生成'));
		this.showPrompt(session, null);
	}

	/** Flow: 收集风格样本：当前笔记去掉选区，加同目录最近几篇笔记的开头；用于让模型延续已有写法。 */
	private async styleSamples(session: RewriteSession, doc: string, range: { from: number; to: number }): Promise<string[]> {
		if (this.settings.styleScope === 'off') return [];
		const samples: string[] = [];
		const current = currentStyleSample(doc, range.from, range.to);
		if (current) samples.push(current);
		if (this.settings.styleScope !== 'note-folder') return samples;
		for (const file of pickNeighborNotes(this.app.vault.getMarkdownFiles(), session.file.path)) {
			const neighbor = clipStyleSample(await this.app.vault.cachedRead(file), STYLE_NEIGHBOR_LIMIT);
			if (neighbor) samples.push(neighbor);
		}
		return samples;
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
		this.followup = null;
		this.views.clear();
	}
}
