export interface DiffSegment {
	type: 'equal' | 'removed' | 'added';
	text: string;
}

// Rule: 中英文混排按汉字、单词、空白与标点分词；大选区回退到原文/结果并排显示，避免二次方内存占用。
export function diffWords(before: string, after: string, budget = 1200): DiffSegment[] | null {
	const tokenize = (text: string) => text.match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
	const a = tokenize(before);
	const b = tokenize(after);
	if (a.length > budget || b.length > budget) return null;
	const n = a.length;
	const m = b.length;
	const rows: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			rows[i]![j] = a[i] === b[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
		}
	}
	const segments: DiffSegment[] = [];
	const push = (type: DiffSegment['type'], text: string) => {
		if (!text) return;
		const last = segments[segments.length - 1];
		if (last?.type === type) last.text += text;
		else segments.push({ type, text });
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			push('equal', a[i]!); i++; j++;
		} else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) {
			push('removed', a[i]!); i++;
		} else {
			push('added', b[j]!); j++;
		}
	}
	while (i < n) push('removed', a[i++]!);
	while (j < m) push('added', b[j++]!);
	return segments;
}
