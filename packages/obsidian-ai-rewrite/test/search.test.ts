import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearchArgs, searchWeb } from '../src/search';
import { setRequestUrlHandler, type RequestUrlHandler } from './obsidian-stub';

const options = { apiKey: 'tvly-secret', endpoint: 'https://api.tavily.com/search', signal: new AbortController().signal };

async function withRequestUrl(handler: RequestUrlHandler | null, run: () => Promise<void>): Promise<void> {
	setRequestUrlHandler(handler);
	try {
		await run();
	} finally {
		setRequestUrlHandler(null);
	}
}

test('search args keep query, topic and time range, and reject invalid values', async () => {
	assert.deepEqual(parseSearchArgs('{"query":" 今日新闻 ","topic":"news","timeRange":"day"}'), {
		query: '今日新闻',
		topic: 'news',
		timeRange: 'day',
	});
	assert.deepEqual(parseSearchArgs('{"query":"x"}'), { query: 'x', topic: 'general' });
	await assert.rejects(async () => parseSearchArgs('not json'), /有效 JSON/);
	await assert.rejects(async () => parseSearchArgs('[]'), /必须是对象/);
	await assert.rejects(async () => parseSearchArgs('{"query":"  "}'), /缺少查询词/);
	await assert.rejects(async () => parseSearchArgs('{"query":"x","topic":"video"}'), /主题无效/);
	await assert.rejects(async () => parseSearchArgs('{"query":"x","timeRange":"hour"}'), /时间范围无效/);
});

test('searchWeb posts Tavily parameters and compacts the response', async () => {
	const sent: { url: string; method?: string; authorization?: string; body?: string } = { url: '' };
	await withRequestUrl(async (param) => {
		sent.url = param.url;
		sent.method = param.method;
		sent.authorization = param.headers?.Authorization;
		sent.body = param.body as string;
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({
				query: '今日新闻',
				results: [
					{ title: ' 标题 ', url: ' https://news.example/1 ', content: ' 摘要 ', score: 0.9, published_date: '2026-09-28T00:00:00Z' },
					{ title: '没有链接', content: '忽略' },
				],
			}),
		};
	}, async () => {
		const response = await searchWeb({ query: '今日新闻', topic: 'news', timeRange: 'day' }, options);
		assert.deepEqual(response, {
			query: '今日新闻',
			results: [{
				title: '标题',
				url: 'https://news.example/1',
				content: '摘要',
				score: 0.9,
				publishedDate: '2026-09-28T00:00:00Z',
			}],
		});
	});
	assert.equal(sent.url, 'https://api.tavily.com/search');
	assert.equal(sent.method, 'POST');
	assert.equal(sent.authorization, 'Bearer tvly-secret');
	assert.deepEqual(JSON.parse(sent.body as string), {
		query: '今日新闻',
		search_depth: 'basic',
		max_results: 5,
		include_answer: false,
		include_raw_content: false,
		include_published_date: true,
		topic: 'news',
		time_range: 'day',
	});
});

test('search failures expose the Tavily message or the status code', async () => {
	await withRequestUrl(async () => ({
		status: 401,
		headers: {},
		text: '{"detail":{"error":"Unauthorized: missing or invalid API key."}}',
	}), async () => {
		await assert.rejects(searchWeb({ query: 'q', topic: 'general' }, options), /HTTP 401.*Unauthorized/);
	});
	await withRequestUrl(async () => ({ status: 429, headers: {}, text: '<html>rate limited</html>' }), async () => {
		await assert.rejects(searchWeb({ query: 'q', topic: 'general' }, options), /HTTP 429/);
	});
	await withRequestUrl(async () => { throw new Error('ECONNREFUSED'); }, async () => {
		await assert.rejects(searchWeb({ query: 'q', topic: 'general' }, options), /无法连接联网搜索服务/);
	});
	await withRequestUrl(async () => ({ status: 200, headers: {}, text: 'not json' }), async () => {
		await assert.rejects(searchWeb({ query: 'q', topic: 'general' }, options), /无效数据/);
	});
	const aborted = new AbortController();
	aborted.abort();
	await withRequestUrl(async () => ({ status: 200, headers: {}, text: '{"results":[]}' }), async () => {
		await assert.rejects(searchWeb({ query: 'q', topic: 'general' }, { ...options, signal: aborted.signal }), /已取消/);
	});
});
