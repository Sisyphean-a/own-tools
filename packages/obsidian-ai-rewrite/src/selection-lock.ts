import { isolateHistory } from '@codemirror/commands';
import { Annotation, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export interface ProgressEntry {
	id: string;
	text: string;
	done: boolean;
}

export interface LockedRange {
	from: number;
	to: number;
	phase: 'prompt' | 'stream' | 'review';
	preview: string;
	/** 思考内容，随流式响应累积；只显示在预览卡片，不写入笔记。 */
	thinking?: string;
	/** 工具进度：同一 id 原地更新，每次调用只占一行。 */
	progress?: readonly ProgressEntry[];
	/** 当前正在进行的活动；新的思考内容会把它清空。 */
	activity?: string;
	/** 过程面板是否展开；默认展开，进入待确认时自动收起。 */
	expanded?: boolean;
}

const setLock = StateEffect.define<LockedRange>();
const clearLock = StateEffect.define<void>();
/** 追加思考内容。 */
const appendThinking = StateEffect.define<string>();
/** 写入一行工具进度：同一 id 原地更新（调用与结果同行），新 id 追加。 */
const setProgress = StateEffect.define<ProgressEntry>();
/** 展开或收起过程面板。 */
export const toggleProcess = StateEffect.define<void>();
const ownApply = Annotation.define<boolean>();
// Rule: 取消回调只按编辑器视图弱引用保存，不进入编辑器状态，避免状态快照长期持有插件会话。
const cancelHandlers = new WeakMap<EditorView, () => void>();

/** 无新内容超过该秒数时显示等待提示，避免看起来像卡死。 */
export const QUIET_HINT_SECONDS = 8;
/** 过程区保留的思考字符上限；超出时只保留最近的，避免长时间生成把状态和 DOM 撑大。 */
export const MAX_THINKING_CHARS = 12000;

/** Flow: 流式阶段长时间没有新内容时给出等待文案；其他阶段不提示。 */
export function quietHint(phase: LockedRange['phase'], lastEventAt: number, now: number): string | null {
	if (phase !== 'stream') return null;
	const seconds = Math.floor((now - lastEventAt) / 1000);
	return seconds >= QUIET_HINT_SECONDS ? `已 ${seconds} 秒没有新内容，仍在等待…` : null;
}

interface PreviewParts {
	range: LockedRange;
	win: Window | null;
	timer: number | null;
	startedAt: number;
	lastEventAt: number;
	signature: string;
	lastThinking: string;
	lastProgress: readonly ProgressEntry[] | null;
	spinner: HTMLElement;
	statusLabel: HTMLElement;
	statusLabelValue: Text;
	elapsed: HTMLElement;
	elapsedValue: Text;
	quiet: HTMLElement;
	quietValue: Text;
	cancel: HTMLButtonElement;
	cancelAvailable: boolean;
	process: HTMLElement;
	toggle: HTMLButtonElement;
	processLabel: HTMLElement;
	processLabelValue: Text;
	body: HTMLElement;
	thinking: HTMLElement;
	thinkingValue: Text;
	tools: HTMLElement;
	text: HTMLElement;
	textValue: Text;
}

const previewParts = new WeakMap<HTMLElement, PreviewParts>();

class PreviewWidget extends WidgetType {
	constructor(private range: LockedRange) { super(); }

	eq(other: PreviewWidget): boolean {
		return this.range.phase === other.range.phase && this.range.preview === other.range.preview &&
			this.range.thinking === other.range.thinking && this.range.progress === other.range.progress &&
			this.range.activity === other.range.activity && (this.range.expanded ?? true) === (other.range.expanded ?? true);
	}

	toDOM(view: EditorView): HTMLElement {
		const doc = view.dom.ownerDocument;
		const root = doc.createElement('span');
		root.className = 'ai-rewrite-preview';
		const status = root.createSpan({ cls: 'ai-rewrite-preview-status' });
		const spinner = status.createSpan({ cls: 'ai-rewrite-spinner', attr: { 'aria-hidden': 'true' } });
		const statusLabel = status.createSpan({ cls: 'ai-rewrite-preview-status-label', attr: { role: 'status', 'aria-live': 'polite' } });
		const statusLabelValue = statusLabel.appendChild(doc.createTextNode(''));
		const elapsed = status.createSpan({ cls: 'ai-rewrite-preview-elapsed' });
		const elapsedValue = elapsed.appendChild(doc.createTextNode(''));
		const cancelHandler = cancelHandlers.get(view);
		const cancel = status.createEl('button', {
			cls: 'ai-rewrite-preview-cancel',
			text: '取消生成',
			attr: { type: 'button', 'aria-label': '取消正在进行的 AI 改写' },
		});
		cancel.hidden = this.range.phase !== 'stream' || !cancelHandler;
		if (cancelHandler) {
			cancel.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				cancelHandler();
			});
		}
		const quiet = root.createDiv({ cls: 'ai-rewrite-quiet' });
		const quietValue = quiet.appendChild(doc.createTextNode(''));
		const process = root.createDiv({ cls: 'ai-rewrite-process' });
		const toggle = process.createEl('button', { cls: 'ai-rewrite-process-toggle', attr: { type: 'button' } });
		const processLabel = toggle.createSpan({ cls: 'ai-rewrite-process-label' });
		const processLabelValue = processLabel.appendChild(doc.createTextNode(''));
		toggle.createSpan({ cls: 'ai-rewrite-process-arrow', text: '▸', attr: { 'aria-hidden': 'true' } });
		const inner = process.createDiv({ cls: 'ai-rewrite-process-panel' }).createDiv({ cls: 'ai-rewrite-process-inner' });
		const body = inner.createDiv({ cls: 'ai-rewrite-process-body' });
		const thinking = body.createDiv({ cls: 'ai-rewrite-thinking' });
		const thinkingValue = thinking.appendChild(doc.createTextNode(''));
		const tools = body.createEl('ul', { cls: 'ai-rewrite-tools' });
		const text = root.createSpan({ cls: 'ai-rewrite-preview-text' });
		const textValue = text.appendChild(doc.createTextNode(''));
		const win = doc.defaultView;
		const parts: PreviewParts = {
			range: this.range, win, timer: null, startedAt: Date.now(), lastEventAt: Date.now(), signature: '', lastThinking: '', lastProgress: null,
			spinner, statusLabel, statusLabelValue, elapsed, elapsedValue, quiet, quietValue, cancel, cancelAvailable: !!cancelHandler,
			process, toggle, processLabel, processLabelValue, body, thinking, thinkingValue, tools, text, textValue,
		};
		previewParts.set(root, parts);
		toggle.setAttribute('aria-label', '展开或收起思考与工具过程');
		toggle.addEventListener('click', () => {
			view.dispatch({ effects: toggleProcess.of(undefined) });
		});
		if (this.range.phase === 'stream' && win) {
			// Effect: 每秒刷新耗时，长时间没有新内容时也能证明请求仍在进行。
			parts.timer = win.setInterval(() => {
				const current = previewParts.get(root);
				if (!current || current.timer === null) return;
				setTextData(current.elapsedValue, `${elapsedSeconds(current)}s`);
				this.renderQuiet(current);
			}, 1000);
		}
		this.render(parts);
		return root;
	}

	updateDOM(dom: HTMLElement): boolean {
		const parts = previewParts.get(dom);
		if (!parts) return false;
		if (this.range.phase !== 'stream' && parts.timer !== null) {
			parts.win?.clearInterval(parts.timer);
			parts.timer = null;
		}
		parts.range = this.range;
		this.render(parts);
		return true;
	}

	destroy(dom: HTMLElement): void {
		const parts = previewParts.get(dom);
		if (parts && parts.timer !== null) parts.win?.clearInterval(parts.timer);
		previewParts.delete(dom);
	}

	/** Flow: 只更新已有节点，保留面板展开状态和滚动位置；长时间输出也不会跳动。 */
	private render(parts: PreviewParts): void {
		const streaming = this.range.phase === 'stream';
		const thinking = this.range.thinking ?? '';
		const progress = this.range.progress ?? [];
		// Rule: 只有思考、正文或工具进度真的变化才重置“静默”计时，避免折叠操作被当成新内容；思考被截断后靠尾部内容判断。
		const signature = `${thinking.length}|${thinking.slice(-64)}|${this.range.preview.length}|${progress.map((entry) => entry.text).join('\u0001')}`;
		if (signature !== parts.signature) {
			parts.signature = signature;
			parts.lastEventAt = Date.now();
		}
		const hasProcess = thinking.length > 0 || progress.length > 0;
		const expanded = hasProcess && (this.range.expanded ?? true);
		// Rule: 内部内容始终是纯文本，不做任何高亮或 Markdown 解析。
		parts.spinner.hidden = !streaming;
		parts.cancel.hidden = !streaming || !parts.cancelAvailable;
		setTextData(parts.statusLabelValue, streaming ? 'AI 正在生成…' : '已完成 · 待确认');
		setTextData(parts.elapsedValue, streaming ? `${elapsedSeconds(parts)}s` : '');
		parts.process.hidden = !hasProcess;
		parts.process.classList.toggle('is-expanded', expanded);
		parts.toggle.setAttribute('aria-expanded', String(expanded));
		setTextData(parts.processLabelValue, !streaming ? '思考与工具' : this.range.activity ?? (this.range.preview ? '正在生成正文…' : thinking ? '正在思考…' : '准备中…'));
		// Rule: 文字和列表未变化就不重写 DOM；滚动调整放到下一帧，避免每次渲染都强制重排大面板。
		if (parts.lastThinking !== thinking) {
			parts.lastThinking = thinking;
			setTextData(parts.thinkingValue, thinking);
			parts.thinking.hidden = thinking.length === 0;
		}
		if (parts.lastProgress !== progress) {
			parts.lastProgress = progress;
			parts.tools.hidden = progress.length === 0;
			parts.tools.empty();
			for (const entry of progress) {
				// Rule: 每个工具调用只占一行，完成时原地更新，不追加第二条。
				parts.tools.createEl('li', { cls: entry.done ? 'is-done' : 'is-running', text: entry.text });
			}
		}
		setTextData(parts.textValue, this.range.preview || (hasProcess ? '' : '正在等待模型响应…'));
		if (expanded && parts.win) {
			const body = parts.body;
			parts.win.requestAnimationFrame(() => {
				if (body.scrollTop + body.clientHeight >= body.scrollHeight - 8) body.scrollTop = body.scrollHeight;
			});
		}
		this.renderQuiet(parts);
	}

	/** Flow: 静默计时文案；计时器每秒刷新，新内容到达时由 render 重置。 */
	private renderQuiet(parts: PreviewParts): void {
		const message = quietHint(parts.range.phase, parts.lastEventAt, Date.now());
		parts.quiet.hidden = message === null;
		setTextData(parts.quietValue, message ?? '');
	}
}

/** Rule: 只改文本节点的 data，不重建节点；过程内容始终是纯文本，不做任何高亮或语法着色。 */
function setTextData(node: Text, value: string): void {
	if (node.data !== value) node.data = value;
}

/** Rule: 过程区只保留最近的思考内容，避免长时间生成时状态和 DOM 无限膨胀。 */
function clipThinking(text: string): string {
	return text.length <= MAX_THINKING_CHARS ? text : `…${text.slice(-MAX_THINKING_CHARS)}`;
}

function elapsedSeconds(parts: PreviewParts): number {
	return Math.max(1, Math.round((Date.now() - parts.startedAt) / 1000));
}

export const lockedRange = StateField.define<LockedRange | null>({
	create: () => null,
	update(value, tr) {
		// Rule: 应用结果和预览清理必须属于同一事务；即使宿主过滤掉 effect 也不能留下待确认卡片。
		if (tr.annotation(ownApply)) return null;
		let next = value && {
			...value,
			from: tr.changes.mapPos(value.from, 1),
			to: tr.changes.mapPos(value.to, -1),
		};
		for (const effect of tr.effects) {
			if (effect.is(setLock)) {
				// Rule: 进入待确认时收起过程面板，保持卡片紧凑；用户仍可手动展开。
				next = effect.value.phase === 'review' ? { ...effect.value, expanded: false } : effect.value;
			}
			if (effect.is(clearLock)) next = null;
			if (effect.is(appendThinking) && next) {
				next = { ...next, thinking: clipThinking(`${next.thinking ?? ''}${effect.value}`), activity: undefined };
			}
			if (effect.is(setProgress) && next) {
				const entries = next.progress ?? [];
				const index = entries.findIndex((entry) => entry.id === effect.value.id);
				next = {
					...next,
					progress: index < 0 ? [...entries, effect.value] : entries.map((entry, i) => (i === index ? effect.value : entry)),
					activity: effect.value.text,
				};
			}
			if (effect.is(toggleProcess) && next) next = { ...next, expanded: !(next.expanded ?? true) };
		}
		return next;
	},
	provide: (field) => EditorView.decorations.compute([field], (state) => {
		const range = state.field(field);
		if (!range) return Decoration.none;
		const parts = [];
		if (range.from < range.to) parts.push(Decoration.mark({ class: 'ai-rewrite-locked' }).range(range.from, range.to));
		if (range.phase !== 'prompt') {
			parts.push(Decoration.widget({ widget: new PreviewWidget(range), side: 1 }).range(range.to));
		}
		return Decoration.set(parts, true);
	}),
});

/** Flow: 一次改写持有一个编辑器范围；会话只发送预览事件，不拼装锁的状态事务。 */
export class SelectionPreview {
	private preview = '';
	private thinkingBuffer = '';

	private constructor(private view: EditorView, private original: string) {}

	static open(view: EditorView, from: number, to: number, original: string): SelectionPreview | null {
		if (view.state.field(lockedRange) || view.state.doc.sliceString(from, to) !== original) return null;
		view.dispatch({ effects: setLock.of({ from, to, phase: 'prompt', preview: '' }) });
		return new SelectionPreview(view, original);
	}

	static isLocked(view: EditorView): boolean {
		return !!view.state.field(lockedRange, false);
	}

	static release(view: EditorView): void {
		cancelHandlers.delete(view);
		if (view.state.field(lockedRange, false) !== undefined) view.dispatch({ effects: clearLock.of(undefined) });
	}

	setCancelHandler(handler: () => void): void {
		cancelHandlers.set(this.view, handler);
	}

	start(): Pick<LockedRange, 'from' | 'to'> | null {
		const range = this.view.state.field(lockedRange);
		if (!range) return null;
		// Rule: 同一目标开始新一轮时丢弃上一版预览，避免继续修改时新旧结果叠加。
		this.preview = '';
		this.thinkingBuffer = '';
		this.view.dispatch({ effects: setLock.of({ ...range, phase: 'stream', preview: '' }) });
		return { from: range.from, to: range.to };
	}

	appendText(text: string): void {
		this.ensureLocked();
		this.preview += text;
	}

	appendReasoning(text: string): void {
		this.ensureLocked();
		this.thinkingBuffer += text;
	}

	progress(id: string, text: string, done: boolean): void {
		this.view.dispatch({ effects: setProgress.of({ id, text, done }) });
	}

	/** Effect: 思考与正文在调用者安排的同一帧中合成一次编辑器事务。 */
	flush(): void {
		const current = this.view.state.field(lockedRange, false);
		if (!current || this.view.state.doc.sliceString(current.from, current.to) !== this.original) return;
		const thinking = this.thinkingBuffer;
		const textChanged = this.preview !== current.preview;
		this.thinkingBuffer = '';
		this.view.dispatch({
			effects: [
				setLock.of({ ...current, phase: 'stream', preview: this.preview, ...(thinking || textChanged ? { activity: undefined } : {}) }),
				...(thinking ? [appendThinking.of(thinking)] : []),
			],
		});
	}

	reset(): void {
		this.preview = '';
		const current = this.view.state.field(lockedRange, false);
		if (current) this.view.dispatch({ effects: setLock.of({ ...current, phase: 'stream', preview: '' }) });
	}

	complete(result: string): void {
		const current = this.view.state.field(lockedRange);
		if (!current || this.view.state.doc.sliceString(current.from, current.to) !== this.original) {
			throw new Error('原文已变化');
		}
		this.view.dispatch({ effects: setLock.of({ ...current, phase: 'review', preview: result }) });
	}

	retry(): boolean {
		const current = this.view.state.field(lockedRange, false);
		if (!current) return false;
		this.preview = '';
		this.thinkingBuffer = '';
		this.view.dispatch({ effects: setLock.of({ from: current.from, to: current.to, phase: 'prompt', preview: '' }) });
		return true;
	}

	apply(result: string): { from: number; to: number } {
		const range = applyLocked(this.view, this.original, result);
		cancelHandlers.delete(this.view);
		return range;
	}

	private ensureLocked(): void {
		if (!this.view.state.field(lockedRange, false)) throw new Error('原文已变化');
	}
}

export const selectionGuard: Extension = [
	lockedRange,
	Prec.highest(EditorState.transactionFilter.of((tr) => {
		const range = tr.startState.field(lockedRange);
		if (!range || tr.annotation(ownApply)) return tr;
		let blocked = false;
		// Rule: 零长度选区锁住插入点；有选区时只阻止与选区内容相交的修改。
		tr.changes.iterChanges((from, to) => {
			if (range.from === range.to) {
				if (from <= range.from && to >= range.to) blocked = true;
			} else if ((from === to && from > range.from && from < range.to) ||
				(from < to && from < range.to && to > range.from)) blocked = true;
		});
		return blocked ? [] : tr;
	})),
];

function applyLocked(view: EditorView, original: string, replacement: string): { from: number; to: number } {
	const range = view.state.field(lockedRange);
	if (!range || range.phase !== 'review' || view.state.doc.sliceString(range.from, range.to) !== original) {
		throw new Error('原文或插入位置已变化，请重新生成');
	}
	const applied = { from: range.from, to: range.from + replacement.length };
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: replacement },
		selection: { anchor: range.from + replacement.length },
		effects: clearLock.of(undefined),
		annotations: [ownApply.of(true), isolateHistory.of('full')],
	});
	if (view.state.field(lockedRange) !== null ||
		view.state.doc.sliceString(range.from, range.from + replacement.length) !== replacement) {
		throw new Error('正文应用或预览清理未完成，请检查笔记内容并取消本次改写');
	}
	return applied;
}
