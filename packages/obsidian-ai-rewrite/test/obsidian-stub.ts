export class PluginSettingTab {}
export class Setting {}
export class MarkdownView {}
export const editorInfoField = Symbol('editorInfoField');

export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer?: ArrayBufferLike;
}

export type RequestUrlHandler = (param: RequestUrlParam) => Promise<RequestUrlResponse>;

let handler: RequestUrlHandler | null = null;

export function setRequestUrlHandler(next: RequestUrlHandler | null): void {
	handler = next;
}

export async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
	if (!handler) throw new Error('测试未设置 requestUrl 模拟');
	return handler(param);
}
