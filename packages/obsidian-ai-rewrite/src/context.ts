export interface RewriteContext {
	before: string;
	after: string;
	/** 已有笔记正文样本，代表要延续的写法与排版；只学形态，不是改写对象。 */
	samples?: string[];
}

/** 风格样本额度：当前笔记取前 8000 字，同目录笔记每篇前 1500 字、最多 3 篇。 */
export const STYLE_CURRENT_LIMIT = 8000;
export const STYLE_NEIGHBOR_LIMIT = 1500;
export const STYLE_NEIGHBOR_COUNT = 3;

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

/** Flow: 截断形态样本，保证发送量有上限；`…` 标注截断。 */
export function clipStyleSample(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** Flow: 取当前笔记去掉选区后的正文作为第一篇样本，避免把待改写内容当成范例。 */
export function currentStyleSample(doc: string, from: number, to: number): string {
	return clipStyleSample(doc.slice(0, from) + doc.slice(to), STYLE_CURRENT_LIMIT);
}

/** Rule: 同目录笔记按修改时间取最近的几篇；只取同层文件，样本不含路径或文件名。 */
export function pickNeighborNotes<T extends { path: string; stat: { mtime: number } }>(
	files: readonly T[],
	currentPath: string,
	count = STYLE_NEIGHBOR_COUNT,
): T[] {
	const separator = currentPath.lastIndexOf('/');
	const folder = separator === -1 ? '' : currentPath.slice(0, separator);
	const inSameFolder = (path: string) => separator === -1
		? !path.includes('/')
		: path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/');
	return files
		.filter((file) => file.path !== currentPath && inSameFolder(file.path))
		.sort((a, b) => b.stat.mtime - a.stat.mtime)
		.slice(0, count);
}

/** Flow: 把风格样本并进上下文；没有样本时保持原上下文不变。 */
export function withStyleSamples(context: RewriteContext | null, samples: string[]): RewriteContext | null {
	if (!samples.length) return context;
	return { before: context?.before ?? '', after: context?.after ?? '', samples };
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
