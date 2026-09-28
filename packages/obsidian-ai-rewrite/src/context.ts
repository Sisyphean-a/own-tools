export interface RewriteContext {
	before: string;
	after: string;
}

/**
 * Flow: 从笔记正文取出选区（或光标）前后的原文，两侧共享一个字符额度。
 * Rule: 只取截断后的尾部/头部，保证紧邻选区的内容一定保留；截断处用 `…` 标注。
 * Effect: 一侧不足额度时剩余额度转给另一侧；limit <= 0 表示不发送上下文。
 */
export function buildContext(doc: string, from: number, to: number, limit: number): RewriteContext | null {
	if (!Number.isFinite(limit) || limit <= 0) return null;
	const half = Math.ceil(limit / 2);
	let before = takeEnd(doc.slice(0, from), half);
	let after = takeStart(doc.slice(to), limit - half);
	if (before.truncated && !after.truncated) before = takeEnd(doc.slice(0, from), limit - after.text.length);
	else if (after.truncated && !before.truncated) after = takeStart(doc.slice(to), limit - before.text.length);
	return { before: before.text, after: after.text };
}

function takeEnd(source: string, budget: number): { text: string; truncated: boolean } {
	if (source.length <= budget) return { text: source, truncated: false };
	let start = source.length - budget;
	const lineBreak = source.indexOf('\n', start);
	// Rule: 优先从行首开始上下文；只有残段超过一半额度时才接受行中间截断（长段落本身没有换行）。
	if (lineBreak !== -1 && lineBreak - start <= budget / 2) start = lineBreak + 1;
	return { text: `…${source.slice(start)}`, truncated: true };
}

function takeStart(source: string, budget: number): { text: string; truncated: boolean } {
	if (source.length <= budget) return { text: source, truncated: false };
	let end = budget;
	const lineBreak = source.lastIndexOf('\n', end);
	if (lineBreak >= budget / 2) end = lineBreak;
	return { text: `${source.slice(0, end)}…`, truncated: true };
}
