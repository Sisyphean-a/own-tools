import { App, Modal, Notice, Setting } from 'obsidian';
import { createDiffView, type DiffLayout } from './diff-view';

// Rule: 记住本次会话选过的比较方式，后续确认沿用同一视图。
let preferredLayout: DiffLayout = 'inline';

const LAYOUTS: [DiffLayout, string][] = [['inline', '内联'], ['split', '左右']];

export class DiffModal extends Modal {
	/** Rule: 结果只能通过明确的按钮操作离开；误点背景、Esc 或关闭按钮都不再丢弃内容。 */
	private closeRequested = false;
	private blockDoc: Document | null = null;
	private viewEl: HTMLElement | null = null;
	private diffView: { destroy(): void } | null = null;
	private layout: DiffLayout = preferredLayout;
	private tabs = new Map<DiffLayout, HTMLButtonElement>();

	constructor(app: App, private original: string, private result: string, private apply: () => void, private release: () => void) {
		super(app);
	}

	/** Effect: 供应用、丢弃按钮和插件的取消流程显式关闭。 */
	dismiss(): void {
		this.closeRequested = true;
		this.close();
	}

	override close(): void {
		if (this.closeRequested) super.close();
	}

	onOpen(): void {
		this.modalEl.addClass('ai-rewrite-diff-modal');
		this.titleEl.setText(this.original ? '确认改写' : '确认生成内容');
		// Effect: 在捕获阶段拦住背景点击，避免宿主在弹窗容器上注册的关闭逻辑先执行。
		this.blockDoc = this.containerEl.ownerDocument;
		this.blockDoc.addEventListener('click', this.blockBackdropClick, { capture: true });
		const toolbar = this.contentEl.createDiv({ cls: 'ai-rewrite-diff-toolbar' });
		toolbar.createSpan({ cls: 'ai-rewrite-diff-hint', text: '确认前不会修改笔记；点“丢弃”将保留原文。' });
		const toggle = toolbar.createDiv({ cls: 'ai-rewrite-diff-toggle' });
		for (const [value, label] of LAYOUTS) {
			const tab = toggle.createEl('button', { cls: 'ai-rewrite-diff-tab', text: label, attr: { type: 'button' } });
			tab.toggleClass('is-active', value === this.layout);
			tab.addEventListener('click', () => this.setLayout(value));
			this.tabs.set(value, tab);
		}
		const labels = this.contentEl.createDiv({ cls: 'ai-rewrite-diff-labels' });
		labels.createSpan({ text: '原文' });
		labels.createSpan({ text: this.original ? 'AI 结果' : '生成内容' });
		this.viewEl = this.contentEl.createDiv({ cls: 'ai-rewrite-diff-view' });
		this.mount();
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('丢弃').onClick(() => this.dismiss()))
			.addButton((button) => button.setButtonText('复制结果').onClick(() => {
				void navigator.clipboard.writeText(this.result).then(() => new Notice('已复制结果'), () => new Notice('复制失败'));
			}))
			.addButton((button) => button.setButtonText(this.original ? '应用改写' : '插入内容').setCta().onClick(() => {
				try {
					this.apply();
					this.dismiss();
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '无法应用改写');
				}
			}));
	}

	onClose(): void {
		this.unmount();
		this.blockDoc?.removeEventListener('click', this.blockBackdropClick, { capture: true });
		this.blockDoc = null;
		this.viewEl = null;
		this.tabs.clear();
		this.contentEl.empty();
		this.release();
	}

	/** Effect: 切换视图时重建差异视图；选择结果在本次会话内保留。 */
	private setLayout(layout: DiffLayout): void {
		if (layout === this.layout) return;
		this.layout = layout;
		preferredLayout = layout;
		for (const [value, tab] of this.tabs) tab.toggleClass('is-active', value === layout);
		this.unmount();
		this.mount();
	}

	private mount(): void {
		if (!this.viewEl) return;
		const split = this.layout === 'split';
		this.viewEl.toggleClass('is-inline', !split);
		this.viewEl.toggleClass('is-split', split);
		// Effect: 只有左右视图用 CodeMirror 编辑器，借用 Obsidian 编辑器样式。
		this.viewEl.toggleClass('cm-s-obsidian', split);
		this.viewEl.toggleClass('mod-cm6', split);
		this.viewEl.toggleClass('markdown-source-view', split);
		this.modalEl.toggleClass('is-split', split);
		this.diffView = createDiffView(this.layout, this.viewEl, this.original, this.result);
	}

	private unmount(): void {
		this.diffView?.destroy();
		this.diffView = null;
		this.viewEl?.empty();
	}

	/** Effect: 点弹窗外部不关闭，也不把点击透传给编辑器或其他插件。 */
	private blockBackdropClick = (event: MouseEvent): void => {
		if (this.modalEl.contains(event.target as Node)) return;
		event.stopPropagation();
		event.preventDefault();
	};
}
