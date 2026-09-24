import { isolateHistory } from '@codemirror/commands';
import { Annotation, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export interface LockedRange {
	from: number;
	to: number;
	phase: 'prompt' | 'stream' | 'review';
	preview: string;
}

export const setLock = StateEffect.define<LockedRange>();
export const clearLock = StateEffect.define<void>();
const ownApply = Annotation.define<boolean>();

class PreviewWidget extends WidgetType {
	constructor(private phase: LockedRange['phase'], private preview: string) { super(); }

	eq(other: PreviewWidget): boolean {
		return this.phase === other.phase && this.preview === other.preview;
	}

	toDOM(view: EditorView): HTMLElement {
		const root = view.dom.ownerDocument.createElement('span');
		root.className = 'ai-rewrite-preview';
		const status = root.createSpan({ cls: 'ai-rewrite-preview-status' });
		if (this.phase === 'stream') status.createSpan({ cls: 'ai-rewrite-spinner', attr: { 'aria-hidden': 'true' } });
		status.createSpan({ text: this.phase === 'stream' ? 'AI 正在生成…' : '已完成 · 待确认' });
		const body = root.createSpan({ cls: 'ai-rewrite-preview-text' });
		body.setText(this.preview || '正在等待模型响应…');
		return root;
	}
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
			if (effect.is(setLock)) next = effect.value;
			if (effect.is(clearLock)) next = null;
		}
		return next;
	},
	provide: (field) => EditorView.decorations.compute([field], (state) => {
		const range = state.field(field);
		if (!range) return Decoration.none;
		const parts = [];
		if (range.from < range.to) parts.push(Decoration.mark({ class: 'ai-rewrite-locked' }).range(range.from, range.to));
		if (range.phase !== 'prompt') {
			parts.push(Decoration.widget({ widget: new PreviewWidget(range.phase, range.preview), side: 1 }).range(range.to));
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
