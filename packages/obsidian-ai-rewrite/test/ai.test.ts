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
	try {
		await run();
	} finally {
		globalThis.fetch = previous;
	}
}

test('DeepSeek defaults and SSE chunks are streamed, including split UTF-8 and CRLF', async () => {
	assert.equal(settings.endpoint, 'https://api.deepseek.com/chat/completions');
	assert.equal(settings.model, 'deepseek-flash');
	const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
	const split = bytes.indexOf(228) + 1; // 中文 UTF-8 字符内部断开
	const parts = [bytes.slice(0, split), bytes.slice(split, split + 2), bytes.slice(split + 2)];
	let sent: RequestInit | undefined;
	await withFetch(async (_url, init) => {
		sent = init;
		return stream(parts);
	}, async () => {
		const chunks: string[] = [];
		const result = await streamRewrite(settings, '原文', '改通顺', (delta) => chunks.push(delta), new AbortController().signal);
		assert.equal(result, '你好');
		assert.deepEqual(chunks, ['你', '好']);
	});
	assert.ok(sent);
	const body = JSON.parse(sent.body as string) as { stream: boolean; model: string; messages: { content: string }[] };
	assert.equal(body.stream, true);
	assert.equal(body.model, 'deepseek-flash');
	assert.deepEqual(JSON.parse(body.messages[1]!.content), { instruction: '改通顺', selectedText: '原文' });
	assert.ok(!(sent.body as string).includes('secret'));
	assert.equal((sent.headers as Record<string, string>).Authorization, 'Bearer secret');
});

test('truncation and non-stop finish reasons reject partial text', async () => {
	for (const tail of ['', 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n']) {
		const text = 'data: {"choices":[{"delta":{"content":"半截"},"finish_reason":null}]}\n\n' + tail;
		await withFetch(async () => stream([new TextEncoder().encode(text)]), async () => {
			await assert.rejects(streamRewrite(settings, '原文', '修改', () => {}, new AbortController().signal), /不完整/);
		});
	}
});

test('aborting after a partial event rejects the in-flight response', async () => {
	const controller = new AbortController();
	await withFetch(async () => new Response(new ReadableStream({
		start(streamController) {
			streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分"},"finish_reason":null}]}\n\n'));
			controller.signal.addEventListener('abort', () => streamController.error(new DOMException('Aborted', 'AbortError')));
		},
	})), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', () => controller.abort(), controller.signal), /已取消/);
	});
});

test('bad HTTP status, malformed events and invalid endpoint expose failure', async () => {
	assert.ok(validateSettings({ ...settings, endpoint: 'http://example.test/api' }));
	assert.ok(validateSettings({ ...settings, endpoint: 'https://secret:password@example.test/api' }));
	assert.equal(validateSettings({ ...settings, endpoint: 'http://localhost:11434/v1/chat/completions' }), null);
	await withFetch(async () => new Response('', { status: 401 }), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', () => {}, new AbortController().signal), /HTTP 401/);
	});
	await withFetch(async () => stream([new TextEncoder().encode('data: broken\n\n')]), async () => {
		await assert.rejects(streamRewrite(settings, '原文', '修改', () => {}, new AbortController().signal), /无效的流数据/);
	});
});
