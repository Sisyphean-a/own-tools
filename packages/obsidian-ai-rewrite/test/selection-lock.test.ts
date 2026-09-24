import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { appendLocked, clearLock, finishLocked, lockedRange, restoreLocked, selectionGuard, setLock } from '../src/selection-lock';

function setup() {
	let state = EditorState.create({ doc: 'abc SELECT xyz', extensions: [selectionGuard, history()] });
	state = state.update({ effects: setLock.of({ from: 4, to: 10, busy: true }) }).state;
	return state;
}

function holder() {
	const view = {
		state: setup(),
		dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => {
			view.state = view.state.update(spec).state;
		},
	};
	return view;
}

test('locked text cannot be changed by user edits', () => {
	const state = setup();
	for (const changes of [
		{ from: 6, insert: '!' },
		{ from: 4, to: 10, insert: 'new' },
		{ from: 3, to: 5, insert: '' },
		{ from: 9, to: 11, insert: '' },
	]) {
		const result = state.update({ changes });
		assert.equal(result.state.doc.toString(), state.doc.toString());
	}
});

test('chunks appear incrementally, region remains locked, outside edits remap it', () => {
	const view = holder();
	let current = appendLocked(view as unknown as EditorView, 'SELECT', '新', true);
	assert.equal(view.state.doc.toString(), 'abc 新 xyz');
	view.dispatch({ changes: { from: 0, insert: 'ok ' } });
	assert.deepEqual(view.state.field(lockedRange), { from: 7, to: 8, busy: true });
	current = appendLocked(view as unknown as EditorView, current, '内容', false);
	assert.equal(current, '新内容');
	assert.equal(view.state.doc.toString(), 'ok abc 新内容 xyz');
	assert.equal(view.state.update({ changes: { from: 8, insert: '!' } }).state.doc.toString(), view.state.doc.toString());
});

test('completed stream is one undoable replacement even after a delay or outside edit', () => {
	const view = holder();
	let current = appendLocked(view as unknown as EditorView, 'SELECT', '新', true);
	view.dispatch({ changes: { from: 0, insert: 'ok ' } });
	current = appendLocked(view as unknown as EditorView, current, '内容', false);
	finishLocked(view as unknown as EditorView, current, 'SELECT', '新内容');
	assert.equal(view.state.doc.toString(), 'ok abc 新内容 xyz');
	assert.equal(view.state.field(lockedRange), null);
	assert.equal(undo(view as unknown as EditorView), true);
	assert.equal(view.state.doc.toString(), 'ok abc SELECT xyz');
});

test('failure restores original without adding an undo entry', () => {
	const view = holder();
	const current = appendLocked(view as unknown as EditorView, 'SELECT', '半截', true);
	restoreLocked(view as unknown as EditorView, current, 'SELECT');
	assert.equal(view.state.doc.toString(), 'abc SELECT xyz');
	assert.equal(view.state.field(lockedRange), null);
	assert.equal(undo(view as unknown as EditorView), false);
});

test('external edits invalidate the write rather than overwriting them', () => {
	const view = holder();
	const current = appendLocked(view as unknown as EditorView, 'SELECT', '半截', true);
	view.dispatch({ changes: { from: 5, insert: '外' }, filter: false });
	assert.throws(() => finishLocked(view as unknown as EditorView, current, 'SELECT', '完整'), /选区已变化/);
});

test('closing the prompt unlocks without modifying text', () => {
	const cancelled = setup().update({ effects: clearLock.of(undefined) }).state;
	assert.equal(cancelled.field(lockedRange), null);
	assert.equal(cancelled.doc.toString(), 'abc SELECT xyz');
});
