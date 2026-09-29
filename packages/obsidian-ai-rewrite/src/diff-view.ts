import { standardKeymap } from '@codemirror/commands';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { buildDiffRows } from './inline-diff';

/** 内联视图：单栏行对齐，同行的改动成对显示 -/+；左右视图：原文与结果并排对照。 */
export type DiffLayout = 'inline' | 'split';

export interface DiffViewHandle {
	destroy(): void;
}

// Rule: 折叠连续未改动区域，长文只保留改动附近的上下文。
const COLLAPSE_UNCHANGED = { margin: 3, minSize: 5 };
// Failure: 超大文本超过等待上限时回退到不精确 diff，确认框仍能打开。
const DIFF_CONFIG = { timeout: 2000 };
// Rule: 两侧编辑器都只读，差异视图只用于比较，不提供编辑入口。
const readOnly = [
	lineNumbers(),
	drawSelection(),
	keymap.of(standardKeymap),
	EditorView.lineWrapping,
	EditorState.readOnly.of(true),
	EditorView.editable.of(false),
];

/** Effect: 把只读差异视图挂到 parent 上；返回的视图只能通过 destroy 释放。 */
export function createDiffView(layout: DiffLayout, parent: HTMLElement, original: string, result: string): DiffViewHandle {
	return layout === 'split' ? createSplitView(parent, original, result) : createInlineView(parent, original, result);
}

function createSplitView(parent: HTMLElement, original: string, result: string): DiffViewHandle {
	const view = new MergeView({
		a: { doc: original, extensions: readOnly },
		b: { doc: result, extensions: readOnly },
		parent,
		collapseUnchanged: COLLAPSE_UNCHANGED,
		diffConfig: DIFF_CONFIG,
	});
	return { destroy: () => view.destroy() };
}

/** Flow: 按行渲染内联差异，展开折叠区域时整块重绘。 */
function createInlineView(parent: HTMLElement, original: string, result: string): DiffViewHandle {
	const container = parent.createDiv({ cls: 'ai-rewrite-inline-diff' });
	const expanded = new Set<number>();
	const draw = (): void => {
		container.empty();
		for (const row of buildDiffRows(original, result, { expanded })) {
			if (row.kind === 'collapsed') {
				const summary = container.createDiv({ cls: 'ai-diff-row is-collapsed' });
				summary.createEl('button', {
					cls: 'ai-diff-expand',
					text: `展开未改动的 ${row.count} 行`,
					attr: { type: 'button' },
				}).addEventListener('click', () => {
					expanded.add(row.index);
					draw();
				});
				continue;
			}
			const line = container.createDiv({ cls: `ai-diff-row is-${row.kind}` });
			line.createSpan({ cls: 'ai-diff-num', text: row.kind === 'added' ? '' : String(row.aLine) });
			line.createSpan({ cls: 'ai-diff-num', text: row.kind === 'removed' ? '' : String(row.bLine) });
			line.createSpan({ cls: 'ai-diff-sign', text: row.kind === 'removed' ? '-' : row.kind === 'added' ? '+' : '' });
			const code = line.createSpan({ cls: 'ai-diff-code' });
			if (row.kind === 'context') {
				code.createSpan({ text: row.text });
				continue;
			}
			for (const span of row.spans) {
				const part = code.createSpan({ text: span.text });
				if (span.type === 'changed') part.addClass('ai-diff-changed');
			}
		}
	};
	draw();
	return { destroy: () => container.remove() };
}
