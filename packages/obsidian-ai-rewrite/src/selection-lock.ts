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

export const setLock = StateEffect.define<LockedRange>();
export const clearLock = StateEffect.define<void>();
/** 追加思考内容。 */
export const appendThinking = StateEffect.define<string>();
/** 写入一行工具进度：同一 id 原地更新（调用与结果同行），新 id 追加。 */
export const setProgress = StateEffect.define<ProgressEntry>();
/** 展开或收起过程面板。 */
export const toggleProcess = StateEffect.define<void>();
const ownApply = Annotation.define<boolean>();

/** 无新内容超过该秒数时显示等待提示，避免看起来像卡死。 */
export const QUIET_HINT_SECONDS = 8;

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
	spinner: HTMLElement;
	statusLabel: HTMLElement;
	elapsed: HTMLElement;
	quiet: HTMLElement;
	process: HTMLElement;
	toggle: HTMLButtonElement;
	processLabel: HTMLElement;
	body: HTMLElement;
	thinking: HTMLElement;
	tools: HTMLElement;
	text: HTMLElement;
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
		const root = view.dom.ownerDocument.createElement('span');
		root.className = 'ai-rewrite-preview';
		const status = root.createSpan({ cls: 'ai-rewrite-preview-status' });
		const spinner = status.createSpan({ cls: 'ai-rewrite-spinner', attr: { 'aria-hidden': 'true' } });
		const statusLabel = status.createSpan({ cls: 'ai-rewrite-preview-status-label' });
		const elapsed = status.createSpan({ cls: 'ai-rewrite-preview-elapsed' });
		const quiet = root.createDiv({ cls: 'ai-rewrite-quiet' });
		const process = root.createDiv({ cls: 'ai-rewrite-process' });
		const toggle = process.createEl('button', { cls: 'ai-rewrite-process-toggle', attr: { type: 'button' } });
		const processLabel = toggle.createSpan({ cls: 'ai-rewrite-process-label' });
		toggle.createSpan({ cls: 'ai-rewrite-process-arrow', text: '▸', attr: { 'aria-hidden': 'true' } });
		const inner = process.createDiv({ cls: 'ai-rewrite-process-panel' }).createDiv({ cls: 'ai-rewrite-process-inner' });
		const body = inner.createDiv({ cls: 'ai-rewrite-process-body' });
		const thinking = body.createDiv({ cls: 'ai-rewrite-thinking' });
		const tools = body.createEl('ul', { cls: 'ai-rewrite-tools' });
		const text = root.createSpan({ cls: 'ai-rewrite-preview-text' });
		const win = view.dom.ownerDocument.defaultView;
		const parts: PreviewParts = {
			range: this.range, win, timer: null, startedAt: Date.now(), lastEventAt: Date.now(), signature: '',
			spinner, statusLabel, elapsed, quiet, process, toggle, processLabel, body, thinking, tools, text,
		};
		previewParts.set(root, parts);
		toggle.addEventListener('click', () => {
			view.dispatch({ effects: toggleProcess.of(undefined) });
		});
		if (this.range.phase === 'stream' && win) {
			// Effect: 每秒刷新耗时，长时间没有新内容时也能证明请求仍在进行。
			parts.timer = win.setInterval(() => {
				const current = previewParts.get(root);
				if (!current || current.timer === null) return;
				current.elapsed.setText(`${elapsedSeconds(current)}s`);
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
		// Rule: 只有思考、正文或工具进度真的变化才重置“静默”计时，避免折叠操作被当成新内容。
		const signature = `${thinking.length}|${this.range.preview.length}|${progress.map((entry) => entry.text).join('\u0001')}`;
		if (signature !== parts.signature) {
			parts.signature = signature;
			parts.lastEventAt = Date.now();
		}
		const hasProcess = thinking.length > 0 || progress.length > 0;
		const expanded = hasProcess && (this.range.expanded ?? true);
		parts.spinner.hidden = !streaming;
		parts.statusLabel.setText(streaming ? 'AI 正在生成…' : '已完成 · 待确认');
		parts.elapsed.setText(streaming ? `${elapsedSeconds(parts)}s` : '');
		parts.process.hidden = !hasProcess;
		parts.process.classList.toggle('is-expanded', expanded);
		parts.toggle.setAttribute('aria-expanded', String(expanded));
		parts.processLabel.setText(!streaming ? '思考与工具' : this.range.activity ?? (this.range.preview ? '正在生成正文…' : thinking ? '正在思考…' : '准备中…'));
		const stuck = expanded && parts.body.scrollTop + parts.body.clientHeight >= parts.body.scrollHeight - 8;
		parts.thinking.setText(thinking);
		parts.thinking.hidden = thinking.length === 0;
		parts.tools.hidden = progress.length === 0;
		parts.tools.empty();
		for (const entry of progress) {
			// Rule: 每个工具调用只占一行，完成时原地更新，不追加第二条。
			parts.tools.createEl('li', { cls: entry.done ? 'is-done' : 'is-running', text: entry.text });
		}
		parts.text.setText(this.range.preview || (hasProcess ? '' : '正在等待模型响应…'));
		if (stuck) parts.body.scrollTop = parts.body.scrollHeight;
		this.renderQuiet(parts);
	}

	/** Flow: 静默计时文案；计时器每秒刷新，新内容到达时由 render 重置。 */
	private renderQuiet(parts: PreviewParts): void {
		const message = quietHint(parts.range.phase, parts.lastEventAt, Date.now());
		parts.quiet.hidden = message === null;
		if (message) parts.quiet.setText(message);
	}
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
			if (effect.is(appendThinking) && next) next = { ...next, thinking: `${next.thinking ?? ''}${effect.value}`, activity: undefined };
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

export function applyLocked(view: EditorView, original: string, replacement: string): void {
	const range = view.state.field(lockedRange);
	if (!range || range.phase !== 'review' || view.state.doc.sliceString(range.from, range.to) !== original) {
		throw new Error('原文或插入位置已变化，请重新生成');
	}
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
}
