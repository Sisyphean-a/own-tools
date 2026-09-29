import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiffRows, type DiffRow } from '../src/inline-diff';

/** 取某一侧实际输出的行文字，用来验证两侧内容都不丢不重。 */
function sideLines(rows: DiffRow[], side: 'a' | 'b'): string[] {
	const out: string[] = [];
	for (const row of rows) {
		if (row.kind === 'context') out.push(row.text);
		else if (row.kind === 'removed' && side === 'a') out.push(row.text);
		else if (row.kind === 'added' && side === 'b') out.push(row.text);
	}
	return out;
}

/** 展开全部折叠区域后的行，用于内容完整性检查。 */
function expandedRows(original: string, result: string): DiffRow[] {
	const collapsed = buildDiffRows(original, result).filter((row) => row.kind === 'collapsed').length;
	const expanded = new Set<number>();
	for (let i = 0; i < collapsed; i++) expanded.add(i);
	return buildDiffRows(original, result, { expanded });
}

/** 行标签：added 用 B 侧行号，其余用 A 侧行号，便于断言顺序。 */
function lineLabel(row: DiffRow): string {
	if (row.kind === 'added') return `added@${row.bLine}`;
	if (row.kind === 'collapsed') return `collapsed@${row.index}`;
	return `${row.kind}@${row.aLine}`;
}

function assertKeepsBothSides(original: string, result: string): void {
	const rows = expandedRows(original, result);
	assert.deepEqual(sideLines(rows, 'a'), original.split('\n'));
	assert.deepEqual(sideLines(rows, 'b'), result.split('\n'));
}

test('同一行的多处改动只输出一对 -/+ 行，行内片段精确到词', () => {
	const original = '18包测试:\nhttps://a/process.html\nhttps://a/fail.html';
	const result = '## 标题\n\n**18包测试：**\n\n- https://a/process.html\n- https://a/fail.html';
	const rows = buildDiffRows(original, result);
	assert.deepEqual(rows.map((row) => row.kind), [
		'added', 'added',
		'removed', 'added', 'added',
		'removed', 'added',
		'removed', 'added',
	]);
	const removed = rows.filter((row) => row.kind === 'removed');
	const added = rows.filter((row) => row.kind === 'added');
	assert.deepEqual(removed.map((row) => row.text), ['18包测试:', 'https://a/process.html', 'https://a/fail.html']);
	assert.deepEqual(added.map((row) => row.text), ['## 标题', '', '**18包测试：**', '', '- https://a/process.html', '- https://a/fail.html']);
	// 改动行与新增行成对相邻，改动词与新增词分别高亮
	assert.deepEqual(rows[2], {
		kind: 'removed',
		aLine: 1,
		text: '18包测试:',
		spans: [{ type: 'equal', text: '18包测试' }, { type: 'changed', text: ':' }],
	});
	assert.deepEqual(rows[3], {
		kind: 'added',
		bLine: 3,
		text: '**18包测试：**',
		spans: [{ type: 'changed', text: '**' }, { type: 'equal', text: '18包测试' }, { type: 'changed', text: '：**' }],
	});
	assert.deepEqual(rows[6], { kind: 'added', bLine: 5, text: '- https://a/process.html', spans: [{ type: 'changed', text: '- ' }, { type: 'equal', text: 'https://a/process.html' }] });
	assertKeepsBothSides(original, result);
});

test('行数不同的区域按行配对，剩余行单独作为新增或删除', () => {
	const rows = buildDiffRows('第一行\n第二行\n第三行', '第一行\n第二行改写\n第三行新增\n第四行');
	assert.deepEqual(rows.map(lineLabel), ['context@1', 'removed@2', 'added@2', 'removed@3', 'added@3', 'added@4']);
	assert.deepEqual(rows.filter((row) => row.kind === 'added').map((row) => row.text), ['第二行改写', '第三行新增', '第四行']);
	assertKeepsBothSides('第一行\n第二行\n第三行', '第一行\n第二行改写\n第三行新增\n第四行');
});

test('整行新增与删除保持原文顺序，行号跟随各自文档', () => {
	const inserted = buildDiffRows('keep\ntail', 'keep\n新增\ntail');
	assert.deepEqual(inserted.map(lineLabel), ['context@1', 'added@2', 'context@2']);
	const deleted = buildDiffRows('keep\n旧一\n旧二\ntail', 'keep\ntail');
	assert.deepEqual(deleted.map(lineLabel), ['context@1', 'removed@2', 'removed@3', 'context@4']);
	assert.deepEqual(deleted.filter((row) => row.kind === 'removed').map((row) => row.text), ['旧一', '旧二']);
	assertKeepsBothSides('keep\ntail', 'keep\n新增\ntail');
	assertKeepsBothSides('keep\n旧一\n旧二\ntail', 'keep\ntail');
});

test('空原文（光标插入）先输出空行删除，再逐行新增', () => {
	const rows = buildDiffRows('', '新内容\n第二行');
	assert.deepEqual(rows.map((row) => row.kind), ['removed', 'added', 'added']);
	assert.deepEqual(rows.slice(1).map((row) => (row.kind === 'added' ? row.text : '')), ['新内容', '第二行']);
	assertKeepsBothSides('', '新内容\n第二行');
});

test('连续未改动超过 8 行时折叠中间部分，展开后恢复全部内容', () => {
	const original = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
	const result = original.replace('line 13', 'line 13 改');
	const rows = buildDiffRows(original, result);
	const collapsed = rows.filter((row) => row.kind === 'collapsed');
	assert.equal(collapsed.length, 1);
	// 改动前有 13 行未改动：保留首尾各 3 行，隐藏 7 行
	assert.equal(collapsed[0]!.kind === 'collapsed' ? collapsed[0]!.count : 0, 7);
	assert.deepEqual(rows.slice(0, 3).map((row) => (row.kind === 'context' ? row.text : '')), ['line 0', 'line 1', 'line 2']);
	const expanded = rows.filter((row) => row.kind !== 'collapsed').length === rows.length - 1;
	assert.equal(expanded, true);
	assertKeepsBothSides(original, result);
});

test('两侧内容不丢不重（含 CRLF、重复行、乱序和随机改动）', () => {
	const cases: [string, string][] = [
		['a\nb\nc', 'a\nb\nc'],
		['', ''],
		['a\nb\n', 'a\nc\n'],
		['a\nb', 'a\nc'],
		['开头\n句子一。句子二。\n结尾', '开头\n句子一改。句子二。新增。\n结尾'],
		['x\nx\nx', 'x\nx'],
		['a\nb\nc', 'c\na\nb'],
		['a\r\nb\r\nc', 'a\r\nB\r\nc'],
		['- one\n  - two\n- three', '- one\n  - TWO\n- three\n- four'],
		['长文', Array.from({ length: 30 }, (_, i) => (i % 7 === 0 ? `行 ${i} 改` : `行 ${i}`)).join('\n')],
	];
	const random: [string, string][] = [];
	let seed = 12345;
	const rand = (n: number): number => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	for (let round = 0; round < 20; round++) {
		const base = Array.from({ length: rand(12) + 1 }, (_, i) => `l${i}`);
		const next = base.slice();
		for (let k = 0; k < 3; k++) {
			const at = rand(next.length);
			const op = rand(3);
			if (op === 0) next[at] = `${next[at]}!`;
			else if (op === 1) next.splice(at, 0, `new${k}`);
			else next.splice(at, 1);
		}
		random.push([base.join('\n'), next.join('\n')]);
	}
	for (const [original, result] of [...cases, ...random]) assertKeepsBothSides(original, result);
});
