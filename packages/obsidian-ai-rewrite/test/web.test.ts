import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WEB_TEXT_LIMIT, extractReadableText, extractUrls, readWebPages } from '../src/web';
import { setRequestUrlHandler, type RequestUrlHandler, type RequestUrlResponse } from './obsidian-stub';

function respond(text: string, contentType = 'text/html; charset=utf-8', status = 200, bytes?: Uint8Array): RequestUrlResponse {
	return { status, headers: { 'Content-Type': contentType }, text, arrayBuffer: bytes?.buffer ?? new TextEncoder().encode(text).buffer };
}

async function withRequestUrl(handler: RequestUrlHandler | null, run: () => Promise<void>): Promise<void> {
	setRequestUrlHandler(handler);
	try {
		await run();
	} finally {
		setRequestUrlHandler(null);
	}
}

test('url extraction keeps real links and drops punctuation or markdown wrappers', () => {
	assert.deepEqual(extractUrls('帮我看看 https://example.com/a?x=1。谢谢'), ['https://example.com/a?x=1']);
	assert.deepEqual(extractUrls('[标题](https://example.com/a) 和 <https://example.com/b>'), ['https://example.com/a', 'https://example.com/b']);
	assert.deepEqual(extractUrls('https://en.wikipedia.org/wiki/DeepSeek_(company)'), ['https://en.wikipedia.org/wiki/DeepSeek_(company)']);
	assert.deepEqual(extractUrls('见 https://example.com/a. 以及 https://example.com/a'), ['https://example.com/a']);
	assert.deepEqual(extractUrls('没有链接，只有 ftp://example.com'), []);
});

test('readable text keeps the title and paragraphs, and drops scripts and chrome', () => {
	const html = '<!doctype html><html><head><title>标题 &amp; 副题</title><style>p{color:red}</style>' +
		'<script>const marker = "</article>";</script></head><body><nav>菜单</nav><main><h1>大标题</h1>' +
		'<p>第一段&nbsp;内容</p><p>第二段&hellip;</p><ul><li>条目</li></ul></main><footer>页脚</footer></body></html>';
	const page = extractReadableText(html);
	assert.equal(page.title, '标题 & 副题');
	assert.equal(page.text, '大标题\n第一段 内容\n第二段…\n条目');
	assert.doesNotMatch(page.text, /菜单|页脚|color:red|marker/);
});

test('a single article is preferred over surrounding chrome, otherwise main is used', () => {
	const article = extractReadableText('<body><header>站名</header><nav>菜单</nav><article><p>正文段落</p></article><aside>推荐</aside></body>');
	assert.equal(article.text, '正文段落');
	const multiple = extractReadableText('<body><main><article>第一篇</article><article>第二篇</article></main></body>');
	assert.equal(multiple.text, '第一篇\n第二篇');
});

test('linked pages are fetched with GET and clipped to a shared budget', async () => {
	const article = `<html><body><article><h1>长文</h1>${'<p>段落内容</p>'.repeat(2000)}</article></body></html>`;
	const sent: { url: string; method?: string }[] = [];
	await withRequestUrl(async (param) => {
		sent.push(param);
		return respond(article);
	}, async () => {
		const pages = await readWebPages(['https://a.example/1', 'https://b.example/2'], new AbortController().signal);
		assert.deepEqual(sent.map((param) => param.method), ['GET', 'GET']);
		assert.deepEqual(sent.map((param) => param.url), ['https://a.example/1', 'https://b.example/2']);
		assert.equal(pages.length, 2);
		assert.equal(pages[0]?.url, 'https://a.example/1');
		assert.equal(pages[0]?.title, '长文');
		assert.ok((pages[0]?.text.length ?? 0) <= WEB_TEXT_LIMIT / 2 + 1);
		assert.ok(pages[0]?.text.endsWith('…'));
		assert.ok(pages.every((page) => !page.text.includes('<') && !/\n{3,}/.test(page.text)));
	});
});

test('plain text and missing content types stay readable', async () => {
	await withRequestUrl(async () => respond('第一行\n\n\n第二行', 'text/plain; charset=utf-8'), async () => {
		const [page] = await readWebPages(['https://a.example/1'], new AbortController().signal);
		assert.equal(page?.title, '');
		assert.equal(page?.text, '第一行\n\n第二行');
	});
	await withRequestUrl(async () => respond('<body><p>无类型</p></body>', ''), async () => {
		const [page] = await readWebPages(['https://a.example/1'], new AbortController().signal);
		assert.equal(page?.text, '无类型');
	});
});

test('gbk pages are decoded from the header or meta charset', async () => {
	const gbk = [0xd6, 0xd0, 0xce, 0xc4];
	const prefix = new TextEncoder().encode('<body><p>');
	const suffix = new TextEncoder().encode('</p></body>');
	const body = new Uint8Array([...prefix, ...gbk, ...suffix]);
	await withRequestUrl(async () => respond('乱码', 'text/html; charset=gbk', 200, body), async () => {
		const [page] = await readWebPages(['https://a.example/1'], new AbortController().signal);
		assert.equal(page?.text, '中文');
	});
	const withMeta = new Uint8Array([...new TextEncoder().encode('<head><meta charset="gbk"></head><body><p>'), ...gbk, ...suffix]);
	await withRequestUrl(async () => respond('乱码', 'text/html', 200, withMeta), async () => {
		const [page] = await readWebPages(['https://a.example/1'], new AbortController().signal);
		assert.equal(page?.text, '中文');
	});
});

test('fetch failures stay explicit instead of being skipped', async () => {
	const signal = new AbortController().signal;
	await withRequestUrl(async () => respond('missing', 'text/html', 404), async () => {
		await assert.rejects(readWebPages(['https://a.example/1'], signal), /HTTP 404.*a\.example/);
	});
	await withRequestUrl(async () => { throw new Error('ECONNREFUSED'); }, async () => {
		await assert.rejects(readWebPages(['https://a.example/1'], signal), /网络错误/);
	});
	await withRequestUrl(async () => respond('%PDF', 'application/pdf'), async () => {
		await assert.rejects(readWebPages(['https://a.example/1'], signal), /不是网页文本/);
	});
	await withRequestUrl(async () => respond('   '), async () => {
		await assert.rejects(readWebPages(['https://a.example/1'], signal), /没有可读正文/);
	});
	await withRequestUrl(null, async () => {
		await assert.rejects(
			readWebPages(['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4'], signal),
			/最多读取 3 个链接/,
		);
	});
	const aborted = new AbortController();
	aborted.abort();
	await withRequestUrl(async () => respond('<body>正文</body>'), async () => {
		await assert.rejects(readWebPages(['https://a.example/1'], aborted.signal), /已取消/);
	});
});
