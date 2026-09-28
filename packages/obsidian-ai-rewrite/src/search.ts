import { requestUrl, type RequestUrlResponse } from 'obsidian';

export const DEFAULT_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
export const SEARCH_TOOL_NAME = 'web_search';

export type SearchTopic = 'general' | 'news' | 'finance';
export type SearchTimeRange = 'day' | 'week' | 'month' | 'year';

export interface SearchRequest {
	query: string;
	topic: SearchTopic;
	timeRange?: SearchTimeRange;
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

/** Rule: 工具参数与 dsChat 的 tavily_search 保持一致（query/topic/timeRange），便于两个项目迁移与对照。 */
export const WEB_SEARCH_TOOL = {
	type: 'function',
	function: {
		name: SEARCH_TOOL_NAME,
		description: '联网检索公开网页。需要最新信息、外部事实或用户要求联网时调用；时效性问题用 timeRange 限定时间，新闻用 topic=news。',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: '要搜索的问题或关键词。' },
				topic: { type: 'string', enum: ['general', 'news', 'finance'], description: '搜索主题，默认 general。' },
				timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '按发布日期过滤的时间范围。' },
			},
			required: ['query'],
			additionalProperties: false,
		},
	},
} as const;

const TOPICS: readonly SearchTopic[] = ['general', 'news', 'finance'];
const TIME_RANGES: readonly SearchTimeRange[] = ['day', 'week', 'month', 'year'];

/** Flow: 校验模型给出的工具参数。 */
export function parseSearchArgs(argumentsJson: string): SearchRequest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		throw new Error('联网搜索参数不是有效 JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('联网搜索参数必须是对象');
	const { query, topic, timeRange } = parsed as { query?: unknown; topic?: unknown; timeRange?: unknown };
	if (typeof query !== 'string' || !query.trim()) throw new Error('联网搜索缺少查询词');
	if (topic !== undefined && !TOPICS.includes(topic as SearchTopic)) throw new Error('联网搜索主题无效，只支持 general/news/finance');
	if (timeRange !== undefined && !TIME_RANGES.includes(timeRange as SearchTimeRange)) {
		throw new Error('联网搜索时间范围无效，只支持 day/week/month/year');
	}
	return {
		query: query.trim(),
		topic: (topic as SearchTopic | undefined) ?? 'general',
		...(timeRange ? { timeRange: timeRange as SearchTimeRange } : {}),
	};
}

export async function searchWeb(request: SearchRequest, options: SearchOptions): Promise<SearchResponse> {
	const body = JSON.stringify({
		query: request.query,
		search_depth: 'basic',
		max_results: 5,
		include_answer: false,
		include_raw_content: false,
		include_published_date: true,
		topic: request.topic,
		...(request.timeRange ? { time_range: request.timeRange } : {}),
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
	const raw = payload as { query?: unknown; results?: unknown };
	const items = Array.isArray(raw.results) ? raw.results : [];
	const results: SearchResult[] = [];
	for (const item of items) {
		if (typeof item !== 'object' || item === null) continue;
		const value = item as { title?: unknown; url?: unknown; content?: unknown; score?: unknown; published_date?: unknown };
		const url = typeof value.url === 'string' ? value.url.trim() : '';
		if (!url) continue;
		const publishedDate = typeof value.published_date === 'string' ? value.published_date.trim() : '';
		results.push({
			title: typeof value.title === 'string' ? value.title.trim() : '',
			url,
			content: typeof value.content === 'string' ? value.content.trim() : '',
			score: typeof value.score === 'number' ? value.score : 0,
			...(publishedDate ? { publishedDate } : {}),
		});
	}
	return { query: typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim() : query, results };
}

/** Flow: 尽量取出 Tavily 的错误说明；正文不是 JSON 时只保留状态码。 */
function errorDetail(text: string): string {
	try {
		const payload = JSON.parse(text) as { detail?: unknown; error?: unknown };
		const detail = payload.detail ?? payload.error;
		if (typeof detail === 'string') return detail.trim().slice(0, 200);
		if (typeof detail === 'object' && detail !== null && 'error' in detail && typeof detail.error === 'string') {
			return detail.error.trim().slice(0, 200);
		}
	} catch {
		// Failure: 错误正文无法解析时忽略。
	}
	return '';
}
