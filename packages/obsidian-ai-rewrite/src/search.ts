import { requestUrl, type RequestUrlResponse } from 'obsidian';

export const DEFAULT_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
export const SEARCH_TOOL_NAME = 'web_search';

export interface SearchRequest {
	query: string;
}

export interface SearchResult {
	title: string;
	url: string;
	content: string;
	score: number;
	publishedDate?: string;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
}

export interface SearchOptions {
	apiKey: string;
	endpoint: string;
	signal: AbortSignal;
}

export const WEB_SEARCH_TOOL = {
	type: 'function',
	function: {
		name: SEARCH_TOOL_NAME,
		description: '联网检索公开网页。需要最新信息、外部事实或用户要求联网时调用；时效性问题在 query 中使用 after:YYYY-MM-DD 或 before:YYYY-MM-DD 限定日期。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '搜索词，最多 128 个字符；支持 site:、lang:、after: 和 before: 等搜索语法。' },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
} as const;

/** Flow: 校验模型给出的工具参数。 */
export function parseSearchArgs(argumentsJson: string): SearchRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		throw new Error('联网搜索参数不是有效 JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('联网搜索参数必须是对象');
	const { query } = parsed as { query?: unknown };
	if (typeof query !== 'string' || !query.trim()) throw new Error('联网搜索缺少查询词');
	if (Array.from(query.trim()).length > 128) throw new Error('联网搜索查询词不能超过 128 个字符');
	return { query: query.trim() };
}

export async function searchWeb(request: SearchRequest, options: SearchOptions): Promise<SearchResponse> {
	const body = JSON.stringify({
		query: request.query,
		count: 5,
		need_content: false,
	});
	let response: RequestUrlResponse;
	try {
		// Rule: 与链接读取一致，用 requestUrl 绕过浏览器跨域限制。Failure: 它不支持中途取消，取消只影响后续轮次。
		response = await requestUrl({
			url: options.endpoint,
			method: 'POST',
			headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
			body,
			throw: false,
		});
	} catch {
		throw new Error(options.signal.aborted ? '改写已取消' : '无法连接联网搜索服务，请检查网络与接口地址');
	}
	if (options.signal.aborted) throw new Error('改写已取消');
	if (response.status < 200 || response.status >= 300) {
		const detail = errorDetail(response.text);
		throw new Error(`联网搜索失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(response.text);
	} catch {
		throw new Error('联网搜索返回了无效数据');
	}
	return compactSearchResponse(request.query, payload);
}

function compactSearchResponse(query: string, payload: unknown): SearchResponse {
	if (typeof payload !== 'object' || payload === null) throw new Error('联网搜索返回了无效数据');
	const raw = payload as { results?: unknown };
	if (!Array.isArray(raw.results)) throw new Error('联网搜索返回了无效数据');
	const items = raw.results;
	const results: SearchResult[] = [];
	for (const item of items) {
		if (typeof item !== 'object' || item === null) continue;
		const value = item as { title?: unknown; url?: unknown; summary?: unknown; snippet?: unknown; rerank_score?: unknown; date?: unknown };
		const url = typeof value.url === 'string' ? value.url.trim() : '';
		if (!url) continue;
		const publishedDate = typeof value.date === 'string' ? value.date.trim() : '';
		results.push({
			title: typeof value.title === 'string' ? value.title.trim() : '',
			url,
			content: typeof value.summary === 'string' && value.summary.trim() ? value.summary.trim() : typeof value.snippet === 'string' ? value.snippet.trim() : '',
			score: typeof value.rerank_score === 'number' ? value.rerank_score : 0,
			...(publishedDate ? { publishedDate } : {}),
		});
	}
	return { query, results };
}

/** Flow: 尽量取出搜索服务的错误说明；正文不是 JSON 时只保留状态码。 */
function errorDetail(text: string): string {
	try {
		const payload = JSON.parse(text) as { detail?: unknown; error?: unknown };
		const detail = payload.detail ?? payload.error;
		if (typeof detail === 'string') return detail.trim().slice(0, 200);
		if (typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string') {
			return detail.message.trim().slice(0, 200);
		}
	} catch {
		// Failure: 错误正文无法解析时忽略。
	}
	return '';
}
