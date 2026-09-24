import { App, PluginSettingTab, Setting } from 'obsidian';
import type AiRewritePlugin from './main';

export type ReasoningEffort = 'default' | 'none' | 'low' | 'high' | 'max';

export interface AiSettings {
	endpoint: string;
	apiKey: string;
	model: string;
	reasoningEffort: ReasoningEffort;
}

export const DEFAULT_SETTINGS: AiSettings = {
	endpoint: 'https://api.deepseek.com/chat/completions',
	apiKey: '',
	model: 'deepseek-flash',
	reasoningEffort: 'default',
};

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
		new Setting(containerEl).setName('隐私').setDesc('提交后将选中文本、指令及主动粘贴的图片发送到配置的服务；不会发送整篇笔记或文件名。');
	}
}
