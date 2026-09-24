import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { applyLocked, clearLock, lockedRange, selectionGuard, setLock } from '../src/selection-lock';

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

test('external bypass that changes original is rejected instead of overwritten', () => {
	const view = holder();
	view.dispatch({ effects: setLock.of({ from: 4, to: 10, phase: 'review', preview: '完整' }) });
	view.dispatch({ changes: { from: 5, insert: '外' }, filter: false });
	assert.throws(() => applyLocked(view as unknown as EditorView, 'SELECT', '完整'), /原文或插入位置已变化/);
	assert.equal(view.state.doc.toString(), 'abc S外ELECT xyz');
});
