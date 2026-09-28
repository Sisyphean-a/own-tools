import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContext } from '../src/context';

test('短文返回完整前后文，选区内容不进入上下文，关闭时不发送', () => {
	const doc = '前一段\n被选中的文字\n后一段';
	const from = doc.indexOf('被选中');
	const to = from + '被选中的文字'.length;
	assert.deepEqual(buildContext(doc, from, to, 4000), { before: '前一段\n', after: '\n后一段' });
	assert.equal(buildContext(doc, from, to, 0), null);
	assert.equal(buildContext(doc, from, to, Number.NaN), null);
});

test('空选区按光标位置取前后文，文档首尾只取存在的一侧', () => {
	const doc = '开头\n\n结尾';
	assert.deepEqual(buildContext(doc, 0, 0, 4000), { before: '', after: '开头\n\n结尾' });
	assert.deepEqual(buildContext(doc, doc.length, doc.length, 4000), { before: '开头\n\n结尾', after: '' });
	const cursor = doc.indexOf('结尾');
	assert.deepEqual(buildContext(doc, cursor, cursor, 4000), { before: '开头\n\n', after: '结尾' });
});

test('超长前后文按额度截断，断点对齐行首并标注省略', () => {
	// 每行 11 字符加换行，共 40 行；光标在第 20 行行首。
	const lines = Array.from({ length: 40 }, (_, i) => `L${String(i).padStart(2, '0')}${'x'.repeat(8)}`);
	const doc = lines.join('\n');
	const cursor = 12 * 20;
	const context = buildContext(doc, cursor, cursor, 100);
	assert.ok(context);
	assert.equal(context.before, `…${lines.slice(16, 20).join('\n')}\n`);
	assert.equal(context.after, `${lines.slice(20, 24).join('\n')}…`);
	assert.ok(context.before.length + context.after.length <= 100);
});

test('一侧不足额度时剩余额度转给另一侧', () => {
	const lines = Array.from({ length: 30 }, (_, i) => `L${String(i).padStart(2, '0')}${'x'.repeat(8)}`);
	const doc = lines.join('\n');
	const cursor = 12 * 3;
	const context = buildContext(doc, cursor, cursor, 100);
	assert.ok(context);
	assert.equal(context.before, lines.slice(0, 3).join('\n') + '\n');
	assert.equal(context.after, `${lines.slice(3, 8).join('\n')}…`);
	assert.equal(context.before.length + context.after.length, 96);
});

test('长段落没有换行时接受行中间截断，保留贴住光标的一段', () => {
	const doc = `${'甲'.repeat(600)}目标${'乙'.repeat(600)}`;
	const from = 600;
	const context = buildContext(doc, from, from + 2, 1000);
	assert.ok(context);
	assert.equal(context.before, `…${'甲'.repeat(500)}`);
	assert.equal(context.after, `${'乙'.repeat(500)}…`);
});
