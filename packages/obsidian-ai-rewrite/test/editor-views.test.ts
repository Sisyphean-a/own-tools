import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EditorView } from '@codemirror/view';
import { MarkdownView, type Editor } from 'obsidian';
import { findEditorView } from '../src/editor-views';

test('selection works even when Obsidian does not expose info.editor on existing editor views', () => {
	const file = { path: 'example.md' };
	const editor = {} as Editor;
	const dom = {} as HTMLElement;
	const info = Object.assign(Object.create(MarkdownView.prototype) as object, {
		file,
		containerEl: { contains: (target: unknown) => target === dom },
	}) as MarkdownView;
	const view = { dom, state: { field: () => ({ file, editor: undefined }) } } as unknown as EditorView;
	assert.equal(findEditorView(new Set([view]), editor, info, null), view);
});
