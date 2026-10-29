import { App, PluginSettingTab, Setting } from 'obsidian';
import type { FileReadScope } from './files';
import { DEFAULT_SEARCH_ENDPOINT } from './search';
import type AiRewritePlugin from './main';

export type ReasoningEffort = 'default' | 'none' | 'low' | 'high' | 'max';
export type StylePreset = 'concise' | 'generic';
export type StyleScope = 'note' | 'note-folder' | 'off';

export interface AiSettings {
	endpoint: string;
	apiKey: string;
	model: string;
	reasoningEffort: ReasoningEffort;
	/** 选区（或光标）前后文合计字符额度；0 表示不发送上下文。 */
	contextLimit: number;
	/** 是否允许模型调用 web_search 工具检索网页。 */
	searchEnabled: boolean;
	deepSeekSearchEndpoint: string;
	deepSeekSearchApiKey: string;
	/** 文件读取范围：off 不提供工具，vault 仅笔记库，any 允许任意本地路径；仅桌面版生效。 */
	fileReadScope: FileReadScope;
	/** 写作风格：concise 信息密度优先并少用装饰；generic 只沿用笔记已有形态。 */
	stylePreset: StylePreset;
	/** 风格样本范围：note 仅当前笔记，note-folder 再加同目录笔记，off 不发送。 */
	styleScope: StyleScope;
}

export const CONTEXT_LIMIT_OPTIONS: readonly number[] = [0, 1000, 2000, 4000, 8000, 16000];

export const DEFAULT_SETTINGS: AiSettings = {
	endpoint: 'https://api.deepseek.com/chat/completions',
	apiKey: '',
	model: 'deepseek-flash',
	reasoningEffort: 'default',
	contextLimit: 4000,
	searchEnabled: false,
	deepSeekSearchEndpoint: DEFAULT_SEARCH_ENDPOINT,
	deepSeekSearchApiKey: '',
	fileReadScope: 'off',
	stylePreset: 'concise',
	styleScope: 'note',
};
export const FILE_READ_SCOPE_OPTIONS: readonly FileReadScope[] = ['off', 'vault', 'any'];
export const STYLE_PRESET_OPTIONS: readonly StylePreset[] = ['concise', 'generic'];
export const STYLE_SCOPE_OPTIONS: readonly StyleScope[] = ['note', 'note-folder', 'off'];

export function normalizeFileReadScope(value: unknown): FileReadScope {
	return typeof value === 'string' && FILE_READ_SCOPE_OPTIONS.includes(value as FileReadScope)
		? value as FileReadScope
		: DEFAULT_SETTINGS.fileReadScope;
}

export function normalizeContextLimit(value: unknown): number {
	return typeof value === 'number' && CONTEXT_LIMIT_OPTIONS.includes(value)
		? value
		: DEFAULT_SETTINGS.contextLimit;
}

export function normalizeStylePreset(value: unknown): StylePreset {
	return typeof value === 'string' && STYLE_PRESET_OPTIONS.includes(value as StylePreset)
		? value as StylePreset
		: DEFAULT_SETTINGS.stylePreset;
}

export function normalizeStyleScope(value: unknown): StyleScope {
	return typeof value === 'string' && STYLE_SCOPE_OPTIONS.includes(value as StyleScope)
		? value as StyleScope
		: DEFAULT_SETTINGS.styleScope;
}

export class AiSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AiRewritePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('AI 选区改写').setHeading();
		new Setting(containerEl)
			.setName('接口地址')
			.setDesc('默认 DeepSeek Chat Completions；已有配置不会覆盖。需支持流式 SSE 和浏览器跨域请求。')
			.addText((input) => input
				.setPlaceholder(DEFAULT_SETTINGS.endpoint)
				.setValue(this.plugin.settings.endpoint)
				.onChange(async (value) => {
					this.plugin.settings.endpoint = value.trim();
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('模型')
			.addText((input) => input
				.setPlaceholder(DEFAULT_SETTINGS.model)
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value.trim();
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('思考等级')
			.setDesc('服务默认不传控制参数（默认接口为高）；极高可能耗时更久。自定义接口需支持 reasoning_effort，否则请求会报错。思维链不会写入笔记。')
			.addDropdown((dropdown) => dropdown
				.addOptions({ default: '服务默认', none: '关闭', low: '低', high: '高', max: '极高' })
				.setValue(this.plugin.settings.reasoningEffort)
				.onChange(async (value) => {
					if (value !== 'default' && value !== 'none' && value !== 'low' && value !== 'high' && value !== 'max') return;
					this.plugin.settings.reasoningEffort = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('写作风格')
			.setDesc('简洁：信息密度优先，少用加粗、引用块、分隔线、emoji 和大表格；宽松：只延续笔记已有形态。生成新内容不产出大标题，小标题层级和写法跟随笔记；改写时保留原层级。')
			.addDropdown((dropdown) => dropdown
				.addOptions({ concise: '简洁（默认）', generic: '宽松' })
				.setValue(normalizeStylePreset(this.plugin.settings.stylePreset))
				.onChange(async (value) => {
					this.plugin.settings.stylePreset = normalizeStylePreset(value);
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('风格参考')
			.setDesc('把已有笔记正文作为形态样本发送，让生成结果延续你原来的写法。仅当前笔记最省；新建文档可用“当前笔记 + 同目录”，参考同目录最近 3 篇。样本会上传给 AI 服务。')
			.addDropdown((dropdown) => dropdown
				.addOptions({ note: '仅当前笔记（默认）', 'note-folder': '当前笔记 + 同目录', off: '不使用' })
				.setValue(normalizeStyleScope(this.plugin.settings.styleScope))
				.onChange(async (value) => {
					this.plugin.settings.styleScope = normalizeStyleScope(value);
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('上下文')
			.setDesc('提交时自动附带选区（或光标）前后的原文，帮助模型理解语境；超出上限的部分截断，选区本身不计入上限。0 表示不发送。')
			.addDropdown((dropdown) => dropdown
				.addOptions({ '0': '不发送', '1000': '1000 字', '2000': '2000 字', '4000': '4000 字（默认）', '8000': '8000 字', '16000': '16000 字' })
				.setValue(String(normalizeContextLimit(this.plugin.settings.contextLimit)))
				.onChange(async (value) => {
					this.plugin.settings.contextLimit = normalizeContextLimit(Number(value));
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('联网搜索')
			.setDesc('开启后模型可自行调用搜索接口联网检索网页，用于新闻、最新进展或事实核查；接口需支持工具调用（function calling），不支持时请求会报错。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.searchEnabled)
				.onChange(async (value) => {
					this.plugin.settings.searchEnabled = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('搜索接口地址')
			.setDesc('默认使用 DeepSeek 官方搜索接口；密钥会发送到此地址，请仅配置可信服务。')
			.addText((input) => input
				.setPlaceholder(DEFAULT_SEARCH_ENDPOINT)
				.setValue(this.plugin.settings.deepSeekSearchEndpoint)
				.onChange(async (value) => {
					this.plugin.settings.deepSeekSearchEndpoint = value.trim();
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('搜索 API 密钥')
			.setDesc('可选的 DeepSeek API 密钥；留空时使用下方 API 密钥。保存在本地插件 data.json（明文），旧搜索密钥不会自动使用。')
			.addText((input) => {
				input.inputEl.type = 'password';
				input.setPlaceholder('输入 API 密钥')
					.setValue(this.plugin.settings.deepSeekSearchApiKey)
					.onChange(async (value) => {
						this.plugin.settings.deepSeekSearchApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName('文件读取')
			.setDesc('开启后模型可调用只读的 read_file 工具读取你给出的本地路径；没有写入或修改能力。仅桌面版生效，文件内容会随请求发送给所配置的 AI 服务。')
			.addDropdown((dropdown) => dropdown
				.addOptions({ off: '关闭', vault: '仅笔记库', any: '允许任意本地路径' })
				.setValue(normalizeFileReadScope(this.plugin.settings.fileReadScope))
				.onChange(async (value) => {
					this.plugin.settings.fileReadScope = normalizeFileReadScope(value);
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('API 密钥')
			.setDesc('仅在提交改写时发送给所配置的服务；保存在本地插件 data.json（明文）。请勿同步或分享该文件。')
			.addText((input) => {
				input.inputEl.type = 'password';
				input.setPlaceholder('输入 API 密钥')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl).setName('隐私').setDesc('提交后将指令、选中文字、选区（或光标）前后受上限约束的上下文、风格样本（当前笔记去掉选区的正文，最多 8000 字；选择同目录时再加最近 3 篇、每篇最多 1500 字）、主动粘贴的图片及指令中链接的网页正文（最多 3 个，超限截断）发送到配置的服务；开启联网搜索时，模型会向搜索服务发送查询词并把检索结果一并交给模型；开启文件读取时，模型读取到的文件内容同样会随请求发送。不会发送文件名。');
	}
}
