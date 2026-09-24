import { App, Modal, Setting } from 'obsidian';

export class PromptModal extends Modal {
	private input!: HTMLTextAreaElement;
	private submitted = false;

	constructor(app: App, private submitPrompt: (instruction: string) => void, private release: (submitted: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('改写选中文字');
		this.contentEl.createEl('p', { text: '选区已锁定。Enter 提交并关闭，Shift + Enter 换行，Esc 取消。' });
		this.input = this.contentEl.createEl('textarea', {
			cls: 'ai-rewrite-input',
			attr: { placeholder: '例如：改得更通顺一些', 'aria-label': '改写要求' },
		});
		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				this.submit();
			}
		});
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('改写').setCta().onClick(() => this.submit());
			});
		this.input.focus();
	}

	private submit(): void {
		const instruction = this.input.value.trim();
		if (!instruction || this.submitted) return;
		this.submitted = true;
		this.close();
		this.submitPrompt(instruction);
	}

	onClose(): void {
		this.contentEl.empty();
		this.release(this.submitted);
	}
}
