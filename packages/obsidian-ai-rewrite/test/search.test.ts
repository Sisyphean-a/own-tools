import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearchArgs, searchWeb } from '../src/search';
import { setRequestUrlHandler, type RequestUrlHandler } from './obsidian-stub';

const options = { apiKey: 'deepseek-secret', endpoint: 'https://api.deepseek.com/v1/tools/search', signal: new AbortController().signal };

async function withRequestUrl(handler: RequestUrlHandler | null, run: () => Promise<void>): Promise<void> {
	setRequestUrlHandler(handler);
	try { await run(); } finally { setRequestUrlHandler(null); }
}

test('search args validate query and Unicode length', async () => {
	assert.deepEqual(parseSearchArgs('{"query":" 今日新闻 after:2026-01-01 "}'), { query: '今日新闻 after:2026-01-01' });
	assert.equal(parseSearchArgs(JSON.stringify({ query: '😀'.repeat(128) })).query.length, 256);
	await assert.rejects(async () => parseSearchArgs(JSON.stringify({ query: '😀'.repeat(129) })), /128/);
	await assert.rejects(async () => parseSearchArgs('not json'), /有效 JSON/);
	await assert.rejects(async () => parseSearchArgs('[]'), /必须是对象/);
	await assert.rejects(async () => parseSearchArgs('{"query":"  "}'), /缺少查询词/);
});

test('searchWeb posts DeepSeek parameters and maps summaries', async () => {
	await withRequestUrl(async (param) => {
		assert.equal(param.url, options.endpoint);
		assert.equal(param.method, 'POST');
		assert.equal(param.headers?.Authorization, 'Bearer deepseek-secret');
		assert.deepEqual(JSON.parse(param.body as string), { query: '今日新闻', count: 5, need_content: false });
		return { status: 200, headers: {}, text: JSON.stringify({ results: [
			{ title: ' 标题 ', url: ' https://news.example/1 ', summary: ' 摘要 ', rerank_score: 2.4, date: '2026-09-28T00:00:00Z' },
			{ title: '没有链接' },
		] }) };
	}, async () => {
		assert.deepEqual(await searchWeb({ query: '今日新闻' }, options), { query: '今日新闻', results: [{
			title: '标题', url: 'https://news.example/1', content: '摘要', score: 2.4, publishedDate: '2026-09-28T00:00:00Z',
		}] });
	});
	await withRequestUrl(async () => ({ status: 200, headers: {}, text: '{"results":[]}' }), async () => {
		assert.deepEqual((await searchWeb({ query: 'q' }, options)).results, []);
	});
});

test('search failures expose errors and never treat invalid data as empty results', async () => {
	await withRequestUrl(async () => ({ status: 401, headers: {}, text: '{"error":{"message":"Invalid API key"}}' }), async () => {
		await assert.rejects(searchWeb({ query: 'q' }, options), /HTTP 401.*Invalid API key/);
	});
	await withRequestUrl(async () => ({ status: 429, headers: {}, text: '<html>rate limited</html>' }), async () => {
		await assert.rejects(searchWeb({ query: 'q' }, options), /HTTP 429/);
	});
	await withRequestUrl(async () => { throw new Error('ECONNREFUSED'); }, async () => {
		await assert.rejects(searchWeb({ query: 'q' }, options), /无法连接联网搜索服务/);
	});
	for (const text of ['not json', '{}']) {
		await withRequestUrl(async () => ({ status: 200, headers: {}, text }), async () => {
			await assert.rejects(searchWeb({ query: 'q' }, options), /无效数据/);
		});
	}
	const aborted = new AbortController(); aborted.abort();
	await withRequestUrl(async () => ({ status: 200, headers: {}, text: '{"results":[]}' }), async () => {
		await assert.rejects(searchWeb({ query: 'q' }, { ...options, signal: aborted.signal }), /已取消/);
	});
});
