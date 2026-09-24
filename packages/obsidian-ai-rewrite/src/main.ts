import { EditorView } from '@codemirror/view';
import { Editor, MarkdownFileInfo, Notice, Plugin, TFile, editorInfoField } from 'obsidian';
import { streamRewrite, validateSettings } from './ai';
import { createSelectionExtension } from './editor-views';
import { PromptModal } from './prompt-modal';
import { appendLocked, clearLock, finishLocked, lockedRange, restoreLocked, setLock } from './selection-lock';
import { AiSettingTab, DEFAULT_SETTINGS, type AiSettings } from './settings';

interface RewriteSession {
	editor: Editor;
	view: EditorView;
	file: TFile;
	original: string;
	current: string;
	status: 'prompt' | 'stream';
	controller: AbortController | null;
}

export default class AiRewritePlugin extends Plugin {
	settings!: AiSettings;
	private views = new Map<Editor, EditorView>();
	private modal: PromptModal | null = null;
	private session: RewriteSession | null = null;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() as Partial<AiSettings> };
		this.registerEditorExtension(createSelectionExtension(this.views));
		this.addSettingTab(new AiSettingTab(this.app, this));
		this.addCommand({
			id: 'rewrite-selection',
			name: '用 AI 改写选中文字',
			editorCallback: (editor: Editor, info: MarkdownFileInfo) => this.openPrompt(editor, info),
		});
		this.addCommand({
			id: 'cancel-rewrite',
			name: '取消正在进行的 AI 改写',
			checkCallback: (checking) => {
				if (this.session?.status !== 'stream') return false;
				if (!checking) this.cancel(this.session, '改写已取消，原文已恢复');
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
			if (!editor.somethingSelected() || editor.listSelections().length !== 1) return;
			menu.addItem((item) => item.setTitle('使用AI改写').setIcon('sparkles')
				.onClick(() => this.openPrompt(editor, info)));
		}));
		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (this.session && (file !== this.session.file || !this.valid(this.session))) {
				this.cancel(this.session, '文件已切换，改写已取消');
			}
		}));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private valid(session: RewriteSession): boolean {
		return this.session === session && this.views.get(session.editor) === session.view &&
			session.view.state.field(editorInfoField, false)?.file === session.file;
	}

	private openPrompt(editor: Editor, info: MarkdownFileInfo): void {
		if (this.session) {
			new Notice('请先完成或取消当前改写');
			return;
		}
		const problem = validateSettings(this.settings);
		if (problem) {
			new Notice(problem);
			return;
		}
		const view = this.views.get(editor);
		const file = info.file;
		if (!file || !view || view.state.field(editorInfoField, false)?.file !== file ||
			view.state.field(lockedRange) || editor.listSelections().length !== 1 || !editor.somethingSelected()) {
			new Notice('请在 Markdown 编辑器中选中一段文字');
			return;
		}
		const from = editor.posToOffset(editor.getCursor('from'));
		const to = editor.posToOffset(editor.getCursor('to'));
		const original = editor.getSelection();
		if (from === to || view.state.doc.sliceString(from, to) !== original) {
			new Notice('选区已变化，请重新选中');
			return;
		}
		const session: RewriteSession = { editor, view, file, original, current: original, status: 'prompt', controller: null };
		view.dispatch({ effects: setLock.of({ from, to, busy: false }) });
		this.session = session;
		const modal = new PromptModal(this.app, (instruction) => {
			void this.submit(session, instruction);
		}, (submitted) => {
			if (this.modal === modal) this.modal = null;
			if (!submitted && this.session === session) this.cancel(session);
		});
		this.modal = modal;
		modal.open();
	}

	private async submit(session: RewriteSession, instruction: string): Promise<void> {
		if (!this.valid(session)) {
			this.cancel(session, '文件已变化，改写已取消');
			return;
		}
		session.status = 'stream';
		const range = session.view.state.field(lockedRange);
		if (!range) {
			this.cancel(session, '选区已失效，改写已取消');
			return;
		}
		session.view.dispatch({ effects: setLock.of({ ...range, busy: true }) });
		session.controller = new AbortController();
		let first = true;
		try {
			const result = await streamRewrite({ ...this.settings }, session.original, instruction, (delta) => {
				if (!this.valid(session)) throw new Error('文件已变化');
				session.current = appendLocked(session.view, session.current, delta, first);
				first = false;
			}, session.controller.signal);
			if (!this.valid(session)) throw new Error('文件已变化');
			finishLocked(session.view, session.current, session.original, result);
			this.session = null;
		} catch (error) {
			if (this.session !== session) return;
			this.cancel(session, error instanceof Error ? error.message : '改写失败，原文已恢复');
		}
	}

	private cancel(session: RewriteSession, message?: string): void {
		if (this.session !== session) return;
		this.session = null;
		session.controller?.abort();
		this.modal?.close();
		if (this.views.get(session.editor) === session.view &&
			session.view.state.field(editorInfoField, false)?.file === session.file) {
			try {
				if (session.current === session.original) session.view.dispatch({ effects: clearLock.of(undefined) });
				else restoreLocked(session.view, session.current, session.original);
			} catch {
				new Notice('选区被外部修改，无法自动恢复，请检查笔记内容');
				return;
			}
		} else {
			// Effect: 即使文件已切换，也要解除该编辑器上的旧锁；不向新文件写入原文。
			if (this.views.get(session.editor) === session.view) {
				session.view.dispatch({ effects: clearLock.of(undefined) });
			}
			if (session.current !== session.original) {
				new Notice('编辑器已离开原文件，无法自动恢复，请检查笔记内容');
				return;
			}
		}
		if (message) new Notice(message);
	}

	onunload(): void {
		if (this.session) this.cancel(this.session);
		this.views.clear();
	}
}
