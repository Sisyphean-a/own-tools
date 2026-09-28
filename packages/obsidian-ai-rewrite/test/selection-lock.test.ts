import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { appendThinking, applyLocked, clearLock, lockedRange, quietHint, QUIET_HINT_SECONDS, selectionGuard, setLock, setProgress, toggleProcess } from '../src/selection-lock';

function holder(selected = true) {
	const from = 4;
	const to = selected ? 10 : 4;
	const view = {
		state: EditorState.create({ doc: 'abc SELECT xyz', extensions: [selectionGuard, history()] }),
		dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => {
			view.state = view.state.update(spec).state;
		},
	};
	view.dispatch({ effects: setLock.of({ from, to, phase: 'prompt', preview: '' }) });
	return view;
}

test('selected source remains unchanged while chunks stream and user edits inside are blocked', () => {
	const view = holder();
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'stream', preview: '新' }) });
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'stream', preview: '新内容' }) });
	assert.equal(view.state.doc.toString(), 'abc SELECT xyz');
	for (const changes of [{ from: 6, insert: '!' }, { from: 4, to: 10, insert: 'new' }]) {
		assert.equal(view.state.update({ changes }).state.doc.toString(), 'abc SELECT xyz');
	}
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'review', preview: '新内容' }) });
	assert.equal(view.state.field(lockedRange)?.phase, 'review');
	assert.equal(view.state.doc.toString(), 'abc SELECT xyz');
	view.dispatch({ effects: clearLock.of(undefined) });
	assert.equal(view.state.field(lockedRange), null);
});

test('confirmation applies exactly once and one undo restores source, preserving outside edits', () => {
	const view = holder();
	view.dispatch({ changes: { from: 0, insert: 'ok ' } });
	assert.deepEqual(view.state.field(lockedRange), { from: 7, to: 13, phase: 'prompt', preview: '' });
	view.dispatch({ effects: setLock.of({ from: 7, to: 13, phase: 'review', preview: '新内容' }) });
	applyLocked(view as unknown as EditorView, 'SELECT', '新内容');
	assert.equal(view.state.doc.toString(), 'ok abc 新内容 xyz');
	assert.equal(view.state.field(lockedRange), null);
	assert.equal(undo(view as unknown as EditorView), true);
	assert.equal(view.state.doc.toString(), 'ok abc SELECT xyz');
});

test('empty selection locks insertion point, then inserts only on confirmation', () => {
	const view = holder(false);
	assert.equal(view.state.update({ changes: { from: 4, insert: 'typing' } }).state.doc.toString(), 'abc SELECT xyz');
	view.dispatch({ changes: { from: 0, insert: 'ok ' } });
	assert.deepEqual(view.state.field(lockedRange), { from: 7, to: 7, phase: 'prompt', preview: '' });
	view.dispatch({ effects: setLock.of({ from: 7, to: 7, phase: 'review', preview: '新内容' }) });
	applyLocked(view as unknown as EditorView, '', '新内容');
	assert.equal(view.state.doc.toString(), 'ok abc 新内容SELECT xyz');
	assert.equal(undo(view as unknown as EditorView), true);
	assert.equal(view.state.doc.toString(), 'ok abc SELECT xyz');
});

test('discard and failed requests never alter the source', () => {
	const view = holder();
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'stream', preview: '部分' }) });
	view.dispatch({ effects: clearLock.of(undefined) });
	assert.equal(view.state.doc.toString(), 'abc SELECT xyz');
	assert.equal(view.state.field(lockedRange), null);
	assert.equal(undo(view as unknown as EditorView), false);
});

test('confirmation cannot leave a review card after host strips effects from a document transaction', () => {
	const view = {
		state: EditorState.create({ doc: '原文', extensions: [selectionGuard, history()] }),
		dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => {
			// 模拟宿主保留文档变更和注解，却丢弃随变更附带的 effect。
			view.state = view.state.update('changes' in spec ? { ...spec, effects: [] } : spec).state;
		},
	};
	view.dispatch({ effects: setLock.of({ from: 0, to: 2, phase: 'review', preview: '新文' }) });
	applyLocked(view as unknown as EditorView, '原文', '新文');
	assert.equal(view.state.doc.toString(), '新文');
	assert.equal(view.state.field(lockedRange), null);
});

test('thinking and tool progress accumulate in preview state, and review collapses the panel', () => {
	const view = holder();
	view.dispatch({ effects: setProgress.of({ id: 'links', text: '正在读取 1 个链接…', done: false }) });
	view.dispatch({ effects: appendThinking.of('先看资料。') });
	view.dispatch({ effects: appendThinking.of('再下结论。') });
	view.dispatch({ effects: setProgress.of({ id: 'links', text: '已读取 1 个链接', done: true }) });
	view.dispatch({ effects: setProgress.of({ id: 'call_1', text: '正在联网检索：x', done: false }) });
	assert.deepEqual(view.state.field(lockedRange)?.progress, [
		{ id: 'links', text: '已读取 1 个链接', done: true },
		{ id: 'call_1', text: '正在联网检索：x', done: false },
	]);
	assert.equal(view.state.field(lockedRange)?.thinking, '先看资料。再下结论。');
	assert.equal(view.state.field(lockedRange)?.activity, '正在联网检索：x');
	view.dispatch({ effects: setProgress.of({ id: 'call_1', text: '联网检索完成，返回 3 条结果', done: true }) });
	assert.equal(view.state.field(lockedRange)?.progress?.length, 2);
	assert.equal(view.state.field(lockedRange)?.progress?.[1]?.text, '联网检索完成，返回 3 条结果');
	view.dispatch({ effects: appendThinking.of('继续想') });
	assert.equal(view.state.field(lockedRange)?.activity, undefined);
	view.dispatch({ effects: toggleProcess.of(undefined) });
	assert.equal(view.state.field(lockedRange)?.expanded, false);
	const current = view.state.field(lockedRange);
	assert.ok(current);
	view.dispatch({ effects: setLock.of({ ...current, phase: 'review', preview: '结果' }) });
	assert.equal(view.state.field(lockedRange)?.expanded, false);
	assert.equal(view.state.field(lockedRange)?.thinking, '先看资料。再下结论。继续想');
});

test('quiet hint only appears while streaming after a long silence', () => {
	assert.equal(quietHint('stream', 1000, 1000 + (QUIET_HINT_SECONDS - 1) * 1000), null);
	assert.match(quietHint('stream', 1000, 1000 + (QUIET_HINT_SECONDS + 4) * 1000) ?? '', /已 12 秒没有新内容/);
	assert.equal(quietHint('review', 1000, 1000 + 60_000), null);
});

test('external bypass that changes original is rejected instead of overwritten', () => {
	const view = holder();
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'review', preview: '完整' }) });
	view.dispatch({ changes: { from: 5, insert: '外' }, filter: false });
	assert.throws(() => applyLocked(view as unknown as EditorView, 'SELECT', '完整'), /原文或插入位置已变化/);
	assert.equal(view.state.doc.toString(), 'abc S外ELECT xyz');
});
