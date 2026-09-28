import { requestUrl, type RequestUrlResponse } from 'obsidian';

/** 一次请求最多读取的链接数。 */
export const MAX_LINKS = 3;
/** 所有链接共享的正文字符额度；多个链接时均分。 */
export const WEB_TEXT_LIMIT = 16000;
/** 原始网页超过该字符数视为异常页面，直接报错。 */
export const MAX_HTML_CHARS = 10_000_000;

export interface WebPage {
	url: string;
	title: string;
	text: string;
}

const URL_PATTERN = /https?:\/\/[^\s\u3000<>"'“”‘’（）【】「」《》，。、；：！？]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?。，、；：！？…—·"'”’»]+$/;
const CLOSING_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Flow: 从指令文本提取 http/https 链接并去重，裁掉 Markdown 包裹或中文标点留下的尾随符号。
 * Rule: 只按字面提取，不补全省略的协议、相对路径或邮箱。
 */
export function extractUrls(text: string): string[] {
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of text.matchAll(URL_PATTERN)) {
		let url = match[0];
		while (url) {
			const trimmed = url.replace(TRAILING_PUNCTUATION, '');
			if (trimmed.length !== url.length) {
				url = trimmed;
				continue;
			}
			const last = url[url.length - 1] ?? '';
			const open = CLOSING_BRACKETS[last];
			if (!open || countChar(url, last) <= countChar(url, open)) break;
			// Rule: 只裁掉多余的闭合括号；正文自带成对括号的链接（如 Wikipedia）保持完整。
			url = url.slice(0, -1);
		}
		if (!url || seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

/**
 * Flow: 用 Obsidian requestUrl 逐个读取链接（一次性响应，绕过浏览器跨域限制），抽取正文后按额度截断。
 * Failure: 数量超限、网络错误、非 2xx、非文本页面或空正文都直接抛错，由调用方提示，不静默跳过。
 * Effect: text 以 `…` 结尾表示截断；title 允许为空字符串。
 */
export async function readWebPages(urls: string[], signal: AbortSignal): Promise<WebPage[]> {
	if (!urls.length) return [];
	if (urls.length > MAX_LINKS) throw new Error(`一次最多读取 ${MAX_LINKS} 个链接，请减少后重试`);
	const budget = Math.floor(WEB_TEXT_LIMIT / urls.length);
	const pages: WebPage[] = [];
	for (const url of urls) {
		if (signal.aborted) throw new Error('改写已取消');
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({ url, method: 'GET', throw: false });
		} catch {
			// Failure: 不暴露底层异常正文；回显链接方便用户核对。
			throw new Error(`无法读取链接（网络错误）：${url}`);
		}
		// Failure: requestUrl 不支持中途取消，只能取消后丢弃结果，避免把半程内容发出去。
		if (signal.aborted) throw new Error('改写已取消');
		if (response.status < 200 || response.status >= 300) throw new Error(`链接返回 HTTP ${response.status}：${url}`);
		if (response.text.length > MAX_HTML_CHARS) throw new Error(`网页内容过大（超过 ${MAX_HTML_CHARS / 1_000_000} MB）：${url}`);
		const type = headerValue(response.headers, 'content-type').toLowerCase();
		const html = !type || type.includes('html') || type.includes('xhtml');
		if (!html && !type.startsWith('text/')) {
			throw new Error(`链接不是网页文本（${type.split(';')[0]?.trim() || '未知类型'}）：${url}`);
		}
		const raw = decodeBody(response, type);
		const page = html ? extractReadableText(raw) : { title: '', text: normalizeText(raw) };
		if (!page.text) throw new Error(`网页没有可读正文（可能需要登录或动态渲染）：${url}`);
		pages.push({ url, title: page.title, text: clipText(page.text, budget) });
	}
	return pages;
}

/** Flow: 抽取标题和可读正文；正文优先取唯一的 article，其次 main，再次 body。 */
export function extractReadableText(html: string): { title: string; text: string } {
	const title = extractTitle(html);
	const body = html.replace(COMMENT, ' ').replace(NOISE_BLOCK, ' ').replace(NOISE_OPEN, ' ');
	const region = pickRegion(body);
	const withBreaks = region.replace(LINE_BREAK, '\n').replace(BLOCK_END, '\n');
	return { title, text: normalizeText(decodeEntities(withBreaks.replace(TAG, ' '))) };
}

const COMMENT = /<!--[\s\S]*?-->/g;
const NOISE_BLOCK = /<(script|style|noscript|template|svg|canvas|iframe|object|embed|nav|aside|footer|form|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const NOISE_OPEN = /<(script|style|noscript|template|svg|canvas|iframe|object|embed|nav|aside|footer|form|head)\b[^>]*\/?>/gi;
const LINE_BREAK = /<(?:br|hr)\b[^>]*\/?>/gi;
const BLOCK_END = /<\/(?:p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|blockquote|pre|figure|figcaption|dd|dt|dl|header|main|details)\s*>/gi;
const TAG = /<[^>]*>/g;
const ARTICLE = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi;
const MAIN = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i;
const BODY = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const H1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i;

/** Rule: 单个 article 视为正文；多个 article 可能是列表页，退回到 main/body 保留全部条目。 */
function pickRegion(html: string): string {
	const articles = [...html.matchAll(ARTICLE)];
	if (articles.length === 1) return articles[0]?.[1] ?? html;
	const main = MAIN.exec(html)?.[1];
	if (main) return main;
	return BODY.exec(html)?.[1] ?? html;
}

function extractTitle(html: string): string {
	const raw = TITLE.exec(html)?.[1] ?? H1.exec(html)?.[1] ?? '';
	return clipLine(decodeEntities(raw.replace(TAG, ' ')), 200);
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
	hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
	lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
	copy: '©', reg: '®', trade: '™', times: '×', deg: '°', plusmn: '±',
	euro: '€', pound: '£', yen: '¥', sect: '§', para: '¶',
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
		.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function codePoint(value: number): string {
	return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

function normalizeText(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[^\S\n]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

const CHARSET = /charset\s*=\s*["']?([\w-]+)/i;

/**
 * Flow: 按响应头或 <meta charset> 的编码重解码正文；requestUrl 的 text 固定按 UTF-8 解码，GBK 老站会乱码。
 * Failure: 编码标签无效时回退到 requestUrl 已解码的 text，不抛出。
 */
function decodeBody(response: RequestUrlResponse, contentType: string): string {
	const label = normalizeCharset(CHARSET.exec(contentType)?.[1] ?? metaCharset(response.arrayBuffer));
	try {
		return new TextDecoder(label).decode(response.arrayBuffer);
	} catch {
		return response.text;
	}
}

function metaCharset(buffer: ArrayBuffer): string | undefined {
	const head = new TextDecoder('latin1').decode(buffer.slice(0, 4096));
	return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
}

function normalizeCharset(label: string | undefined): string {
	const value = label?.trim().toLowerCase().replace(/^["']|["']$/g, '') ?? '';
	if (!value) return 'utf-8';
	return ['gb2312', 'gbk', 'gb18030'].includes(value) ? 'gb18030' : value;
}

function clipLine(text: string, limit: number): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length <= limit ? line : `${line.slice(0, limit)}…`;
}

/** Rule: 截断优先落在段落边界；没有合适换行时按字符额度硬截，`…` 表示省略。 */
function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const cut = text.lastIndexOf('\n', limit);
	return `${text.slice(0, cut >= limit / 2 ? cut : limit)}…`;
}

function countChar(text: string, char: string): number {
	let total = 0;
	for (const value of text) {
		if (value === char) total++;
	}
	return total;
}

function headerValue(headers: Record<string, string>, name: string): string {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	return key ? headers[key] ?? '' : '';
}
