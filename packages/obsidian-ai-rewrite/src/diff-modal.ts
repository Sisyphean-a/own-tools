import { App, Modal, Notice, Setting } from 'obsidian';
import { diffWords } from './diff';

export class DiffModal extends Modal {
	/** Rule: 结果只能通过明确的按钮操作离开；误点背景、Esc 或关闭按钮都不再丢弃内容。 */
	private closeRequested = false;
	private blockDoc: Document | null = null;

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
		this.contentEl.createEl('p', { text: '确认前不会修改笔记；点“丢弃”将保留原文。' });
		// Effect: 在捕获阶段拦住背景点击，避免宿主在弹窗容器上注册的关闭逻辑先执行。
		this.blockDoc = this.containerEl.ownerDocument;
		this.blockDoc.addEventListener('click', this.blockBackdropClick, { capture: true });
		const preview = this.contentEl.createDiv({ cls: 'ai-rewrite-diff' });
		const segments = diffWords(this.original, this.result);
		if (segments) {
			for (const segment of segments) {
				preview.createSpan({ cls: `ai-rewrite-diff-${segment.type}`, text: segment.text });
			}
		} else {
			preview.createDiv({ cls: 'ai-rewrite-diff-label', text: '原文（内容过长，显示并排对比）' });
			preview.createDiv({ text: this.original });
			preview.createDiv({ cls: 'ai-rewrite-diff-label', text: 'AI 生成' });
			preview.createDiv({ text: this.result });
		}
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
		this.blockDoc?.removeEventListener('click', this.blockBackdropClick, { capture: true });
		this.blockDoc = null;
		this.contentEl.empty();
		this.release();
	}

	/** Effect: 点弹窗外部不关闭，也不把点击透传给编辑器或其他插件。 */
	private blockBackdropClick = (event: MouseEvent): void => {
		if (this.modalEl.contains(event.target as Node)) return;
		event.stopPropagation();
		event.preventDefault();
	};
}
