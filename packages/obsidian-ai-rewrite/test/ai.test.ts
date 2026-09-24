import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamRewrite, validateSettings } from '../src/ai';
import { DEFAULT_SETTINGS } from '../src/settings';

const settings = { ...DEFAULT_SETTINGS, apiKey: 'secret' };

function stream(parts: Uint8Array[]): Response {
	return new Response(new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	}));
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
	const previous = globalThis.fetch;
	globalThis.fetch = mock;
	try { await run(); } finally { globalThis.fetch = previous; }
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
		const result = await streamRewrite(settings, '原文', '改通顺', ['data:image/png;base64,AAAA'], (delta) => chunks.push(delta), new AbortController().signal);
		assert.equal(result, '你好');
		assert.deepEqual(chunks, ['你', '好']);
	});
	assert.ok(sent);
	const body = JSON.parse(sent.body as string) as { stream: boolean; model: string; messages: { content: unknown }[] };
	assert.equal(body.stream, true);
	assert.deepEqual(body.messages[1]!.content, [
		{ type: 'text', text: JSON.stringify({ instruction: '改通顺', selectedText: '原文' }) },
		{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
	]);
	assert.ok(!(sent.body as string).includes('secret'));
	assert.equal((sent.headers as Record<string, string>).Authorization, 'Bearer secret');
});

test('empty selection sends generation instructions, and terminal DONE without blank line finishes', async () => {
	const text = 'data: {"choices":[{"delta":{"content":"结果"},"finish_reason":"stop"}]}\n\ndata: [DONE]';
	await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
		assert.equal(await streamRewrite(settings, '', '写一句话', [], () => {}, new AbortController().signal), '结果');
	});
});

test('truncation and non-stop finish reasons reject partial text', async () => {
	for (const tail of ['', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
		const text = 'data: {"choices":[{"delta":{"content":"半截"},"finish_reason":null}]}\n\n' + tail;
		await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
			await assert.rejects(streamRewrite(settings, '原文', '修改', [], () => {}, new AbortController().signal), /不完整/);
		});
	}
});

test('aborting after partial event rejects the in-flight response', async () => {
	const controller = new AbortController();
	await withFetch(async () => new Response(new ReadableStream({
		start(streamController) {
			streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"},"finish_reason":null}]}\n\n'));
			controller.signal.addEventListener('abort', () => streamController.error(new DOMException('Aborted', 'AbortError')));
		},
	})), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', [], () => controller.abort(), controller.signal), /已取消/);
	});
});

test('editor state error is not masked as a network failure', async () => {
	const text = 'data: {"choices":[{"delta":{"content":"字"},"finish_reason":null}]}\n\n';
	await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', [], () => { throw new Error('原文已变化'); }, new AbortController().signal), /原文已变化/);
	});
});

test('bad HTTP status, malformed events and invalid endpoint expose failure', async () => {
	assert.ok(validateSettings({ ...settings, endpoint: 'http://example.test/api' }));
	assert.ok(validateSettings({ ...settings, endpoint: 'https://secret:password@example.test/api' }));
	assert.equal(validateSettings({ ...settings, endpoint: 'http://localhost:11434/v1/chat/completions' }), null);
	await withFetch(async () => new Response('', { status: 401 }), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', [], () => {}, new AbortController().signal), /HTTP 401/);
	});
	await withFetch(async () => stream([new TextEncoder().encode('data: broken\n\n')]), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', [], () => {}, new AbortController().signal), /无效的流数据/);
	});
});
