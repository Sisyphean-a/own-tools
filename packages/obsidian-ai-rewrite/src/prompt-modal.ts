import { App, Modal, Notice, Setting } from 'obsidian';
import { MAX_REQUEST_BYTES, readPastedImage } from './images';

export class PromptModal extends Modal {
	private input!: HTMLTextAreaElement;
	private imageList!: HTMLElement;
	private images: string[] = [];
	private pendingImages = 0;
	private submitted = false;
	private disposed = false;

	constructor(
		app: App,
		private hasSelection: boolean,
		private submitPrompt: (instruction: string, images: string[]) => void,
		private release: (submitted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.hasSelection ? '改写选中文字' : '在光标处生成内容');
		this.contentEl.createEl('p', { text: '输入要求，可粘贴图片作为参考。Enter 提交，Shift + Enter 换行。' });
		this.input = this.contentEl.createEl('textarea', {
			cls: 'ai-rewrite-input',
			attr: { placeholder: this.hasSelection ? '例如：改得更通顺一些' : '例如：写一段会议摘要', 'aria-label': '写作要求' },
		});
		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
				event.preventDefault();
				this.submit();
			}
		});
		this.input.addEventListener('paste', (event) => { void this.pasteImages(event); });
		this.imageList = this.contentEl.createDiv({ cls: 'ai-rewrite-images' });
		new Setting(this.contentEl).addButton((button) => {
			button.setButtonText(this.hasSelection ? '生成改写' : '生成内容').setCta().onClick(() => this.submit());
		});
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
		}
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
		if (!instruction || this.submitted) return;
		if (this.pendingImages) {
			new Notice('图片仍在读取，请稍候');
			return;
		}
		this.submitted = true;
		const images = [...this.images];
		this.close();
		this.submitPrompt(instruction, images);
	}

	onClose(): void {
		this.disposed = true;
		this.images = [];
		this.contentEl.empty();
		this.release(this.submitted);
	}
}
