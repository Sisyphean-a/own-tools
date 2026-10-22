import { App, Modal, Notice, Setting } from 'obsidian';
import { MAX_REQUEST_BYTES, readPastedImage } from './images';

/** 生成失败后重新打开输入框时恢复的内容。 */
export interface PromptDraft {
	instruction: string;
	images: string[];
}

export class PromptModal extends Modal {
	private input!: HTMLTextAreaElement;
	private imageList!: HTMLElement;
	private images: string[] = [];
	private pendingImages = 0;
	private submitButton: HTMLButtonElement | null = null;
	private imageStatus!: HTMLElement;
	private validation!: HTMLElement;
	private submitted = false;
	private disposed = false;

	constructor(
		app: App,
		private hasSelection: boolean,
		private initial: PromptDraft | null,
		private hint: string | null,
		private submitPrompt: (instruction: string, images: string[]) => void,
		private release: (submitted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.hasSelection ? '改写选中文字' : '在光标处生成内容');
		this.contentEl.createEl('p', { text: '输入要求，可粘贴图片作为参考；指令中的链接会先读取网页正文，开启联网搜索后模型可自行检索网页。Enter 提交，Shift + Enter 换行。' });
		// Effect: 继续修改时显示上一轮要求，让用户知道自己接着哪一轮说话。
		if (this.hint) this.contentEl.createEl('p', { cls: 'ai-rewrite-history-hint', text: this.hint });
		this.input = this.contentEl.createEl('textarea', {
			cls: 'ai-rewrite-input',
			attr: { placeholder: this.hasSelection ? '例如：改得更通顺一些' : '例如：总结这个链接 https://example.com/article', 'aria-label': '写作要求' },
		});
		this.validation = this.contentEl.createDiv({ cls: 'ai-rewrite-input-error', attr: { role: 'alert' } });
		this.validation.hidden = true;
		this.input.addEventListener('input', () => this.clearValidation());
		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				this.submit();
			}
		});
		this.input.addEventListener('paste', (event) => { void this.pasteImages(event); });
		this.imageList = this.contentEl.createDiv({ cls: 'ai-rewrite-images' });
		this.imageStatus = this.contentEl.createDiv({ cls: 'ai-rewrite-image-status', attr: { role: 'status', 'aria-live': 'polite' } });
		this.imageStatus.hidden = true;
		// Effect: 重开时恢复上次的指令和图片，失败后不用重新输入。
		this.input.value = this.initial?.instruction ?? '';
		this.images = [...(this.initial?.images ?? [])];
		this.renderImages();
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('取消').onClick(() => this.close()))
			.addButton((button) => {
				this.submitButton = button.buttonEl;
				button.setButtonText(this.hasSelection ? '生成改写' : '生成内容').setCta().onClick(() => this.submit());
			});
		this.updateImageStatus();
		this.input.focus();
	}

	private async pasteImages(event: ClipboardEvent): Promise<void> {
		const clipboard = event.clipboardData;
		if (!clipboard) return;
		const files = Array.from(clipboard.items).filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
			.map((item) => item.getAsFile()).filter((file): file is File => !!file);
		if (!files.length) return;
		event.preventDefault();
		const pastedText = clipboard.getData('text/plain');
		if (pastedText) this.input.setRangeText(pastedText, this.input.selectionStart, this.input.selectionEnd, 'end');
		this.pendingImages++;
		this.updateImageStatus();
		try {
			for (const file of files) {
				const url = await readPastedImage(file);
				if (this.disposed) return;
				if (this.images.reduce((size, image) => size + image.length, url.length) > MAX_REQUEST_BYTES) {
					throw new Error('图片超过 48 MiB 请求限制，请减少图片');
				}
				this.images.push(url);
				this.renderImages();
			}
		} catch (error) {
			if (!this.disposed) new Notice(error instanceof Error ? error.message : '图片读取失败');
		} finally {
			this.pendingImages--;
			this.updateImageStatus();
		}
	}

	private updateImageStatus(): void {
		if (this.disposed || !this.imageStatus) return;
		const pending = this.pendingImages > 0;
		if (this.submitButton) this.submitButton.disabled = pending || this.submitted;
		this.imageStatus.hidden = !pending;
		this.imageStatus.textContent = pending ? '正在读取图片，请稍候…' : '';
	}

	private clearValidation(): void {
		if (!this.validation) return;
		this.validation.hidden = true;
		this.validation.textContent = '';
		this.input.removeAttribute('aria-invalid');
	}

	private renderImages(): void {
		this.imageList.empty();
		this.images.forEach((url, index) => {
			const item = this.imageList.createDiv({ cls: 'ai-rewrite-image' });
			item.createEl('img', { attr: { src: url, alt: `待发送图片 ${index + 1}` } });
			item.createEl('button', { text: '移除', attr: { type: 'button', 'aria-label': `移除图片 ${index + 1}` } })
				.addEventListener('click', () => {
					this.images.splice(index, 1);
					this.renderImages();
				});
		});
	}

	private submit(): void {
		const instruction = this.input.value.trim();
		if (this.submitted) return;
		if (!instruction) {
			this.validation.hidden = false;
			this.validation.textContent = '请输入写作要求';
			this.input.setAttribute('aria-invalid', 'true');
			this.input.focus();
			return;
		}
		if (this.pendingImages) {
			new Notice('图片仍在读取，请稍候');
			return;
		}
		this.clearValidation();
		this.submitted = true;
		if (this.submitButton) this.submitButton.disabled = true;
		const images = [...this.images];
		this.close();
		this.submitPrompt(instruction, images);
	}

	onClose(): void {
		this.disposed = true;
		this.submitButton = null;
		this.images = [];
		this.contentEl.empty();
		this.release(this.submitted);
	}
}
