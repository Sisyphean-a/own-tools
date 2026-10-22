import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatCurrentTime, streamRewrite, validateSettings, type StreamSink } from '../src/ai';
import { DEFAULT_SETTINGS } from '../src/settings';
import { setRequestUrlHandler, type RequestUrlHandler, type RequestUrlResponse } from './obsidian-stub';

// Effect: 测试产物是 ESM，没有 window.require/window 计时器；模拟渲染进程的 window。
Object.assign(globalThis, { window: { require: createRequire(import.meta.url), setInterval, clearInterval, setTimeout, clearTimeout } });

const settings = { ...DEFAULT_SETTINGS, apiKey: 'secret' };
const searchSettings = { ...settings, searchEnabled: true, searchApiKey: 'tvly-key' };

function stream(parts: Uint8Array[]): Response {
	return new Response(new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	}));
}

function chunkEvent(delta: unknown, finish: string | null = null): string {
	return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
}

const DONE = 'data: [DONE]\n\n';

function createSink(chunks: string[] = []) {
	let resetCount = 0;
	const reasoning: string[] = [];
	const progress: { id: string; text: string; done: boolean }[] = [];
	const sink: StreamSink = {
		delta: (text) => { chunks.push(text); },
		reset: () => { chunks.length = 0; resetCount += 1; },
		reasoning: (text) => { reasoning.push(text); },
		progress: (id, text, done) => { progress.push({ id, text, done }); },
	};
	return { sink, chunks, reasoning, progress, resets: () => resetCount };
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
	const previous = globalThis.fetch;
	globalThis.fetch = mock;
	try { await run(); } finally { globalThis.fetch = previous; }
}

async function withRequestUrl(handler: RequestUrlHandler | null, run: () => Promise<void>): Promise<void> {
	setRequestUrlHandler(handler);
	try {
		await run();
	} finally {
		setRequestUrlHandler(null);
	}
}

function searchResponse(results: unknown): RequestUrlResponse {
	return { status: 200, headers: {}, text: JSON.stringify({ query: 'q', results }) };
}

test('DeepSeek SSE chunks, split UTF-8 and image parts keep text and image together', async () => {
	assert.equal(settings.model, 'deepseek-flash');
	const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
	const split = bytes.indexOf(228) + 1;
	let sent: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		sent = init;
		return stream([bytes.slice(0, split), bytes.slice(split)]);
	}, async () => {
		const chunks: string[] = [];
		const { sink } = createSink(chunks);
		const result = await streamRewrite(settings, '原文', null, '改通顺', ['data:image/png;base64,AAAA'], [], sink, new AbortController().signal);
		assert.equal(result, '你好');
		assert.deepEqual(chunks, ['你', '好']);
	});
	assert.ok(sent);
	const body = JSON.parse(sent.body as string) as { stream: boolean; model: string; messages: { content: unknown }[] };
	assert.equal(body.stream, true);
	assert.equal('reasoning_effort' in body, false);
	assert.equal('tools' in body, false);
	assert.deepEqual(body.messages[1]!.content, [
		{ type: 'text', text: JSON.stringify({ instruction: '改通顺', selectedText: '原文' }) },
		{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
	]);
	assert.ok(!(sent.body as string).includes('secret'));
	assert.equal((sent.headers as Record<string, string>).Authorization, 'Bearer secret');
});

test('explicit thinking levels are sent as documented, without changing the default request', async () => {
	const sse = chunkEvent({ content: '结果' }, 'stop') + DONE;
	for (const effort of ['none', 'low', 'high', 'max'] as const) {
		let request: RequestInit | undefined;
		await withFetch(async (_url, init) => {
			request = init;
			return stream([new TextEncoder().encode(sse)]);
		}, async () => {
			assert.equal(await streamRewrite({ ...settings, reasoningEffort: effort }, '原文', null, '修改', [], [], createSink().sink, new AbortController().signal), '结果');
		});
		assert.equal(JSON.parse(request?.body as string).reasoning_effort, effort);
	}
	assert.match(validateSettings({ ...settings, reasoningEffort: 'invalid' as 'low' }) ?? '', /思考等级/);
	const savedBeforeUpgrade = { endpoint: 'https://example.com/v1/chat/completions', model: 'other-model', apiKey: 'old-key' };
	assert.deepEqual({ ...DEFAULT_SETTINGS, ...savedBeforeUpgrade }, {
		...savedBeforeUpgrade,
		reasoningEffort: 'default',
		contextLimit: 4000,
		searchEnabled: false,
		searchEndpoint: 'https://api.tavily.com/search',
		searchApiKey: '',
		fileReadScope: 'off',
		stylePreset: 'concise',
		styleScope: 'note',
	});
});

test('thinking tokens stay out of the rewrite preview and final note', async () => {
	const text = chunkEvent({ reasoning_content: '内部推理' }) + chunkEvent({ content: '最终文本' }, 'stop') + DONE;
	await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
		const { sink, chunks } = createSink();
		assert.equal(await streamRewrite({ ...settings, reasoningEffort: 'high' }, '原文', null, '修改', [], [], sink, new AbortController().signal), '最终文本');
		assert.deepEqual(chunks, ['最终文本']);
	});
});

test('empty selection sends generation instructions, and terminal DONE without blank line finishes', async () => {
	const text = chunkEvent({ content: '结果' }, 'stop') + 'data: [DONE]';
	await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
		assert.equal(await streamRewrite(settings, '', null, '写一句话', [], [], createSink().sink, new AbortController().signal), '结果');
	});
});

test('truncation and non-stop finish reasons reject partial text', async () => {
	for (const tail of ['', chunkEvent({}, 'length') + DONE]) {
		const text = chunkEvent({ content: '半截' }) + tail;
		await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
			await assert.rejects(streamRewrite(settings, '原文', null, '修改', [], [], createSink().sink, new AbortController().signal), /不完整/);
		});
	}
});

test('aborting after partial event rejects the in-flight response', async () => {
	const controller = new AbortController();
	const abortingSink: StreamSink = { delta: () => controller.abort(), reset: () => {}, reasoning: () => {}, progress: () => {} };
	await withFetch(async () => new Response(new ReadableStream({
		start(streamController) {
			streamController.enqueue(new TextEncoder().encode(chunkEvent({ content: '部分' })));
			controller.signal.addEventListener('abort', () => streamController.error(new DOMException('Aborted', 'AbortError')));
		},
	})), async () => {
		await assert.rejects(streamRewrite(settings, '原文', null, '修改', [], [], abortingSink, controller.signal), /已取消/);
	});
});

test('editor state error is not masked as a network failure', async () => {
	const text = chunkEvent({ content: '字' });
	const failingSink: StreamSink = { delta: () => { throw new Error('原文已变化'); }, reset: () => {}, reasoning: () => {}, progress: () => {} };
	await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
		await assert.rejects(streamRewrite(settings, '原文', null, '修改', [], [], failingSink, new AbortController().signal), /原文已变化/);
	});
});

test('bad HTTP status, malformed events and invalid endpoint expose failure', async () => {
	assert.ok(validateSettings({ ...settings, endpoint: 'http://example.test/api' }));
	assert.ok(validateSettings({ ...settings, endpoint: 'https://secret:password@example.test/api' }));
	assert.equal(validateSettings({ ...settings, endpoint: 'http://localhost:11434/v1/chat/completions' }), null);
	await withFetch(async () => new Response('', { status: 401 }), async () => {
		await assert.rejects(streamRewrite(settings, '原文', null, '修改', [], [], createSink().sink, new AbortController().signal), /HTTP 401/);
	});
	await withFetch(async () => stream([new TextEncoder().encode('data: broken\n\n')]), async () => {
		await assert.rejects(streamRewrite(settings, '原文', null, '修改', [], [], createSink().sink, new AbortController().signal), /无效的流数据/);
	});
});

test('context travels with the request without repeating the selection', async () => {
	const sse = chunkEvent({ content: '结果' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		assert.equal(await streamRewrite(settings, '原文', { before: '上一段\n', after: '\n下一段' }, '改通顺', [], [], createSink().sink, new AbortController().signal), '结果');
	});
	const sent = JSON.parse(request?.body as string) as { messages: { content: string }[] };
	assert.deepEqual(JSON.parse(sent.messages[1]!.content), {
		instruction: '改通顺',
		selectedText: '原文',
		contextBefore: '上一段\n',
		contextAfter: '\n下一段',
	});
	assert.match(sent.messages[0]!.content, /contextBefore/);

	let empty: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		empty = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		await streamRewrite(settings, '', { before: '', after: '' }, '写一句', [], [], createSink().sink, new AbortController().signal);
	});
	const body = JSON.parse(empty?.body as string) as { messages: { content: string }[] };
	assert.deepEqual(JSON.parse(body.messages[1]!.content), { instruction: '写一句', selectedText: '' });
});

test('style samples and shape rules travel by default, and concise drops decoration', async () => {
	const sse = chunkEvent({ content: '## 接口\n- 入参 `id`' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		await streamRewrite(settings, '', { before: '', after: '', samples: ['## 1. 包身份\n1. 应用名改成 `LuckyCrédito`'] }, '补一段接口说明', [], [], createSink().sink, new AbortController().signal);
	});
	const body = JSON.parse(request?.body as string) as { messages: { content: string }[] };
	assert.deepEqual(JSON.parse(body.messages[1]!.content), {
		instruction: '补一段接口说明',
		selectedText: '',
		styleSamples: ['## 1. 包身份\n1. 应用名改成 `LuckyCrédito`'],
	});
	const system = body.messages[0]!.content;
	assert.match(system, /styleSamples/);
	assert.match(system, /不输出 `#` 一级标题/);
	assert.match(system, /优先已有形态/);
	assert.match(system, /信息密度优先/);
	assert.match(system, /不用加粗/);
	assert.match(validateSettings({ ...settings, stylePreset: 'bad' as 'concise' }) ?? '', /写作风格/);
	assert.match(validateSettings({ ...settings, styleScope: 'bad' as 'note' }) ?? '', /风格参考范围/);
});

test('generic style keeps shape rules but drops the density preferences', async () => {
	const sse = chunkEvent({ content: '## 小节\n正文' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		await streamRewrite({ ...settings, stylePreset: 'generic' }, '', null, '补一段说明', [], [], createSink().sink, new AbortController().signal);
	});
	const body = JSON.parse(request?.body as string) as { messages: { content: string }[] };
	const system = body.messages[0]!.content;
	assert.match(system, /不输出 `#` 一级标题/);
	assert.match(system, /优先已有形态/);
	assert.equal(system.includes('信息密度优先'), false);
	assert.equal('styleSamples' in (JSON.parse(body.messages[1]!.content) as object), false);
});

test('history turns replay as conversation messages before the current request', async () => {
	const sse = chunkEvent({ content: '又短又有结论' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		await streamRewrite(
			settings,
			'短版本',
			{ before: '', after: '', history: [{ instruction: '先写短一点', result: '短版本' }] },
			'再补一条结论',
			[],
			[],
			createSink().sink,
			new AbortController().signal,
		);
	});
	const body = JSON.parse(request?.body as string) as { messages: { role: string; content: unknown }[] };
	assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
	assert.equal(body.messages[1]!.content, '先写短一点');
	assert.equal(body.messages[2]!.content, '短版本');
	assert.deepEqual(JSON.parse(body.messages[3]!.content as string), { instruction: '再补一条结论', selectedText: '短版本' });
	assert.match(String(body.messages[0]!.content), /history/);
});

test('web pages travel with the request as reference material', async () => {
	const sse = chunkEvent({ content: '结果' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		const pages = [{ url: 'https://example.com/a', title: '标题', text: '正文…' }];
		assert.equal(await streamRewrite(settings, '', null, '这个链接讲了什么', [], pages, createSink().sink, new AbortController().signal), '结果');
	});
	const sent = JSON.parse(request?.body as string) as { messages: { content: string }[] };
	assert.deepEqual(JSON.parse(sent.messages[1]!.content), {
		instruction: '这个链接讲了什么',
		selectedText: '',
		webPages: [{ url: 'https://example.com/a', title: '标题', text: '正文…' }],
	});
	assert.match(sent.messages[0]!.content, /webPages/);
});

test('web_search tool calls run between rounds and reasoning stays out of the result', async () => {
	const first = [
		chunkEvent({ content: '我先查一下。', reasoning_content: '需要联网' }),
		chunkEvent({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"今日新' } }] }),
		chunkEvent({ tool_calls: [{ index: 0, function: { arguments: '闻","topic":"news","timeRange":"day"}' } }] }, 'tool_calls'),
		DONE,
	].join('');
	const second = chunkEvent({ content: '今天的主要新闻是…' }, 'stop') + DONE;
	const requests: string[] = [];
	await withFetch(async (_url, init) => {
		requests.push(init?.body as string);
		return stream([new TextEncoder().encode(requests.length === 1 ? first : second)]);
	}, async () => {
		await withRequestUrl(async (param) => {
			assert.equal(param.url, 'https://api.tavily.com/search');
			assert.equal(param.method, 'POST');
			assert.equal(param.headers?.Authorization, 'Bearer tvly-key');
			const body = JSON.parse(param.body as string) as { query: string; topic: string; time_range: string; search_depth: string };
			assert.deepEqual({ query: body.query, topic: body.topic, time_range: body.time_range, search_depth: body.search_depth }, {
				query: '今日新闻',
				topic: 'news',
				time_range: 'day',
				search_depth: 'basic',
			});
			return searchResponse([{ title: '新闻标题', url: 'https://news.example/1', content: '摘要', score: 0.9 }]);
		}, async () => {
			const { sink, chunks, reasoning, progress, resets } = createSink();
			const result = await streamRewrite(searchSettings, '', null, '整理今天的新闻', [], [], sink, new AbortController().signal);
			assert.equal(result, '今天的主要新闻是…');
			assert.deepEqual(chunks, ['今天的主要新闻是…']);
			assert.deepEqual(reasoning, ['需要联网']);
			assert.deepEqual(progress, [
				{ id: 'call_1', text: '正在联网检索：今日新闻', done: false },
				{ id: 'call_1', text: '联网检索完成，返回 1 条结果', done: true },
			]);
			assert.equal(resets(), 1);
		});
	});
	assert.equal(requests.length, 2);
	const body = JSON.parse(requests[1]!) as {
		tools?: unknown[];
		messages: { role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown[]; tool_call_id?: string }[];
	};
	assert.equal(Array.isArray(body.tools), true);
	assert.deepEqual(body.messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool']);
	assert.equal(body.messages[2]!.reasoning_content, '需要联网');
	assert.deepEqual(body.messages[2]!.tool_calls, [{
		id: 'call_1',
		type: 'function',
		function: { name: 'web_search', arguments: '{"query":"今日新闻","topic":"news","timeRange":"day"}' },
	}]);
	assert.equal(body.messages[3]!.tool_call_id, 'call_1');
	assert.match(String(body.messages[3]!.content), /https:\/\/news\.example\/1/);
	assert.match(String(body.messages[0]!.content), /web_search/);
	assert.match(String(body.messages[0]!.content), /currentTime/);
	assert.match(
		(JSON.parse(String(body.messages[1]!.content)) as { currentTime?: string }).currentTime as string,
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（.+，.+，UTC[+-]\d{2}:\d{2}）$/,
	);
});

test('search failures cancel the request instead of answering without sources', async () => {
	const first = chunkEvent({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, 'tool_calls') + DONE;
	await withFetch(async () => stream([new TextEncoder().encode(first)]), async () => {
		await withRequestUrl(async () => ({
			status: 401,
			headers: {},
			text: '{"detail":{"error":"Unauthorized: missing or invalid API key."}}',
		}), async () => {
			await assert.rejects(
				streamRewrite(searchSettings, '', null, '查一下', [], [], createSink().sink, new AbortController().signal),
				/HTTP 401.*Unauthorized/,
			);
		});
	});
});

test('unknown tool calls are rejected', async () => {
	const unknown = chunkEvent({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'other_tool', arguments: '{}' } }] }, 'tool_calls') + DONE;
	await withFetch(async () => stream([new TextEncoder().encode(unknown)]), async () => {
		await assert.rejects(streamRewrite(searchSettings, '', null, 'x', [], [], createSink().sink, new AbortController().signal), /未支持的工具：other_tool/);
	});
});

test('exhausted search budget forces a final answer instead of failing the user', async () => {
	const endless = chunkEvent({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }] }, 'tool_calls') + DONE;
	const final = chunkEvent({ content: '基于已检索到的资料，结论是…' }, 'stop') + DONE;
	const requests: string[] = [];
	await withFetch(async (_url, init) => {
		requests.push(init?.body as string);
		return stream([new TextEncoder().encode(requests.length <= 10 ? endless : final)]);
	}, async () => {
		await withRequestUrl(async () => searchResponse([{ title: 't', url: 'https://a.example/1', content: 'c', score: 1 }]), async () => {
			const { sink, progress } = createSink();
			assert.equal(
				await streamRewrite(searchSettings, '', null, 'x', [], [], sink, new AbortController().signal),
				'基于已检索到的资料，结论是…',
			);
			assert.equal(progress.filter((entry) => entry.text.startsWith('正在联网检索：')).length, 10);
		});
	});
	assert.equal(requests.length, 11);
	const last = JSON.parse(requests[10]!) as { tools?: unknown[]; messages: { role: string; content?: unknown }[] };
	assert.equal('tools' in last, false);
	assert.match(String(last.messages.at(-1)?.content), /工具调用上限/);
});

test('search settings are validated before any request', async () => {
	assert.match(validateSettings({ ...searchSettings, searchApiKey: ' ' }) ?? '', /搜索 API 密钥/);
	assert.match(validateSettings({ ...searchSettings, searchEndpoint: 'http://example.test/search' }) ?? '', /HTTPS/);
	assert.equal(validateSettings({ ...searchSettings, searchEndpoint: 'http://127.0.0.1:8080/search' }), null);
	assert.match(validateSettings({ ...settings, fileReadScope: 'bad' as 'off' }) ?? '', /文件读取范围/);
});

test('a stalled stream is interrupted instead of hanging forever', async () => {
	const sse = chunkEvent({ content: '部分' });
	await withFetch(async () => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(sse));
		},
	})), async () => {
		await assert.rejects(
			streamRewrite(settings, '', null, 'x', [], [], createSink().sink, new AbortController().signal, { vaultRoot: '', desktop: false, stallTimeoutMs: 60 }),
			/没有收到任何新内容/,
		);
	});
});

test('current time carries weekday, timezone and offset', () => {
	assert.match(formatCurrentTime(new Date(2026, 8, 28, 15, 32, 5)), /^2026-09-28 15:32:05（.+，.+，UTC[+-]\d{2}:\d{2}）$/);
});

test('read_file tool calls read a local text file with a single progress row', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ai-rewrite-read-'));
	try {
		await writeFile(join(dir, 'notes.md'), '第一行\n第二行', 'utf8');
		const first = chunkEvent({ tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }] }, 'tool_calls') + DONE;
		const second = chunkEvent({ content: '文件里有两行。' }, 'stop') + DONE;
		const requests: string[] = [];
		await withFetch(async (_url, init) => {
			requests.push(init?.body as string);
			return stream([new TextEncoder().encode(requests.length === 1 ? first : second)]);
		}, async () => {
			const { sink, chunks, progress } = createSink();
			const result = await streamRewrite(
				{ ...settings, fileReadScope: 'vault' },
				'',
				null,
				'读一下 notes.md',
				[],
				[],
				sink,
				new AbortController().signal,
				{ vaultRoot: dir, desktop: true },
			);
			assert.equal(result, '文件里有两行。');
			assert.deepEqual(chunks, ['文件里有两行。']);
			assert.deepEqual(progress, [
				{ id: 'call_read', text: '正在读取文件：notes.md', done: false },
				{ id: 'call_read', text: '已读取 notes.md（第 1-2 行 / 共 2 行）', done: true },
			]);
		});
		const body = JSON.parse(requests[1]!) as { tools?: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] };
		assert.deepEqual(body.tools?.map((tool) => tool.function.name), ['read_file']);
		assert.match(String(body.messages[3]!.content), /第一行\n第二行/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('file reading is not offered without a desktop runtime, and no tools means no currentTime', async () => {
	const sse = chunkEvent({ content: '结果' }, 'stop') + DONE;
	let request: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		request = init;
		return stream([new TextEncoder().encode(sse)]);
	}, async () => {
		await streamRewrite(
			{ ...settings, fileReadScope: 'vault' },
			'',
			null,
			'x',
			[],
			[],
			createSink().sink,
			new AbortController().signal,
			{ vaultRoot: '/tmp', desktop: false },
		);
	});
	const body = JSON.parse(request?.body as string) as { tools?: unknown[]; messages: { content: string }[] };
	assert.equal('tools' in body, false);
	assert.equal('currentTime' in (JSON.parse(body.messages[1]!.content) as object), false);
});
