import { ViewPlugin, type EditorView } from '@codemirror/view';
import { editorInfoField, MarkdownView, type Editor, type MarkdownFileInfo } from 'obsidian';
import { lockedRange, selectionGuard } from './selection-lock';

export function createSelectionExtension(views: Set<EditorView>) {
	return [
		selectionGuard,
		ViewPlugin.define((view) => {
			views.add(view);
			return { destroy() { views.delete(view); } };
		}),
	];
}

export function findEditorView(views: Set<EditorView>, editor: Editor, info: MarkdownFileInfo, active: MarkdownView | null): EditorView | null {
	const container = info instanceof MarkdownView ? info.containerEl : active?.editor === editor ? active.containerEl : null;
	for (const view of views) {
		const associated = view.state.field(editorInfoField, false);
		if (container?.contains(view.dom) && (!associated?.file || associated.file === info.file)) return view;
		if (associated?.file === info.file && associated.editor === editor) return view;
	}
	// Failure: 部分编辑器不会在 editorInfoField 中暴露 Editor；仅当保护扩展已装载且编辑器身份可核实时回退。
	const cm = (editor as Editor & { cm?: EditorView }).cm;
	if (!cm || cm.state.field(lockedRange, false) === undefined) return null;
	const associated = cm.state.field(editorInfoField, false);
	return associated?.file === info.file || (!associated?.file && active?.editor === editor) ? cm : null;
}
