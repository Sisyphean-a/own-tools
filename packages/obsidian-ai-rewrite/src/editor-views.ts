import { ViewPlugin, type EditorView } from '@codemirror/view';
import { editorInfoField, type Editor } from 'obsidian';
import { selectionGuard } from './selection-lock';

export function createSelectionExtension(views: Map<Editor, EditorView>) {
	return [
		selectionGuard,
		ViewPlugin.define((view) => {
			let editor = view.state.field(editorInfoField, false)?.editor;
			if (editor) views.set(editor, view);
			return {
				update() {
					const current = view.state.field(editorInfoField, false)?.editor;
					if (current !== editor) {
						if (editor && views.get(editor) === view) views.delete(editor);
						editor = current;
						if (editor) views.set(editor, view);
					}
				},
				destroy() {
					if (editor && views.get(editor) === view) views.delete(editor);
				},
			};
		}),
	];
}
