import { presentableDiff } from '@codemirror/merge';

/** 行内差异片段：changed 表示这段文字只出现在该侧，需要高亮。 */
export interface DiffSpan {
	type: 'equal' | 'changed';
	text: string;
}

/** 内联视图的一行：context 两侧相同，removed/added 只在一侧，collapsed 是折叠的未改动区。 */
export type DiffRow =
	| { kind: 'context'; aLine: number; bLine: number; text: string }
	| { kind: 'removed'; aLine: number; text: string; spans: DiffSpan[] }
	| { kind: 'added'; bLine: number; text: string; spans: DiffSpan[] }
	| { kind: 'collapsed'; index: number; count: number };

export interface DiffRowOptions {
	/** 已展开的折叠区域编号；编号按文档顺序稳定分配。 */
	expanded?: ReadonlySet<number>;
}

// Rule: 连续未改动的行超过 8 行就折叠，只留改动附近的 3 行上下文。
const COLLAPSE_MIN_SIZE = 8;
const COLLAPSE_MARGIN = 3;
// Failure: 超大文本超过等待上限时回退到不精确 diff，确认框仍能打开。
const DIFF_CONFIG = { scanLimit: 500, timeout: 2000 };

interface Line {
	from: number;
	to: number;
	text: string;
}

interface Range {
	from: number;
	to: number;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let from = 0;
	for (;;) {
		const index = text.indexOf('\n', from);
		if (index < 0) {
			lines.push({ from, to: text.length, text: text.slice(from) });
			return lines;
		}
		lines.push({ from, to: index, text: text.slice(from, index) });
		from = index + 1;
	}
}

/** 返回最后一个 from <= pos 的行号；pos 指向换行符时仍算该行。 */
function lineAt(lines: Line[], pos: number): number {
	let low = 0;
	let high = lines.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (lines[mid]!.from <= pos) low = mid;
		else high = mid - 1;
	}
	return low;
}

/** Flow: 把改动区间与一行求交，得到该行内的高亮片段；两侧行与区间都按位置递增访问。 */
function spansOf(line: Line, ranges: readonly Range[], cursor: { value: number }): DiffSpan[] {
	const spans: DiffSpan[] = [];
	let index = cursor.value;
	while (index < ranges.length && ranges[index]!.to <= line.from) index++;
	cursor.value = index;
	let pos = line.from;
	for (; index < ranges.length && ranges[index]!.from < line.to; index++) {
		const range = ranges[index]!;
		const from = Math.max(range.from, line.from);
		const to = Math.min(range.to, line.to);
		if (from > pos) spans.push({ type: 'equal', text: line.text.slice(pos - line.from, from - line.from) });
		if (to > from) spans.push({ type: 'changed', text: line.text.slice(from - line.from, to - line.from) });
		pos = Math.max(pos, to);
	}
	if (pos < line.to) spans.push({ type: 'equal', text: line.text.slice(pos - line.from) });
	return spans;
}

/** Effect: 折叠过长的未改动区域；折叠编号与 expanded 无关，重绘后仍稳定。 */
function collapse(rows: DiffRow[], expanded: ReadonlySet<number> | undefined): DiffRow[] {
	const result: DiffRow[] = [];
	let index = 0;
	let i = 0;
	while (i < rows.length) {
		const row = rows[i]!;
		if (row.kind !== 'context') {
			result.push(row);
			i++;
			continue;
		}
		let end = i;
		while (end < rows.length && rows[end]!.kind === 'context') end++;
		const count = end - i;
		if (count > COLLAPSE_MIN_SIZE) {
			if (expanded?.has(index)) {
				for (let k = i; k < end; k++) result.push(rows[k]!);
			} else {
				for (let k = 0; k < COLLAPSE_MARGIN; k++) result.push(rows[i + k]!);
				result.push({ kind: 'collapsed', index, count: count - COLLAPSE_MARGIN * 2 });
				for (let k = end - COLLAPSE_MARGIN; k < end; k++) result.push(rows[k]!);
			}
			index++;
		} else {
			for (let k = i; k < end; k++) result.push(rows[k]!);
		}
		i = end;
	}
	return result;
}

/**
 * Flow: 先按字符级 diff 把两侧行一一配对上（同一行的多处改动算一个配对），
 * 配对成功且文字相同时作为未改动行，文字不同时输出 -/+ 一对；剩余行按新增或删除输出。
 * Guarantee: 未折叠时，context 与 removed 行的文字按顺序拼起来等于原文，
 * context 与 added 行的文字按顺序拼起来等于结果，两侧内容都不会丢失或重复。
 */
export function buildDiffRows(original: string, result: string, options: DiffRowOptions = {}): DiffRow[] {
	const aLines = splitLines(original);
	const bLines = splitLines(result);
	const changes = presentableDiff(original, result, DIFF_CONFIG);
	const aMatch = new Int32Array(aLines.length).fill(-1);
	const bMatch = new Int32Array(bLines.length).fill(-1);

	// 1) 行配对：把 A 行首位置映射到 B 位置，落在同一 B 行的两侧行互为一对。
	let changeIndex = 0;
	let aEqual = 0;
	let bEqual = 0;
	const mapAToB = (pos: number, lineEnd: number): number => {
		while (changeIndex < changes.length) {
			const change = changes[changeIndex]!;
			if (pos < change.fromA) break;
			if (pos < change.toA) {
				if (change.toB === change.fromB) return -1;
				// Rule: 替换按偏移对应，偏移超出 B 侧长度时说明这段原文已被删掉。
				const offset = pos - change.fromA;
				return offset < change.toB - change.fromB ? change.fromB + offset : -1;
			}
			// Rule: 纯插入点之后的原文属于新的一行；插入点已在行尾（空行）时仍算该行。
			if (change.fromA === change.toA && pos === change.fromA) return lineEnd > pos ? change.toB : change.fromB;
			aEqual = change.toA;
			bEqual = change.toB;
			changeIndex++;
		}
		return bEqual + (pos - aEqual);
	};
	let lastMatch = -1;
	for (let i = 0; i < aLines.length; i++) {
		const line = aLines[i]!;
		const target = mapAToB(line.from, line.to);
		if (target < 0) continue;
		const j = lineAt(bLines, target);
		if (j <= lastMatch || bMatch[j]! >= 0) continue;
		aMatch[i] = j;
		bMatch[j] = i;
		lastMatch = j;
	}

	// 2) 逐行输出：互为配对的两行成对出现，其余行单独作为删除或新增行。
	const aRanges: Range[] = [];
	const bRanges: Range[] = [];
	for (const change of changes) {
		if (change.toA > change.fromA) aRanges.push({ from: change.fromA, to: change.toA });
		if (change.toB > change.fromB) bRanges.push({ from: change.fromB, to: change.toB });
	}
	const aCursor = { value: 0 };
	const bCursor = { value: 0 };
	const removedRow = (index: number): DiffRow =>
		({ kind: 'removed', aLine: index + 1, text: aLines[index]!.text, spans: spansOf(aLines[index]!, aRanges, aCursor) });
	const addedRow = (index: number): DiffRow =>
		({ kind: 'added', bLine: index + 1, text: bLines[index]!.text, spans: spansOf(bLines[index]!, bRanges, bCursor) });
	const rows: DiffRow[] = [];
	let a = 0;
	let b = 0;
	while (a < aLines.length || b < bLines.length) {
		if (a < aLines.length && b < bLines.length && aMatch[a] === b) {
			if (aLines[a]!.text === bLines[b]!.text) rows.push({ kind: 'context', aLine: a + 1, bLine: b + 1, text: aLines[a]!.text });
			else {
				rows.push(removedRow(a));
				rows.push(addedRow(b));
			}
			a++;
			b++;
			continue;
		}
		if (a < aLines.length && (aMatch[a]! < 0 || aMatch[a]! < b)) {
			rows.push(removedRow(a));
			a++;
			continue;
		}
		if (b < bLines.length && (bMatch[b]! < 0 || bMatch[b]! < a)) {
			rows.push(addedRow(b));
			b++;
			continue;
		}
		// Failure: 配对顺序异常时按删除/新增推进，保证两侧内容都输出且不循环。
		if (a < aLines.length) {
			rows.push(removedRow(a));
			a++;
			continue;
		}
		rows.push(addedRow(b));
		b++;
	}

	return collapse(rows, options.expanded);
}
