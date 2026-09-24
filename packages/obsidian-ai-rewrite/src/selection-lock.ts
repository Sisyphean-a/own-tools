import { isolateHistory } from '@codemirror/commands';
import { Annotation, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export interface LockedRange {
	from: number;
	to: number;
	busy: boolean;
}

export const setLock = StateEffect.define<LockedRange>();
export const clearLock = StateEffect.define<void>();
const ownReplacement = Annotation.define<boolean>();

class BusyWidget extends WidgetType {
	toDOM(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'ai-rewrite-progress';
		el.setAttribute('role', 'status');
		el.textContent = 'AI 正在改写…';
		return el;
	}
}

export const lockedRange = StateField.define<LockedRange | null>({
	create: () => null,
	update(value, tr) {
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
		const mark = Decoration.mark({ class: range.busy ? 'ai-rewrite-locked ai-rewrite-busy' : 'ai-rewrite-locked' });
		const parts = [mark.range(range.from, range.to)];
		if (range.busy) parts.push(Decoration.widget({ widget: new BusyWidget(), side: 1 }).range(range.to));
		return Decoration.set(parts, true);
	}),
});

export const selectionGuard: Extension = [
	lockedRange,
	Prec.highest(EditorState.transactionFilter.of((tr) => {
		const range = tr.startState.field(lockedRange);
		if (!range || tr.annotation(ownReplacement)) return tr;
		let blocked = false;
		// Rule: 插入在两端允许；删除或替换只要与锁定内容相交，就拒绝整笔事务。
		tr.changes.iterChanges((from, to) => {
			if ((from === to && from > range.from && from < range.to) ||
				(from < to && from < range.to && to > range.from)) blocked = true;
		});
		return blocked ? [] : tr;
	})),
];

function requireLocked(view: EditorView, expected: string): LockedRange {
	const range = view.state.field(lockedRange);
	if (!range || view.state.doc.sliceString(range.from, range.to) !== expected) {
		throw new Error('选区已变化，无法安全改写');
	}
	return range;
}

export function appendLocked(view: EditorView, previous: string, delta: string, first: boolean): string {
	const range = requireLocked(view, previous);
	const text = first ? delta : previous + delta;
	view.dispatch({
		changes: { from: first ? range.from : range.to, to: range.to, insert: delta },
		effects: setLock.of({ from: range.from, to: range.from + text.length, busy: true }),
		annotations: [ownReplacement.of(true), Transaction.addToHistory.of(false)],
	});
	return text;
}

export function restoreLocked(view: EditorView, current: string, original: string): void {
	const range = requireLocked(view, current);
	view.dispatch({
		changes: { from: range.from, to: range.to, insert: original },
		effects: clearLock.of(undefined),
		annotations: [ownReplacement.of(true), Transaction.addToHistory.of(false)],
	});
}

export function finishLocked(view: EditorView, current: string, original: string, result: string): void {
	const range = requireLocked(view, current);
	if (current !== original) {
		// Rule: 流式事务不入撤销历史；先还原原文，再以一笔独立事务提交最终改写。
		view.dispatch({
			changes: { from: range.from, to: range.to, insert: original },
			effects: setLock.of({ from: range.from, to: range.from + original.length, busy: true }),
			annotations: [ownReplacement.of(true), Transaction.addToHistory.of(false)],
		});
	}
	const finalRange = requireLocked(view, original);
	view.dispatch({
		changes: { from: finalRange.from, to: finalRange.to, insert: result },
		selection: { anchor: finalRange.from + result.length },
		effects: clearLock.of(undefined),
		annotations: [ownReplacement.of(true), isolateHistory.of('full')],
	});
}

