import { Platform } from 'obsidian';

export const FILE_READ_TOOL_NAME = 'read_file';
export const DEFAULT_READ_LINES = 2000;
export const MAX_READ_LINES = 5000;
export const MAX_READ_CHARS = 120_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export type FileReadScope = 'off' | 'vault' | 'any';

export interface ReadFileArgs {
	path: string;
	offset: number;
	limit: number;
}

export interface FileReadResult {
	path: string;
	content: string;
	totalLines: number;
	fromLine: number;
	toLine: number;
	bytes: number;
	truncated: boolean;
}

export interface ReadFileOptions {
	scope: Exclude<FileReadScope, 'off'>;
	/** 笔记库根路径；scope 为 vault 时用于解析相对路径和范围校验。 */
	vaultRoot: string;
	signal: AbortSignal;
}

/** Rule: 只读工具；没有 write/edit，模型无法改动本地文件。 */
export const FILE_READ_TOOL = {
	type: 'function',
	function: {
		name: FILE_READ_TOOL_NAME,
		description: `只读本地文本文件（不能写入或修改）。用户给出文件路径或要求查看某个文件时调用；大文件用 offset/limit 分段读取，默认 ${DEFAULT_READ_LINES} 行。`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '文件路径，支持绝对路径、~/ 开头或笔记库相对路径。' },
				offset: { type: 'number', description: '起始行号，从 1 开始，默认 1。' },
				limit: { type: 'number', description: `最多读取的行数，默认 ${DEFAULT_READ_LINES}，上限 ${MAX_READ_LINES}。` },
			},
			required: ['path'],
			additionalProperties: false,
		},
	},
} as const;

/** Flow: 校验模型给出的读取参数；行数按上限截断，截断结果会在返回内容里说明。 */
export function parseReadArgs(argumentsJson: string): ReadFileArgs {
	let parsed: unknown;
	try {
		parsed = JSON.parse(argumentsJson);
	} catch {
		throw new Error('文件读取参数不是有效 JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('文件读取参数必须是对象');
	const { path, offset, limit } = parsed as { path?: unknown; offset?: unknown; limit?: unknown };
	if (typeof path !== 'string' || !path.trim()) throw new Error('文件读取缺少路径');
	if (offset !== undefined && (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 1)) {
		throw new Error('文件读取的 offset 必须是 ≥1 的数字');
	}
	if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
		throw new Error('文件读取的 limit 必须是 ≥1 的数字');
	}
	return {
		path: path.trim(),
		offset: offset === undefined ? 1 : Math.floor(offset),
		limit: limit === undefined ? DEFAULT_READ_LINES : Math.min(Math.floor(limit), MAX_READ_LINES),
	};
}

/**
 * Flow: 解析路径并按 scope 校验，读取文本文件的指定行区间。
 * Failure: 越界、不存在、目录、无权限、过大、二进制或编码无法识别都直接抛错，由调用方取消并提示。
 * Effect: 仅桌面版可用；node 模块用动态 import，手机版不会加载文件系统代码。
 */
export async function readLocalFile(args: ReadFileArgs, options: ReadFileOptions): Promise<FileReadResult> {
	// Rule: obsidianmd/no-nodejs-modules 要求以 Platform.isDesktop 判断开头；平板桌面模式没有 Node 运行时，再用 isDesktopApp 确认。
	if (!Platform.isDesktop) throw new Error('文件读取仅在桌面版可用');
	if (!Platform.isDesktopApp) throw new Error('文件读取需要桌面版 Obsidian 的本地文件系统');
	const [fs, path, os] = await Promise.all([import('node:fs/promises'), import('node:path'), import('node:os')]);
	const target = resolveTarget(args, options, path, os);
	if (options.signal.aborted) throw new Error('改写已取消');
	let info;
	try {
		info = await fs.stat(target);
	} catch (error) {
		throw new Error(readError(error, args.path));
	}
	if (!info.isFile()) throw new Error(`不是普通文件（可能是目录）：${args.path}`);
	if (info.size > MAX_FILE_BYTES) throw new Error(`文件过大（超过 ${MAX_FILE_BYTES / 1024 / 1024} MB）：${args.path}`);
	let buffer: Uint8Array;
	try {
		buffer = await fs.readFile(target);
	} catch (error) {
		throw new Error(readError(error, args.path));
	}
	if (options.signal.aborted) throw new Error('改写已取消');
	if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new Error(`不是文本文件：${args.path}`);
	const lines = splitLines(decodeText(buffer));
	const selected: string[] = [];
	let chars = 0;
	for (let index = args.offset - 1; index < lines.length && selected.length < args.limit; index += 1) {
		const line = lines[index] ?? '';
		if (chars + line.length + 1 > MAX_READ_CHARS) break;
		selected.push(line);
		chars += line.length + 1;
	}
	const fromLine = Math.min(args.offset, Math.max(lines.length, 1));
	const toLine = selected.length ? fromLine + selected.length - 1 : fromLine - 1;
	return {
		path: args.path,
		content: selected.join('\n'),
		totalLines: lines.length,
		fromLine,
		toLine,
		bytes: buffer.length,
		truncated: toLine < lines.length,
	};
}

/** Flow: 生成给模型的工具结果：文件信息头 + 正文；截断时说明续读位置。 */
export function formatFileResult(result: FileReadResult): string {
	const shown = result.toLine >= result.fromLine ? `第 ${result.fromLine}-${result.toLine} 行，共 ${result.totalLines} 行` : `共 ${result.totalLines} 行`;
	const truncated = result.truncated ? `；已截断，可用 offset=${result.toLine + 1} 继续读取` : '';
	return `文件：${result.path}（${shown}；${formatBytes(result.bytes)}${truncated}）\n${result.content}`;
}

/** Effect: 过程区显示文件名而不是完整路径。 */
export function fileName(input: string): string {
	const parts = input.split(/[\\/]/);
	return parts[parts.length - 1] || input;
}

function resolveTarget(args: ReadFileArgs, options: ReadFileOptions, path: typeof import('node:path'), os: typeof import('node:os')): string {
	const cleaned = args.path.replace(/^["']|["']$/g, '');
	const expanded = /^~[\\/]/.test(cleaned) ? path.join(os.homedir(), cleaned.slice(2)) : cleaned;
	const target = path.isAbsolute(expanded)
		? path.resolve(expanded)
		: path.resolve(options.vaultRoot || os.homedir(), expanded);
	if (options.scope === 'any') return target;
	if (!options.vaultRoot) throw new Error('无法确定笔记库路径，请使用绝对路径或允许读取任意路径');
	const relative = path.relative(options.vaultRoot, target);
	if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return target;
	throw new Error(`仅允许读取笔记库内的文件：${args.path}（可在设置中改为允许任意路径）`);
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function decodeText(buffer: Uint8Array): string {
	for (const label of ['utf-8', 'gb18030']) {
		try {
			return new TextDecoder(label, { fatal: true }).decode(buffer);
		} catch {
			// Failure: 编码不匹配时尝试下一个候选，全部失败才报错。
		}
	}
	throw new Error('无法识别文件编码（不是 UTF-8 或 GB18030）');
}

function readError(error: unknown, input: string): string {
	const raw = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
	const code = typeof raw === 'string' ? raw : '';
	if (code === 'ENOENT') return `文件不存在：${input}`;
	if (code === 'EACCES' || code === 'EPERM') return `没有权限读取：${input}`;
	if (code === 'EISDIR') return `不是普通文件（可能是目录）：${input}`;
	return `读取文件失败：${input}`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
