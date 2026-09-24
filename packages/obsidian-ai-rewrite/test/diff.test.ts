import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffWords } from '../src/diff';

test('Chinese and English word changes are highlighted without losing either text', () => {
	const before = '今天的会议 very good。\n下一行';
	const after = '今天的会议 very useful。\n下一行';
	const parts = diffWords(before, after)!;
	assert.equal(parts.filter((p) => p.type !== 'added').map((p) => p.text).join(''), before);
	assert.equal(parts.filter((p) => p.type !== 'removed').map((p) => p.text).join(''), after);
	assert.equal(parts.filter((p) => p.type === 'removed').map((p) => p.text).join(''), 'good');
	assert.equal(parts.filter((p) => p.type === 'added').map((p) => p.text).join(''), 'useful');
});

test('pure generation and identical text have sensible diffs, large input falls back', () => {
	assert.deepEqual(diffWords('', '新内容'), [{ type: 'added', text: '新内容' }]);
	assert.deepEqual(diffWords('相同', '相同'), [{ type: 'equal', text: '相同' }]);
	assert.equal(diffWords('长句 '.repeat(1201), '短句', 1200), null);
});
