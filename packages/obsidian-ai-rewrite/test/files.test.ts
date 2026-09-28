import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_READ_LINES, MAX_READ_LINES, formatFileResult, parseReadArgs, readLocalFile } from '../src/files';

// Effect: 测试产物是 ESM，没有 window.require；用 createRequire 模拟渲染进程的 window。
Object.assign(globalThis, { window: { require: createRequire(import.meta.url) } });

const signal = new AbortController().signal;

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'ai-rewrite-files-'));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function args(path: string, extra: { offset?: number; limit?: number } = {}) {
	return { path, offset: extra.offset ?? 1, limit: extra.limit ?? DEFAULT_READ_LINES };
}

test('read args default to the first lines and reject invalid values', () => {
	assert.deepEqual(parseReadArgs('{"path":" a.txt "}'), { path: 'a.txt', offset: 1, limit: DEFAULT_READ_LINES });
	assert.deepEqual(parseReadArgs('{"path":"a.txt","offset":2.9,"limit":99999}'), { path: 'a.txt', offset: 2, limit: MAX_READ_LINES });
	assert.throws(() => parseReadArgs('nope'), /有效 JSON/);
	assert.throws(() => parseReadArgs('[]'), /必须是对象/);
	assert.throws(() => parseReadArgs('{"path":" "}'), /缺少路径/);
	assert.throws(() => parseReadArgs('{"path":"a","offset":0}'), /offset/);
	assert.throws(() => parseReadArgs('{"path":"a","limit":-1}'), /limit/);
});

test('a text file is read with line ranges and an explicit truncation note', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, 'notes.md'), ['第一行', '第二行', '第三行', '第四行'].join('\n'), 'utf8');
		const full = await readLocalFile(args('notes.md'), { scope: 'any', vaultRoot: dir, signal });
		assert.equal(full.content, '第一行\n第二行\n第三行\n第四行');
		assert.equal(full.totalLines, 4);
		assert.equal(full.fromLine, 1);
		assert.equal(full.toLine, 4);
		assert.equal(full.truncated, false);
		assert.match(formatFileResult(full), /共 4 行/);

		const part = await readLocalFile(args('notes.md', { offset: 2, limit: 2 }), { scope: 'any', vaultRoot: dir, signal });
		assert.equal(part.content, '第二行\n第三行');
		assert.equal(part.truncated, true);
		assert.match(formatFileResult(part), /已截断，可用 offset=4 继续读取/);
	});
});

test('gbk files are decoded when utf-8 decoding fails', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
		const result = await readLocalFile(args('gbk.txt'), { scope: 'any', vaultRoot: dir, signal });
		assert.equal(result.content, '中文');
	});
});

test('binary files are rejected as not text', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
		await assert.rejects(readLocalFile(args('bin.dat'), { scope: 'any', vaultRoot: dir, signal }), /不是文本文件/);
	});
});

test('missing files, directories and out-of-vault paths fail explicitly', async () => {
	await withTempDir(async (dir) => {
		await writeFile(join(dir, 'inside.txt'), 'inside', 'utf8');
		await assert.rejects(readLocalFile(args('nope.txt'), { scope: 'any', vaultRoot: dir, signal }), /文件不存在/);
		await mkdir(join(dir, 'folder'));
		await assert.rejects(readLocalFile(args('folder'), { scope: 'any', vaultRoot: dir, signal }), /不是普通文件/);

		const inside = await readLocalFile(args(join(dir, 'inside.txt')), { scope: 'vault', vaultRoot: dir, signal });
		assert.equal(inside.content, 'inside');

		const outside = await mkdtemp(join(tmpdir(), 'ai-rewrite-outside-'));
		try {
			await writeFile(join(outside, 'x.txt'), 'outside', 'utf8');
			await assert.rejects(
				readLocalFile(args(join(outside, 'x.txt')), { scope: 'vault', vaultRoot: dir, signal }),
				/仅允许读取笔记库内的文件/,
			);
			const allowed = await readLocalFile(args(join(outside, 'x.txt')), { scope: 'any', vaultRoot: dir, signal });
			assert.equal(allowed.content, 'outside');
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

test('an aborted request cancels the read', async () => {
	await withTempDir(async (dir) => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			readLocalFile(args('a.txt'), { scope: 'any', vaultRoot: dir, signal: controller.signal }),
			/已取消/,
		);
	});
});
