import { EditorView } from '@codemirror/view';
import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile, editorInfoField } from 'obsidian';
import { streamRewrite, validateSettings } from './ai';
import { buildContext } from './context';
import { DiffModal } from './diff-modal';
import { createSelectionExtension, findEditorView } from './editor-views';
import { PromptModal } from './prompt-modal';
import { applyLocked, clearLock, lockedRange, setLock } from './selection-lock';
import { AiSettingTab, DEFAULT_SETTINGS, normalizeContextLimit, type AiSettings } from './settings';

interface RewriteSession {
	editor: Editor;
	view: EditorView;
	file: TFile;
	info: MarkdownFileInfo;
	original: string;
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
				const orphaned = [...this.views].filter((view) => view.state.field(lockedRange, false));
				if (!orphaned.length) return false;
				if (!checking) {
					for (const view of orphaned) view.dispatch({ effects: clearLock.of(undefined) });
					if (orphaned.some((view) => view.state.field(lockedRange, false))) {
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
		if (view.state.field(lockedRange) || view.state.doc.sliceString(from, to) !== original) {
			new Notice('选区与当前笔记不一致，请重新选择后重试');
			return;
		}
		const session: RewriteSession = { editor, view, file, info, original, status: 'prompt' };
		view.dispatch({ effects: setLock.of({ from, to, phase: 'prompt', preview: '' }) });
		this.session = session;
		const modal = new PromptModal(this.app, !!original, (instruction, images) => {
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
		const range = session.view.state.field(lockedRange);
		if (!range) {
			this.cancel(session, '选区已失效，生成已取消');
			return;
		}
		session.view.dispatch({ effects: setLock.of({ ...range, phase: 'stream' }) });
		const controller = new AbortController();
		this.controller = controller;
		// Rule: 上下文在提交时从当前文档取，只用于理解语境，不扩大锁定与写回范围。
		const context = buildContext(session.view.state.doc.toString(), range.from, range.to, this.settings.contextLimit);
		let preview = '';
		try {
			const result = await streamRewrite({ ...this.settings }, session.original, context, instruction, images, (delta) => {
				if (!this.valid(session)) throw new Error('文件已变化');
				const current = session.view.state.field(lockedRange);
				if (!current || session.view.state.doc.sliceString(current.from, current.to) !== session.original) {
					throw new Error('原文已变化');
				}
				preview += delta;
				session.view.dispatch({ effects: setLock.of({ ...current, phase: 'stream', preview }) });
			}, controller.signal);
			if (!this.valid(session)) throw new Error('文件已变化');
			const current = session.view.state.field(lockedRange);
			if (!current || session.view.state.doc.sliceString(current.from, current.to) !== session.original) {
				throw new Error('原文已变化');
			}
			this.controller = null;
			session.status = 'review';
			session.view.dispatch({ effects: setLock.of({ ...current, phase: 'review', preview: result }) });
			const modal = new DiffModal(this.app, session.original, result, () => {
				if (!this.valid(session)) throw new Error('文件已变化，请重新生成');
				applyLocked(session.view, session.original, result);
				this.session = null;
			}, () => {
				if (this.review === modal) this.review = null;
				if (this.session === session) this.cancel(session);
			});
			this.review = modal;
			modal.open();
		} catch (error) {
			if (this.session !== session) return;
			this.cancel(session, error instanceof Error ? error.message : '生成失败，原文未改变');
		}
	}

	private cancel(session: RewriteSession, message?: string): void {
		if (this.session !== session) return;
		this.session = null;
		this.controller?.abort();
		this.controller = null;
		this.prompt?.close();
		this.review?.close();
		if ((this.views.has(session.view) || (session.editor as Editor & { cm?: EditorView }).cm === session.view) &&
			session.view.state.field(lockedRange, false) !== undefined) {
			session.view.dispatch({ effects: clearLock.of(undefined) });
		}
		if (message) new Notice(message);
	}

	onunload(): void {
		if (this.session) this.cancel(this.session);
		this.views.clear();
	}
}
