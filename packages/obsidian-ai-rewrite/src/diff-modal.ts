import { App, Modal, Notice, Setting } from 'obsidian';
import { diffWords } from './diff';

export class DiffModal extends Modal {
	constructor(app: App, private original: string, private result: string, private apply: () => void, private release: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('ai-rewrite-diff-modal');
		this.titleEl.setText(this.original ? '确认改写' : '确认生成内容');
		this.contentEl.createEl('p', { text: '确认前不会修改笔记；关闭或丢弃将保留原文。' });
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
			.addButton((button) => button.setButtonText('丢弃').onClick(() => this.close()))
			.addButton((button) => button.setButtonText('复制结果').onClick(() => {
				void navigator.clipboard.writeText(this.result).then(() => new Notice('已复制结果'), () => new Notice('复制失败'));
			}))
			.addButton((button) => button.setButtonText(this.original ? '应用改写' : '插入内容').setCta().onClick(() => {
				try {
					this.apply();
					this.close();
				} catch (error) {
					new Notice(error instanceof Error ? error.message : '无法应用改写');
				}
			}));
	}

	onClose(): void {
		this.contentEl.empty();
		this.release();
	}
}
