const {
	Plugin,
	Notice,
	PluginSettingTab,
	Setting,
	MarkdownView,
	requestUrl,
	ItemView,
	TFile,
	Platform,
	Modal,
} = require('obsidian');

const VIEW_TYPE_LIFEUP_PANEL = 'lifeup-data-panel-view';
const LIFEUP_TASKS_BLOCK_START = '<!-- LIFEUP_TASKS_START -->';
const LIFEUP_TASKS_BLOCK_END = '<!-- LIFEUP_TASKS_END -->';
const SETTINGS_VERSION = 3;
const AI_KEYCHAIN_SERVICE = 'lifeup-todo-sync-plugin';
const AI_KEYCHAIN_ACCOUNT = 'ai-api-key';
const DEFAULT_AI_SYSTEM_PROMPT = [
	'你是任务分析助手。请根据用户给出的待办标题，输出 JSON。',
	'必须只返回 JSON，不要返回多余文本。',
	'字段：importance(1-4), difficulty(1-4), urgency(1-4), skill_id(1-6), deadline_text(字符串), reason(简短说明)。',
	'若无法判断 deadline_text，可给空字符串。',
].join('\n');
const DEFAULT_AI_USER_PROMPT = '待办标题：{{todoTitle}}\n请给出结构化评估。';
const DEFAULT_AI_SKILLS = [
	{ id: 1, description: '体能/健康' },
	{ id: 2, description: '学习/认知' },
	{ id: 3, description: '工作/产出' },
	{ id: 4, description: '关系/社交' },
	{ id: 5, description: '生活/家务' },
	{ id: 6, description: '长期目标/成长' },
];
const DEFAULT_AI_SKILLS_JSON = JSON.stringify(DEFAULT_AI_SKILLS, null, 2);

const DEFAULT_SETTINGS = {
	baseUrl: '',
	host: 'localhost',
	port: 8080,
	taskCategoryId: 0,
	defaultCoin: 0,
	goldItemId: 5,
	enableSkillQuery: false,
	diarySyncMode: 'manual',
	enableDiaryAutoSync: false,
	diaryFolder: '',
	diaryTitlePattern: '^\\d{4}-\\d{2}-\\d{2}$',
	onlySyncTodayDiary: false,
	enableFeelingSync: false,
	feelingPrefix: '> ',
	feelingCaptureMode: 'prefix-only',
	strictFeelingBinding: true,
	enableAiFeature: false,
	useSystemKeychain: true,
	aiApiBaseUrl: 'https://api.openai.com/v1/chat/completions',
	aiModel: 'gpt-4o-mini',
	aiApiKey: '',
	aiSystemPromptTemplate: DEFAULT_AI_SYSTEM_PROMPT,
	aiUserPromptTemplate: DEFAULT_AI_USER_PROMPT,
	aiSkillDefinitionsJson: DEFAULT_AI_SKILLS_JSON,
	enableTaskPullToDiary: false,
	taskPullMode: 'auto',
	pullTaskCategoryId: 0,
	pullSectionTitle: '## LifeUp 待办（自动写入）',
	diarySyncedMap: {},
	timeoutMs: 10000,
	settingsVersion: SETTINGS_VERSION,
};

class LifeUpTodoPlugin extends Plugin {
	async onload() {
		try {
			await this.loadSettings();
		} catch (err) {
			console.error('[lifeup-todo-plugin] 设置加载失败，回退默认配置:', err);
			this.settings = Object.assign({}, DEFAULT_SETTINGS, { settingsVersion: SETTINGS_VERSION });
			await this.saveSettings();
			new Notice('LifeUp 插件配置异常，已自动回退为默认设置');
		}
		this.dashboardState = {
			connected: false,
			lastError: '',
			data: null,
		};
		this.keytar = null;
		this.keytarReady = false;
		await this.initKeytar();
		this.autoSyncTimers = new Map();
		this.taskPullTimers = new Map();

		this.registerView(
			VIEW_TYPE_LIFEUP_PANEL,
			(leaf) => new LifeUpPanelView(leaf, this)
		);

		this.addSettingTab(new LifeUpSettingTab(this.app, this));

		this.addRibbonIcon('gauge', '打开 LifeUp 数据面板', async () => {
			await this.activatePanelView();
		});

		this.addRibbonIcon('list-todo', '同步当前日记待办到 LifeUp', async () => {
			await this.syncActiveDiaryFile({ notifyResult: true });
		});

		this.addRibbonIcon('download', '从 LifeUp 写入当前日记', async () => {
			await this.pullTasksToActiveDiary({ notifyResult: true });
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				if (!(view instanceof MarkdownView)) {
					return;
				}

				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line) || '';
				const singleTodo = this.extractTodoFromLine(lineText);
				const selectedTodoNodes = this.extractTodoTreeFromText(editor.getSelection());

				if (singleTodo) {
					menu.addItem((item) => {
						item
							.setTitle('写入 LifeUp：当前待办')
							.setIcon('check-circle')
							.onClick(async () => {
								await this.pushTodosToLifeUp([singleTodo]);
							});
					});

					if (this.settings.enableAiFeature) {
						menu.addItem((item) => {
							item
								.setTitle('AI 分析当前待办（预览）')
								.setIcon('sparkles')
								.onClick(async () => {
									await this.previewAiAnalysis(singleTodo);
								});
						});
					}
				}

				if (selectedTodoNodes.length > 0) {
					menu.addItem((item) => {
						item
							.setTitle(`写入 LifeUp：选中待办（${selectedTodoNodes.length}）`)
							.setIcon('list-checks')
							.onClick(async () => {
								await this.pushTodoNodesToLifeUp(selectedTodoNodes);
							});
					});
				}
			})
		);

		this.addCommand({
			id: 'send-current-todo-to-lifeup',
			name: '把光标所在待办写入 LifeUp',
			editorCallback: async (editor) => {
				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line) || '';
				const todo = this.extractTodoFromLine(lineText);
				if (!todo) {
					new Notice('当前行不是未完成待办（格式示例：- [ ] 任务）');
					return;
				}
				await this.pushTodosToLifeUp([todo]);
			},
		});

		this.addCommand({
			id: 'ai-analyze-current-todo-preview',
			name: 'AI 分析当前待办（预览）',
			editorCallback: async (editor) => {
				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line) || '';
				const todo = this.extractTodoFromLine(lineText);
				if (!todo) {
					new Notice('当前行不是未完成待办（格式示例：- [ ] 任务）');
					return;
				}
				await this.previewAiAnalysis(todo);
			},
		});

		this.addCommand({
			id: 'open-lifeup-data-panel',
			name: '打开 LifeUp 数据面板',
			callback: async () => {
				await this.activatePanelView();
			},
		});

		this.addCommand({
			id: 'test-lifeup-connection',
			name: '测试 LifeUp 连接',
			callback: async () => {
				await this.testConnection();
			},
		});

		this.addCommand({
			id: 'refresh-lifeup-dashboard-data',
			name: '刷新 LifeUp 数据面板',
			callback: async () => {
				await this.fetchDashboardData({ notifySuccess: true, notifyError: true });
				await this.refreshPanelView();
			},
		});

		this.addCommand({
			id: 'sync-diary-todos-to-lifeup',
			name: '同步当前日记待办到 LifeUp',
			checkCallback: (checking) => {
				const active = this.app.workspace.getActiveFile();
				const canRun = active instanceof TFile;
				if (!checking && canRun) {
					this.syncActiveDiaryFile({ notifyResult: true });
				}
				return canRun;
			},
		});

		this.addCommand({
			id: 'pull-lifeup-tasks-into-diary',
			name: '从 LifeUp 写入当前日记任务',
			checkCallback: (checking) => {
				const active = this.app.workspace.getActiveFile();
				const canRun = active instanceof TFile;
				if (!checking && canRun) {
					this.pullTasksToActiveDiary({ notifyResult: true });
				}
				return canRun;
			},
		});

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				this.scheduleDiaryAutoSync(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				this.scheduleDiaryAutoSync(file);
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) {
					return;
				}
				if (this.settings.diarySyncedMap && this.settings.diarySyncedMap[oldPath]) {
					this.settings.diarySyncedMap[file.path] = this.settings.diarySyncedMap[oldPath];
					delete this.settings.diarySyncedMap[oldPath];
					this.saveSettings();
				}
				this.scheduleDiaryAutoSync(file);
			})
		);

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				this.scheduleTaskPullToDiary(file);
			})
		);
	}

	onunload() {
		for (const timerId of this.autoSyncTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.autoSyncTimers.clear();
		for (const timerId of this.taskPullTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.taskPullTimers.clear();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_LIFEUP_PANEL);
	}

	async loadSettings() {
		const loadedRaw = await this.loadData();
		const loaded = (loadedRaw && typeof loadedRaw === 'object') ? loadedRaw : {};
		const migrated = this.migrateSettings(loaded);
		this.settings = this.sanitizeSettings(migrated);

		if (this.settings.settingsVersion !== SETTINGS_VERSION) {
			this.settings.settingsVersion = SETTINGS_VERSION;
		}

		const changed = JSON.stringify(loaded) !== JSON.stringify(this.settings);
		if (changed) {
			await this.saveSettings();
		}
	}

	migrateSettings(rawSettings) {
		const migrated = Object.assign({}, rawSettings || {});
		const currentVersion = Number(migrated.settingsVersion || 0);

		if (currentVersion < 1) {
			if (migrated.defaultGold != null && migrated.defaultCoin == null) {
				migrated.defaultCoin = migrated.defaultGold;
			}
			if (migrated.category != null && migrated.taskCategoryId == null) {
				migrated.taskCategoryId = migrated.category;
			}
			if (migrated.diarySyncMode == null) {
				migrated.diarySyncMode = migrated.enableDiaryAutoSync ? 'auto' : 'manual';
			}
			if (migrated.taskPullMode == null) {
				migrated.taskPullMode = 'auto';
			}
			if (migrated.feelingCaptureMode == null) {
				migrated.feelingCaptureMode = 'prefix-only';
			}
		}

		if (currentVersion < 2) {
			// Backward compatibility for older/custom field names.
			if (migrated.aiSystemPromptTemplate == null) {
				migrated.aiSystemPromptTemplate = migrated.aiSystemPrompt || migrated.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT;
			}
			if (migrated.aiUserPromptTemplate == null) {
				migrated.aiUserPromptTemplate = migrated.aiUserPrompt || migrated.userPrompt || DEFAULT_AI_USER_PROMPT;
			}

			if (typeof migrated.aiSystemPromptTemplate !== 'string' || !migrated.aiSystemPromptTemplate.trim()) {
				migrated.aiSystemPromptTemplate = DEFAULT_AI_SYSTEM_PROMPT;
			}
			if (typeof migrated.aiUserPromptTemplate !== 'string' || !migrated.aiUserPromptTemplate.trim()) {
				migrated.aiUserPromptTemplate = DEFAULT_AI_USER_PROMPT;
			}
		}

		if (currentVersion < 3) {
			if (migrated.aiSkillDefinitionsJson == null) {
				migrated.aiSkillDefinitionsJson = migrated.aiSkillsJson || migrated.skillDefinitionsJson || DEFAULT_AI_SKILLS_JSON;
			}
			if (typeof migrated.aiSkillDefinitionsJson !== 'string' || !migrated.aiSkillDefinitionsJson.trim()) {
				migrated.aiSkillDefinitionsJson = DEFAULT_AI_SKILLS_JSON;
			}
		}

		migrated.settingsVersion = SETTINGS_VERSION;
		return migrated;
	}

	sanitizeSettings(rawSettings) {
		const safe = Object.assign({}, DEFAULT_SETTINGS);
		const raw = rawSettings || {};

		safe.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl;
		safe.host = typeof raw.host === 'string' && raw.host.trim() ? raw.host : DEFAULT_SETTINGS.host;
		safe.port = this.sanitizeNumber(raw.port, DEFAULT_SETTINGS.port);
		safe.taskCategoryId = this.sanitizeNumber(raw.taskCategoryId, DEFAULT_SETTINGS.taskCategoryId);
		safe.defaultCoin = this.sanitizeNumber(raw.defaultCoin, DEFAULT_SETTINGS.defaultCoin);
		safe.goldItemId = this.sanitizeNumber(raw.goldItemId, DEFAULT_SETTINGS.goldItemId);
		safe.enableSkillQuery = Boolean(raw.enableSkillQuery);

		safe.diarySyncMode = ['manual', 'auto'].includes(raw.diarySyncMode)
			? raw.diarySyncMode
			: DEFAULT_SETTINGS.diarySyncMode;
		safe.enableDiaryAutoSync = safe.diarySyncMode === 'auto';
		safe.diaryFolder = typeof raw.diaryFolder === 'string' ? raw.diaryFolder : DEFAULT_SETTINGS.diaryFolder;
		safe.diaryTitlePattern = typeof raw.diaryTitlePattern === 'string'
			? raw.diaryTitlePattern
			: DEFAULT_SETTINGS.diaryTitlePattern;
		safe.onlySyncTodayDiary = Boolean(raw.onlySyncTodayDiary);

		safe.enableFeelingSync = Boolean(raw.enableFeelingSync);
		safe.feelingPrefix = typeof raw.feelingPrefix === 'string' && raw.feelingPrefix.length > 0
			? raw.feelingPrefix
			: DEFAULT_SETTINGS.feelingPrefix;
		safe.feelingCaptureMode = ['prefix-only', 'prefix-until-blank'].includes(raw.feelingCaptureMode)
			? raw.feelingCaptureMode
			: DEFAULT_SETTINGS.feelingCaptureMode;
		safe.strictFeelingBinding = raw.strictFeelingBinding == null
			? DEFAULT_SETTINGS.strictFeelingBinding
			: Boolean(raw.strictFeelingBinding);

		safe.enableAiFeature = Boolean(raw.enableAiFeature);
		safe.useSystemKeychain = raw.useSystemKeychain == null
			? DEFAULT_SETTINGS.useSystemKeychain
			: Boolean(raw.useSystemKeychain);
		safe.aiApiBaseUrl = typeof raw.aiApiBaseUrl === 'string' && raw.aiApiBaseUrl.trim()
			? raw.aiApiBaseUrl
			: DEFAULT_SETTINGS.aiApiBaseUrl;
		safe.aiModel = typeof raw.aiModel === 'string' && raw.aiModel.trim()
			? raw.aiModel
			: DEFAULT_SETTINGS.aiModel;
		safe.aiApiKey = typeof raw.aiApiKey === 'string'
			? raw.aiApiKey
			: DEFAULT_SETTINGS.aiApiKey;
		safe.aiSystemPromptTemplate = typeof raw.aiSystemPromptTemplate === 'string' && raw.aiSystemPromptTemplate.trim()
			? raw.aiSystemPromptTemplate
			: DEFAULT_SETTINGS.aiSystemPromptTemplate;
		safe.aiUserPromptTemplate = typeof raw.aiUserPromptTemplate === 'string' && raw.aiUserPromptTemplate.trim()
			? raw.aiUserPromptTemplate
			: DEFAULT_SETTINGS.aiUserPromptTemplate;
		safe.aiSkillDefinitionsJson = typeof raw.aiSkillDefinitionsJson === 'string' && raw.aiSkillDefinitionsJson.trim()
			? raw.aiSkillDefinitionsJson
			: DEFAULT_SETTINGS.aiSkillDefinitionsJson;

		safe.enableTaskPullToDiary = Boolean(raw.enableTaskPullToDiary);
		safe.taskPullMode = ['manual', 'auto'].includes(raw.taskPullMode)
			? raw.taskPullMode
			: DEFAULT_SETTINGS.taskPullMode;
		safe.pullTaskCategoryId = this.sanitizeNumber(raw.pullTaskCategoryId, DEFAULT_SETTINGS.pullTaskCategoryId);
		safe.pullSectionTitle = typeof raw.pullSectionTitle === 'string' && raw.pullSectionTitle.trim()
			? raw.pullSectionTitle
			: DEFAULT_SETTINGS.pullSectionTitle;

		if (raw.diarySyncedMap && typeof raw.diarySyncedMap === 'object' && !Array.isArray(raw.diarySyncedMap)) {
			safe.diarySyncedMap = raw.diarySyncedMap;
		} else {
			safe.diarySyncedMap = {};
		}

		safe.timeoutMs = this.sanitizeNumber(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs);
		safe.settingsVersion = SETTINGS_VERSION;
		return safe;
	}

	sanitizeNumber(value, fallback) {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async initKeytar() {
		this.keytar = null;
		this.keytarReady = false;

		if (!Platform.isDesktopApp || !this.settings.useSystemKeychain) {
			return;
		}

		try {
			// keytar is desktop-only and optional
			// eslint-disable-next-line global-require
			this.keytar = require('keytar');
			this.keytarReady = Boolean(this.keytar);
		} catch (err) {
			console.warn('[lifeup-todo-plugin] keytar 不可用，将回退到 data.json:', err);
			this.keytar = null;
			this.keytarReady = false;
		}
	}

	async getAiApiKey() {
		if (this.settings.useSystemKeychain && this.keytarReady) {
			try {
				const key = await this.keytar.getPassword(AI_KEYCHAIN_SERVICE, AI_KEYCHAIN_ACCOUNT);
				if (key) {
					return key;
				}
			} catch (err) {
				console.warn('[lifeup-todo-plugin] 读取钥匙串失败，回退 data.json:', err);
			}
		}

		return String(this.settings.aiApiKey || '');
	}

	async setAiApiKey(rawValue) {
		const key = String(rawValue || '').trim();

		if (this.settings.useSystemKeychain && this.keytarReady) {
			try {
				if (key) {
					await this.keytar.setPassword(AI_KEYCHAIN_SERVICE, AI_KEYCHAIN_ACCOUNT, key);
				} else {
					await this.keytar.deletePassword(AI_KEYCHAIN_SERVICE, AI_KEYCHAIN_ACCOUNT);
				}
				this.settings.aiApiKey = '';
				await this.saveSettings();
				return 'keychain';
			} catch (err) {
				console.warn('[lifeup-todo-plugin] 写入钥匙串失败，回退 data.json:', err);
			}
		}

		this.settings.aiApiKey = key;
		await this.saveSettings();
		return 'data';
	}

	getDefaultAiSystemPrompt() {
		const value = String(this.settings.aiSystemPromptTemplate || '').trim() || DEFAULT_AI_SYSTEM_PROMPT;
		const skillGuide = this.buildAiSkillGuideText();
		if (value.includes('{{skillGuide}}')) {
			return value.replace(/\{\{\s*skillGuide\s*\}\}/g, skillGuide);
		}
		return `${value}\n${skillGuide}`;
	}

	buildAiUserPrompt(todoTitle) {
		const template = String(this.settings.aiUserPromptTemplate || '').trim() || DEFAULT_AI_USER_PROMPT;
		const skillGuide = this.buildAiSkillGuideText();
		let prompt = template
			.replace(/\{\{\s*todoTitle\s*\}\}/g, String(todoTitle || '').trim())
			.replace(/\{\{\s*skillGuide\s*\}\}/g, skillGuide);

		if (!template.includes('{{skillGuide}}')) {
			prompt = `${prompt}\n${skillGuide}`;
		}
		return prompt;
	}

	getAiSkillDefinitions() {
		const raw = String(this.settings.aiSkillDefinitionsJson || '').trim();
		if (!raw) {
			return DEFAULT_AI_SKILLS;
		}

		try {
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return DEFAULT_AI_SKILLS;
			}

			const rows = [];
			const idSet = new Set();
			for (const item of parsed) {
				const id = Number(item?.id);
				if (!Number.isFinite(id)) {
					continue;
				}
				const safeId = Math.round(id);
				if (safeId <= 0 || idSet.has(safeId)) {
					continue;
				}
				idSet.add(safeId);
				rows.push({
					id: safeId,
					description: String(item?.description || item?.name || '').trim(),
				});
			}

			if (rows.length === 0) {
				return DEFAULT_AI_SKILLS;
			}

			return rows;
		} catch (_) {
			return DEFAULT_AI_SKILLS;
		}
	}

	buildAiSkillGuideText() {
		const skills = this.getAiSkillDefinitions();
		const ids = skills.map((s) => s.id);
		const detailLines = skills.map((s) => `- ${s.id}: ${s.description || '未命名技能'}`);
		return [
			`skill_id 可选数量：${skills.length}`,
			`skill_id 可选 ID：${ids.join(', ')}`,
			'技能说明：',
			...detailLines,
			'请只在上述 ID 中选择 skill_id。',
		].join('\n');
	}

	async promptTaskWriteOptions(todoTitle, initialOptions = {}) {
		return await new Promise((resolve) => {
			new TaskWriteOptionsModal(this.app, this, todoTitle, initialOptions, (payload) => resolve(payload)).open();
		});
	}

	parseJsonFromAiText(text) {
		const raw = String(text || '').trim();
		if (!raw) {
			throw new Error('AI 返回为空');
		}

		try {
			return JSON.parse(raw);
		} catch (_) {
			// try fenced json
			const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
			if (fenced && fenced[1]) {
				return JSON.parse(fenced[1].trim());
			}
		}

		throw new Error('AI 返回不是有效 JSON');
	}

	normalizeAiAnalysis(result) {
		const safeNum = (v, min, max, fallback) => {
			const n = Number(v);
			if (!Number.isFinite(n)) {
				return fallback;
			}
			if (n < min || n > max) {
				return fallback;
			}
			return Math.round(n);
		};

		const skills = this.getAiSkillDefinitions();
		const allowedSkillIds = new Set(skills.map((s) => s.id));
		const fallbackSkillId = skills[0]?.id || 1;
		const rawSkillId = Number(result?.skill_id);
		const normalizedSkillId = Number.isFinite(rawSkillId) && allowedSkillIds.has(Math.round(rawSkillId))
			? Math.round(rawSkillId)
			: fallbackSkillId;

		return {
			importance: safeNum(result?.importance, 1, 4, 2),
			difficulty: safeNum(result?.difficulty, 1, 4, 2),
			urgency: safeNum(result?.urgency, 1, 4, 2),
			skill_id: normalizedSkillId,
			deadline_text: String(result?.deadline_text || ''),
			reason: String(result?.reason || ''),
		};
	}

	async callAiChat(messages) {
		const apiKey = await this.getAiApiKey();
		if (!apiKey) {
			throw new Error('未配置 AI API Key');
		}

		const apiUrl = String(this.settings.aiApiBaseUrl || '').trim();
		if (!apiUrl) {
			throw new Error('未配置 AI API 地址');
		}

		const model = String(this.settings.aiModel || '').trim() || 'gpt-4o-mini';
		const res = await requestUrl({
			url: apiUrl,
			method: 'POST',
			throw: false,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model,
				messages,
				temperature: 0.3,
			}),
			timeout: Number(this.settings.timeoutMs) || 10000,
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`AI HTTP ${res.status}`);
		}

		const data = res.json || (res.text ? JSON.parse(res.text) : {});
		const content = data?.choices?.[0]?.message?.content;
		if (!content) {
			throw new Error('AI 响应无内容');
		}

		return String(content);
	}

	async analyzeTodoWithAi(todoTitle) {
		const systemPrompt = this.getDefaultAiSystemPrompt();
		const userPrompt = this.buildAiUserPrompt(todoTitle);
		const content = await this.callAiChat([
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		]);
		const parsed = this.parseJsonFromAiText(content);
		return this.normalizeAiAnalysis(parsed);
	}

	async previewAiAnalysis(todoTitle) {
		if (!this.settings.enableAiFeature) {
			new Notice('请先在设置中启用实验性 AI 功能');
			return;
		}

		try {
			new Notice('AI 分析中...');
			const analysis = await this.analyzeTodoWithAi(todoTitle);
			new AiAnalysisPreviewModal(this.app, this, todoTitle, analysis).open();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`AI 分析失败：${message}`);
		}
	}

	extractTodoFromLine(lineText) {
		const parsed = this.parseTodoLine(lineText);
		if (!parsed || parsed.checked) {
			return null;
		}
		return parsed.title;
	}

	parseTodoLine(lineText) {
		const match = String(lineText || '').match(/^(\s*)[-*+]\s*\[( |x|X)\]\s+(.+?)\s*$/);
		if (!match) {
			return null;
		}

		const indentRaw = (match[1] || '').replace(/\t/g, '    ');
		return {
			indent: indentRaw.length,
			checked: String(match[2]).toLowerCase() === 'x',
			title: String(match[3] || '').trim(),
		};
	}

	extractTodoTreeFromText(text) {
		if (!text || !String(text).trim()) {
			return [];
		}

		const lines = String(text).split(/\r?\n/);
		const roots = [];
		const stack = [];

		for (const line of lines) {
			const parsed = this.parseTodoLine(line);
			if (!parsed) {
				continue;
			}

			while (stack.length > 0 && stack[stack.length - 1].indent >= parsed.indent) {
				stack.pop();
			}

			const node = {
				title: parsed.title,
				checked: parsed.checked,
				children: [],
			};

			if (stack.length === 0) {
				if (parsed.checked) {
					continue;
				}
				roots.push(node);
				stack.push({ indent: parsed.indent, node });
				continue;
			}

			const parent = stack[stack.length - 1].node;
			parent.children.push(node);
			stack.push({ indent: parsed.indent, node });
		}

		return roots;
	}

	extractTodosFromSelection(selection) {
		if (!selection || !selection.trim()) {
			return [];
		}

		const lines = selection.split(/\r?\n/);
		const todos = [];
		for (const line of lines) {
			const todo = this.extractTodoFromLine(line);
			if (todo) {
				todos.push(todo);
			}
		}
		return todos;
	}

	buildLifeUpProxyUrl(targetUrl) {
		const encoded = encodeURIComponent(targetUrl);
		const baseUrl = this.resolveProxyBaseUrl();
		return `${baseUrl}/api/contentprovider?url=${encoded}`;
	}

	resolveProxyBaseUrl() {
		const rawBase = (this.settings.baseUrl || '').trim();
		if (rawBase) {
			return rawBase.replace(/\/+$/, '');
		}

		const host = (this.settings.host || 'localhost').trim() || 'localhost';
		const port = Number(this.settings.port) || 8080;
		const hasProtocol = /^https?:\/\//i.test(host);
		const normalizedHost = hasProtocol ? host : `http://${host}`;

		try {
			const parsed = new URL(normalizedHost);
			if (parsed.port) {
				return normalizedHost.replace(/\/+$/, '');
			}
		} catch (_) {
			// 解析失败时降级为原有拼接行为
		}

		return `${normalizedHost.replace(/\/+$/, '')}:${port}`;
	}

	validateProxyBaseUrl(rawValue) {
		const value = (rawValue || '').trim();
		if (!value) {
			return { ok: true, message: '未填写时将使用“主机 + 端口”兼容配置。' };
		}

		if (!/^https?:\/\//i.test(value)) {
			return { ok: false, message: '必须以 http:// 或 https:// 开头。' };
		}

		try {
			const parsed = new URL(value);
			if (!parsed.hostname) {
				return { ok: false, message: '地址缺少主机/IP。' };
			}
			if (!parsed.port) {
				return { ok: false, message: '建议包含端口，例如 :8080。' };
			}
			if (parsed.pathname && parsed.pathname !== '/' && parsed.pathname !== '') {
				return { ok: false, message: '只填写基础地址，不要包含路径。示例：https://192.168.1.10:8080' };
			}
			return { ok: true, message: '地址格式有效。' };
		} catch (_) {
			return { ok: false, message: '地址格式无效。示例：https://192.168.1.10:8080' };
		}
	}

	async callLifeUpApi(targetUrl) {
		const proxyUrl = this.buildLifeUpProxyUrl(targetUrl);
		const res = await requestUrl({
			url: proxyUrl,
			method: 'GET',
			throw: false,
			timeout: Number(this.settings.timeoutMs) || 10000,
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`HTTP ${res.status}`);
		}

		if (res.json != null) {
			return this.unwrapCloudResponse(res.json);
		}

		if (res.text) {
			try {
				return this.unwrapCloudResponse(JSON.parse(res.text));
			} catch (_) {
				return { raw: res.text };
			}
		}

		return {};
	}

	async callLifeUpCloud(path) {
		const baseUrl = this.resolveProxyBaseUrl();
		const normalizedPath = path.startsWith('/') ? path : `/${path}`;
		const url = `${baseUrl}${normalizedPath}`;
		const res = await requestUrl({
			url,
			method: 'GET',
			throw: false,
			timeout: Number(this.settings.timeoutMs) || 10000,
		});

		if (res.status < 200 || res.status >= 300) {
			throw new Error(`HTTP ${res.status}`);
		}

		if (res.json != null) {
			return this.unwrapCloudResponse(res.json);
		}

		if (res.text) {
			try {
				return this.unwrapCloudResponse(JSON.parse(res.text));
			} catch (_) {
				return { raw: res.text };
			}
		}

		return {};
	}

	unwrapCloudResponse(payload) {
		if (!payload || typeof payload !== 'object') {
			return payload;
		}

		const hasCloudEnvelope = Object.prototype.hasOwnProperty.call(payload, 'code')
			&& Object.prototype.hasOwnProperty.call(payload, 'data')
			&& Array.isArray(payload.data);

		if (!hasCloudEnvelope) {
			return payload;
		}

		const code = Number(payload.code);
		if (Number.isFinite(code) && code >= 400) {
			const message = payload.message || `Cloud API error ${code}`;
			throw new Error(String(message));
		}

		const items = payload.data;
		if (items.length === 0) {
			return {};
		}

		if (items.length === 1) {
			const single = items[0];
			if (single && typeof single === 'object' && Object.prototype.hasOwnProperty.call(single, 'result')) {
				return single.result;
			}
			return single;
		}

		return items.map((item) => {
			if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'result')) {
				return item.result;
			}
			return item;
		});
	}

	buildTodoNodeSignature(node) {
		if (!node) {
			return '';
		}
		const title = String(node.title || '').trim();
		const state = node.checked ? '1' : '0';
		const children = Array.isArray(node.children)
			? node.children.map((child) => this.buildTodoNodeSignature(child)).join('|')
			: '';
		return `${title}#${state}[${children}]`;
	}

	async querySimple(key, extraParams = {}) {
		const params = new URLSearchParams({ key });
		for (const [k, v] of Object.entries(extraParams)) {
			if (v != null && String(v) !== '') {
				params.append(k, String(v));
			}
		}
		const apiUrl = `lifeup://api/query?${params.toString()}`;
		return await this.callLifeUpApi(apiUrl);
	}

	readNumberField(source, keys, fallback = null) {
		if (!source || typeof source !== 'object') {
			return fallback;
		}

		for (const key of keys) {
			if (source[key] == null) {
				continue;
			}
			const num = Number(source[key]);
			if (Number.isFinite(num)) {
				return num;
			}
		}

		return fallback;
	}

	async fetchDashboardData(options = {}) {
		const { notifySuccess = false, notifyError = false } = options;
		try {
			const coinRaw = await this.querySimple('coin');
			const tomatoRaw = await this.querySimple('tomato');

			const goldItemId = Number(this.settings.goldItemId) || 0;
			let itemRaw = null;
			if (goldItemId > 0) {
				itemRaw = await this.querySimple('item', { item_id: goldItemId });
			}

			let skills = [];
			if (this.settings.enableSkillQuery) {
				const skillDefs = this.getAiSkillDefinitions();
				for (const skillDef of skillDefs) {
					const skillId = Number(skillDef.id);
					const fallbackName = String(skillDef.description || `属性${skillId}`);
					try {
						const raw = await this.callLifeUpApi(`lifeup://api/query_skill?id=${skillId}`);
						skills.push({
							id: skillId,
							name: raw?.name ?? fallbackName,
							level: this.readNumberField(raw, ['level']),
							totalExp: this.readNumberField(raw, ['total_exp']),
							currentLevelExp: this.readNumberField(raw, ['current_level_exp']),
							untilNextLevelExp: this.readNumberField(raw, ['until_next_level_exp']),
						});
					} catch (_) {
						skills.push({
							id: skillId,
							name: fallbackName,
							level: null,
							totalExp: null,
							currentLevelExp: null,
							untilNextLevelExp: null,
						});
					}
				}
			}

			const data = {
				coin: this.readNumberField(coinRaw, ['value', 'coin']),
				tomatoAvailable: this.readNumberField(tomatoRaw, ['available']),
				tomatoTotal: this.readNumberField(tomatoRaw, ['total']),
				tomatoExchanged: this.readNumberField(tomatoRaw, ['exchanged']),
				goldOwn: itemRaw ? this.readNumberField(itemRaw, ['own_number', 'value']) : null,
				goldItemId: goldItemId > 0 ? goldItemId : null,
				skills,
				updatedAt: new Date().toLocaleString(),
			};

			this.dashboardState.connected = true;
			this.dashboardState.lastError = '';
			this.dashboardState.data = data;

			if (notifySuccess) {
				new Notice('LifeUp 数据读取成功');
			}

			return data;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.dashboardState.connected = false;
			this.dashboardState.lastError = message;

			if (notifyError) {
				new Notice(`LifeUp 连接失败：${message}`);
			}
			throw err;
		}
	}

	async testConnection() {
		try {
			await this.querySimple('coin');
			this.dashboardState.connected = true;
			this.dashboardState.lastError = '';
			new Notice('LifeUp 连接成功');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.dashboardState.connected = false;
			this.dashboardState.lastError = message;
			new Notice(`LifeUp 连接失败：${message}`);
		}

		await this.refreshPanelView();
	}

	async activatePanelView() {
		const workspace = this.app.workspace;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_LIFEUP_PANEL)[0];

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({
				type: VIEW_TYPE_LIFEUP_PANEL,
				active: true,
			});
		}

		await workspace.revealLeaf(leaf);
		await this.refreshPanelView();
	}

	async refreshPanelView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIFEUP_PANEL);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view && typeof view.refresh === 'function') {
				await view.refresh();
			}
		}
	}

	async createLifeUpTask(title) {
		return await this.createLifeUpTaskAdvanced(title, {});
	}

	parseDeadlineTextToTimestamp(deadlineText) {
		const raw = String(deadlineText || '').trim();
		if (!raw) {
			return null;
		}

		if (/^\d{12,14}$/.test(raw)) {
			const ts = Number(raw);
			return Number.isFinite(ts) ? ts : null;
		}

		const zhMatch = raw.match(/^(今天|明天)\s*(\d{1,2}):(\d{2})$/);
		if (zhMatch) {
			const base = new Date();
			if (zhMatch[1] === '明天') {
				base.setDate(base.getDate() + 1);
			}
			const h = Number(zhMatch[2]);
			const m = Number(zhMatch[3]);
			if (Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
				base.setHours(h, m, 0, 0);
				return base.getTime();
			}
		}

		const parsed = new Date(raw);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed.getTime();
		}

		return null;
	}

	async createLifeUpTaskAdvanced(title, options = {}) {
		const coin = Number(this.settings.defaultCoin) || 0;
		const category = Number(this.settings.taskCategoryId) || 0;
		const params = new URLSearchParams();
		params.append('todo', String(title || '').trim());
		params.append('category', String(category));
		params.append('coin', String(coin));

		const importance = Number(options.importance);
		if (Number.isFinite(importance) && importance >= 1 && importance <= 4) {
			params.append('importance', String(Math.round(importance)));
		}

		const difficulty = Number(options.difficulty);
		if (Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 4) {
			params.append('difficulty', String(Math.round(difficulty)));
		}

		const skillId = Number(options.skill_id);
		if (Number.isFinite(skillId) && skillId > 0) {
			params.append('skills', String(Math.round(skillId)));
		}

		const deadlineTs = this.parseDeadlineTextToTimestamp(options.deadline_text);
		if (deadlineTs) {
			params.append('deadline', String(deadlineTs));
		}

		const noteParts = [];
		if (options.reason) {
			noteParts.push(`AI说明: ${String(options.reason).trim()}`);
		}
		const urgency = Number(options.urgency);
		if (Number.isFinite(urgency) && urgency >= 1 && urgency <= 4) {
			noteParts.push(`AI紧急度: ${Math.round(urgency)}`);
		}
		if (noteParts.length > 0) {
			params.append('notes', noteParts.join('\n'));
		}

		// URLSearchParams encodes spaces as '+', but LifeUp add_task expects '%20'.
		const queryString = params.toString().replace(/\+/g, '%20');
		const apiUrl = `lifeup://api/add_task?${queryString}`;
		return await this.callLifeUpApi(apiUrl);
	}

	async createLifeUpSubtask(mainTaskId, title) {
		const safeTitle = encodeURIComponent(title);
		const apiUrl = `lifeup://api/subtask?main_id=${mainTaskId}&todo=${safeTitle}`;
		return await this.callLifeUpApi(apiUrl);
	}

	async completeLifeUpSubtask(mainTaskId, subtaskId) {
		const apiUrl = `lifeup://api/subtask_operation?main_id=${mainTaskId}&edit_id=${subtaskId}&operation=complete`;
		return await this.callLifeUpApi(apiUrl);
	}

	extractFirstNumber(source, keys) {
		if (!source || typeof source !== 'object') {
			return null;
		}
		for (const key of keys) {
			const value = Number(source[key]);
			if (Number.isFinite(value)) {
				return value;
			}
		}
		return null;
	}

	async createLifeUpTaskWithSubtasks(node, mainTaskOptions = {}) {
		const createdTask = await this.createLifeUpTaskAdvanced(node.title, mainTaskOptions);
		const taskId = this.extractFirstNumber(createdTask, ['task_id', '_ID', 'id']);

		if (!Array.isArray(node.children) || node.children.length === 0) {
			return { taskId };
		}

		if (!taskId) {
			throw new Error('主任务创建成功，但返回中缺少 task_id，无法创建子任务');
		}

		const flattenedChildren = this.flattenSubtaskNodes(node.children);

		for (const child of flattenedChildren) {
			const subtaskRes = await this.createLifeUpSubtask(taskId, child.title);
			if (child.checked) {
				const subtaskId = this.extractFirstNumber(subtaskRes, ['subtask_id', 'edit_id', 'id']);
				if (subtaskId) {
					await this.completeLifeUpSubtask(taskId, subtaskId);
				}
			}
		}

		return { taskId };
	}

	getFeelingPrefix() {
		const raw = String(this.settings.feelingPrefix || '').trim();
		return raw || '>';
	}

	lineHasFeelingPrefix(lineText) {
		const prefix = this.getFeelingPrefix();
		const line = String(lineText || '').trimStart();
		if (!line.startsWith(prefix)) {
			return false;
		}
		return true;
	}

	extractFeelingContentFromLine(lineText) {
		const prefix = this.getFeelingPrefix();
		const line = String(lineText || '').trimStart();
		if (!line.startsWith(prefix)) {
			return null;
		}
		return line.slice(prefix.length).trim();
	}

	extractFeelingBlocksFromText(text) {
		const lines = String(text || '').split(/\r?\n/);
		const blocks = [];

		let recentRootTitle = null;
		let canBindToRecentRoot = false;
		let inManagedBlock = false;

		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			const trimmed = line.trim();

			if (trimmed === LIFEUP_TASKS_BLOCK_START) {
				inManagedBlock = true;
				continue;
			}
			if (trimmed === LIFEUP_TASKS_BLOCK_END) {
				inManagedBlock = false;
				continue;
			}
			if (inManagedBlock) {
				continue;
			}

			const todo = this.parseTodoLine(line);
			if (todo) {
				if (todo.indent === 0) {
					recentRootTitle = todo.title;
				}
				canBindToRecentRoot = Boolean(recentRootTitle);
				continue;
			}

			if (!trimmed) {
				canBindToRecentRoot = false;
				continue;
			}

			if (this.lineHasFeelingPrefix(line)) {
				const parts = [];
				let j = i;

				if (this.settings.feelingCaptureMode === 'prefix-until-blank') {
					while (j < lines.length) {
						const currentLine = lines[j];
						const currentTrimmed = currentLine.trim();

						if (!currentTrimmed) {
							break;
						}
						if (currentTrimmed === LIFEUP_TASKS_BLOCK_START || currentTrimmed === LIFEUP_TASKS_BLOCK_END) {
							break;
						}
						if (j !== i && this.parseTodoLine(currentLine)) {
							break;
						}

						if (this.lineHasFeelingPrefix(currentLine)) {
							const content = this.extractFeelingContentFromLine(currentLine);
							if (content) {
								parts.push(content);
							}
						} else {
							parts.push(currentLine.trim());
						}

						j += 1;
					}
				} else {
					while (j < lines.length && this.lineHasFeelingPrefix(lines[j])) {
						const content = this.extractFeelingContentFromLine(lines[j]);
						if (content) {
							parts.push(content);
						}
						j += 1;
					}
				}

				if (parts.length > 0) {
					const content = parts.join('\n');
					const bindByAdjacency = canBindToRecentRoot && Boolean(recentRootTitle);
					const relatedRootTitle = bindByAdjacency ? recentRootTitle : null;
					blocks.push({
						content,
						relatedRootTitle,
						strictOnly: Boolean(this.settings.strictFeelingBinding),
					});
				}

				i = j - 1;
				if (!this.settings.strictFeelingBinding) {
					canBindToRecentRoot = bindByAdjacency;
				} else {
					canBindToRecentRoot = false;
				}
				continue;
			}

			canBindToRecentRoot = false;
		}

		return blocks;
	}

	async createLifeUpFeeling(content, relatedTaskId = null) {
		const safeContent = encodeURIComponent(String(content || '').trim());
		if (!safeContent) {
			return null;
		}

		let apiUrl = `lifeup://api/feeling?content=${safeContent}`;
		if (relatedTaskId != null) {
			apiUrl += `&relate_type=0&relate_id=${Number(relatedTaskId)}`;
		}
		return await this.callLifeUpApi(apiUrl);
	}

	async resolveTaskIdByTitle(taskTitle) {
		if (!taskTitle) {
			return null;
		}
		try {
			const taskRaw = await this.querySimple('task', { task_name: taskTitle, withSubTasks: true });
			return this.extractFirstNumber(taskRaw, ['_ID', 'task_id', 'id']);
		} catch (_) {
			return null;
		}
	}

	flattenSubtaskNodes(children, ancestors = []) {
		if (!Array.isArray(children) || children.length === 0) {
			return [];
		}

		const rows = [];
		for (const child of children) {
			const currentPath = [...ancestors, child.title];
			const displayTitle = currentPath.join(' > ');
			rows.push({
				title: displayTitle,
				checked: Boolean(child.checked),
			});

			if (Array.isArray(child.children) && child.children.length > 0) {
				rows.push(...this.flattenSubtaskNodes(child.children, currentPath));
			}
		}

		return rows;
	}

	normalizeTaskListPayload(payload) {
		if (Array.isArray(payload)) {
			return payload;
		}
		if (payload && typeof payload === 'object') {
			if (Array.isArray(payload.tasks)) {
				return payload.tasks;
			}
			if (Array.isArray(payload.data)) {
				return payload.data;
			}
		}
		return [];
	}

	parseSubTasksValue(subTasksValue) {
		if (Array.isArray(subTasksValue)) {
			return subTasksValue;
		}
		if (typeof subTasksValue === 'string' && subTasksValue.trim()) {
			try {
				const parsed = JSON.parse(subTasksValue);
				return Array.isArray(parsed) ? parsed : [];
			} catch (_) {
				return [];
			}
		}
		return [];
	}

	renderLifeUpTasksMarkdown(tasks, categoryId) {
		const sectionTitle = (this.settings.pullSectionTitle || '').trim() || '## LifeUp 待办（自动写入）';
		const lines = [];
		lines.push(LIFEUP_TASKS_BLOCK_START);
		lines.push(sectionTitle);
		lines.push(`> categoryId: ${categoryId} | updated: ${new Date().toLocaleString()}`);
		lines.push('');

		if (!tasks || tasks.length === 0) {
			lines.push('- [ ] （该清单暂无任务）');
		} else {
			for (const task of tasks) {
				const taskName = String(task?.name || task?.todo || '未命名任务').trim();
				const statusNum = Number(task?.status);
				const done = Number.isFinite(statusNum) ? statusNum === 1 : false;
				lines.push(`- [${done ? 'x' : ' '}] ${taskName}`);

				const subTasks = this.parseSubTasksValue(task?.subTasks);
				for (const subTask of subTasks) {
					const subName = String(subTask?.todo || subTask?.name || '未命名子任务').trim();
					const subStatusNum = Number(subTask?.status);
					const subDone = Number.isFinite(subStatusNum) ? subStatusNum === 1 : false;
					lines.push(`  - [${subDone ? 'x' : ' '}] ${subName}`);
				}
			}
		}

		lines.push('');
		lines.push(LIFEUP_TASKS_BLOCK_END);
		return lines.join('\n');
	}

	replaceManagedLifeUpTasksBlock(sourceText, newBlock) {
		const text = String(sourceText || '');
		const blockRegex = new RegExp(`${LIFEUP_TASKS_BLOCK_START}[\\s\\S]*?${LIFEUP_TASKS_BLOCK_END}`);
		if (blockRegex.test(text)) {
			return text.replace(blockRegex, newBlock);
		}

		const trimmed = text.replace(/\s+$/, '');
		if (!trimmed) {
			return `${newBlock}\n`;
		}
		return `${trimmed}\n\n${newBlock}\n`;
	}

	stripManagedLifeUpTasksBlock(sourceText) {
		const text = String(sourceText || '');
		const blockRegex = new RegExp(`${LIFEUP_TASKS_BLOCK_START}[\\s\\S]*?${LIFEUP_TASKS_BLOCK_END}`, 'g');
		return text.replace(blockRegex, '').trim();
	}

	async pullTasksToDiaryFile(file, options = {}) {
		const { notifyResult = false } = options;
		const mismatchReason = this.getDiaryFileMismatchReason(file);
		if (mismatchReason) {
			if (notifyResult) {
				new Notice(`未写入日记：${mismatchReason}`);
			}
			return false;
		}

		const categoryId = Number(this.settings.pullTaskCategoryId);
		if (!Number.isFinite(categoryId) || categoryId < 0) {
			if (notifyResult) {
				new Notice('未写入日记：请先设置“拉取任务清单 ID”');
			}
			return false;
		}

		const payload = await this.callLifeUpCloud(`/tasks/${categoryId}`);
		const tasks = this.normalizeTaskListPayload(payload);
		const block = this.renderLifeUpTasksMarkdown(tasks, categoryId);
		const currentText = await this.app.vault.cachedRead(file);
		const nextText = this.replaceManagedLifeUpTasksBlock(currentText, block);

		if (nextText !== currentText) {
			await this.app.vault.modify(file, nextText);
		}

		if (notifyResult) {
			new Notice(`已写入日记：${tasks.length} 条 LifeUp 任务`);
		}
		return true;
	}

	async pullTasksToActiveDiary(options = {}) {
		const active = this.app.workspace.getActiveFile();
		if (!(active instanceof TFile)) {
			if (options.notifyResult) {
				new Notice('当前没有可写入的日记文件');
			}
			return false;
		}
		return await this.pullTasksToDiaryFile(active, options);
	}

	scheduleTaskPullToDiary(file) {
		if (!this.settings.enableTaskPullToDiary) {
			return;
		}
		if (this.settings.taskPullMode !== 'auto') {
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		if (!this.isDiaryFileMatch(file)) {
			return;
		}

		const prev = this.taskPullTimers.get(file.path);
		if (prev) {
			window.clearTimeout(prev);
		}

		const timerId = window.setTimeout(async () => {
			this.taskPullTimers.delete(file.path);
			try {
				await this.pullTasksToDiaryFile(file, { notifyResult: false });
			} catch (err) {
				console.error('[lifeup-todo-plugin] 自动写入日记失败:', err);
			}
		}, 500);

		this.taskPullTimers.set(file.path, timerId);
	}

	getDiaryTitleRegex() {
		const rawPattern = (this.settings.diaryTitlePattern || '').trim();
		if (!rawPattern) {
			return null;
		}
		try {
			return new RegExp(rawPattern);
		} catch (_) {
			return null;
		}
	}

	normalizeFolderPath(folderPath) {
		return (folderPath || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	}

	isDiaryFileMatch(file) {
		return this.getDiaryFileMismatchReason(file) === null;
	}

	getDiaryFileMismatchReason(file) {
		if (!(file instanceof TFile)) {
			return '当前不是文件';
		}
		if (file.extension !== 'md') {
			return '当前文件不是 Markdown';
		}

		const folder = this.normalizeFolderPath(this.settings.diaryFolder);
		if (!folder) {
			return '未配置“日记文件夹”';
		}

		const filePath = (file.path || '').replace(/\\/g, '/');
		const inFolder = filePath === folder || filePath.startsWith(`${folder}/`);
		if (!inFolder) {
			return `文件不在日记文件夹下（当前：${filePath}，配置：${folder}）`;
		}

		const titleRegex = this.getDiaryTitleRegex();
		if (!titleRegex) {
			return '日记标题正则无效';
		}

		if (!titleRegex.test(file.basename)) {
			return `文件名不匹配标题正则（当前：${file.basename}）`;
		}

		if (this.settings.onlySyncTodayDiary) {
			const todayTitle = this.getLocalDateTitle();
			if (file.basename !== todayTitle) {
				return `已启用“仅同步本地今天”，当前文件名应为 ${todayTitle}`;
			}
		}

		return null;
	}

	getLocalDateTitle() {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	scheduleDiaryAutoSync(file) {
		if (this.settings.diarySyncMode !== 'auto') {
			return;
		}
		if (!(file instanceof TFile)) {
			return;
		}
		if (!this.isDiaryFileMatch(file)) {
			return;
		}

		const prev = this.autoSyncTimers.get(file.path);
		if (prev) {
			window.clearTimeout(prev);
		}

		const timerId = window.setTimeout(async () => {
			this.autoSyncTimers.delete(file.path);
			await this.syncDiaryFileTodos(file, { notifyResult: false });
		}, 1200);

		this.autoSyncTimers.set(file.path, timerId);
	}

	async syncActiveDiaryFile(options = {}) {
		const active = this.app.workspace.getActiveFile();
		if (!(active instanceof TFile)) {
			if (options.notifyResult) {
				new Notice('当前没有可同步的文件');
			}
			return { success: 0, failed: 0, skipped: 0 };
		}
		return await this.syncDiaryFileTodos(active, options);
	}

	extractTodoTitlesFromText(text) {
		const roots = this.extractTodoTreeFromText(text);
		return roots.map((node) => node.title);
	}

	async syncDiaryFileTodos(file, options = {}) {
		const { notifyResult = false } = options;
		const mismatchReason = this.getDiaryFileMismatchReason(file);
		if (mismatchReason) {
			if (notifyResult) {
				new Notice(`未执行日记同步：${mismatchReason}`);
			}
			return { success: 0, failed: 0, skipped: 0 };
		}

		const content = await this.app.vault.cachedRead(file);
		const syncContent = this.stripManagedLifeUpTasksBlock(content);
		const currentTodoNodes = this.extractTodoTreeFromText(syncContent);
		if (currentTodoNodes.length === 0) {
			return { success: 0, failed: 0, skipped: 0 };
		}

		const syncedMap = this.settings.diarySyncedMap || {};
		const syncedList = Array.isArray(syncedMap[file.path]) ? syncedMap[file.path] : [];
		const syncedSet = new Set(syncedList);
		const taskIdMap = new Map();

		let success = 0;
		let failed = 0;
		let skipped = 0;
		let feelingSuccess = 0;
		let feelingFailed = 0;
		let feelingSkipped = 0;

		for (const node of currentTodoNodes) {
			const signature = this.buildTodoNodeSignature(node);
			if (syncedSet.has(signature) || syncedSet.has(node.title)) {
				skipped += 1;
				continue;
			}

			try {
				const created = await this.createLifeUpTaskWithSubtasks(node);
				const createdTaskId = this.extractFirstNumber(created, ['taskId']);
				if (createdTaskId) {
					taskIdMap.set(node.title, createdTaskId);
				}
				syncedSet.add(signature);
				syncedSet.add(node.title);
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 自动同步失败:', node.title, err);
			}
		}

		if (this.settings.enableFeelingSync) {
			const feelingBlocks = this.extractFeelingBlocksFromText(syncContent);
			for (const block of feelingBlocks) {
				const relatedTitle = block.relatedRootTitle || '';
				const feelingSignature = `feeling:${relatedTitle}:${block.content}`;
				if (syncedSet.has(feelingSignature)) {
					feelingSkipped += 1;
					continue;
				}

				let relatedTaskId = null;
				if (relatedTitle) {
					relatedTaskId = taskIdMap.get(relatedTitle) || null;
					if (!relatedTaskId) {
						relatedTaskId = await this.resolveTaskIdByTitle(relatedTitle);
						if (relatedTaskId) {
							taskIdMap.set(relatedTitle, relatedTaskId);
						}
					}
				}

				try {
					await this.createLifeUpFeeling(block.content, relatedTaskId);
					syncedSet.add(feelingSignature);
					feelingSuccess += 1;
				} catch (err) {
					feelingFailed += 1;
					console.error('[lifeup-todo-plugin] 感想同步失败:', block.content, err);
				}
			}
		}

		syncedMap[file.path] = Array.from(syncedSet);
		this.settings.diarySyncedMap = syncedMap;
		await this.saveSettings();

		if (notifyResult) {
			if (this.settings.enableFeelingSync) {
				new Notice(`日记同步完成：任务 新增 ${success}/跳过 ${skipped}/失败 ${failed}；感想 新增 ${feelingSuccess}/跳过 ${feelingSkipped}/失败 ${feelingFailed}`);
			} else {
				new Notice(`日记同步完成：新增 ${success}，跳过 ${skipped}，失败 ${failed}`);
			}
		}

		return { success, failed, skipped, feelingSuccess, feelingFailed, feelingSkipped };
	}

	async pushTodosToLifeUp(todoTitles) {
		if (!todoTitles || todoTitles.length === 0) {
			new Notice('没有可写入的待办');
			return;
		}

		let success = 0;
		let failed = 0;
		let cancelled = 0;

		for (const title of todoTitles) {
			try {
				const modalResult = await this.promptTaskWriteOptions(title, {});
				if (!modalResult || !modalResult.confirmed) {
					cancelled += 1;
					continue;
				}

				await this.createLifeUpTaskAdvanced(title, modalResult.options || {});
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 创建任务失败:', title, err);
			}
		}

		if (failed === 0 && cancelled === 0) {
			new Notice(`已写入 LifeUp：${success} 条待办`);
			return;
		}

		new Notice(`写入完成：成功 ${success}，取消 ${cancelled}，失败 ${failed}`);
	}

	async pushTodoNodesToLifeUp(todoNodes) {
		if (!todoNodes || todoNodes.length === 0) {
			new Notice('没有可写入的待办');
			return;
		}

		let success = 0;
		let failed = 0;
		let cancelled = 0;

		for (const node of todoNodes) {
			try {
				const modalResult = await this.promptTaskWriteOptions(node.title, {});
				if (!modalResult || !modalResult.confirmed) {
					cancelled += 1;
					continue;
				}

				await this.createLifeUpTaskWithSubtasks(node, modalResult.options || {});
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 创建树形任务失败:', node.title, err);
			}
		}

		if (failed === 0 && cancelled === 0) {
			new Notice(`已写入 LifeUp：${success} 条待办`);
			return;
		}

		new Notice(`写入完成：成功 ${success}，取消 ${cancelled}，失败 ${failed}`);
	}
}

class LifeUpPanelView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_LIFEUP_PANEL;
	}

	getDisplayText() {
		return 'LifeUp 数据面板';
	}

	getIcon() {
		return 'gauge';
	}

	async onOpen() {
		await this.refresh();
	}

	async refresh() {
		try {
			await this.plugin.fetchDashboardData();
		} catch (_) {
			// 已写入连接状态与错误信息
		}

		const container = this.contentEl;
		container.empty();
		container.addClass('lifeup-panel');

		container.createEl('h3', { text: 'LifeUp 数据面板' });

		const statusText = this.plugin.dashboardState.connected ? '已连接' : '未连接';
		const statusLine = container.createEl('div', { text: `连接状态：${statusText}` });
		statusLine.addClass('lifeup-panel-status');

		if (this.plugin.dashboardState.lastError) {
			const errorLine = container.createEl('div', { text: `错误：${this.plugin.dashboardState.lastError}` });
			errorLine.addClass('lifeup-panel-error');
		}

		const buttonRow = container.createDiv({ cls: 'lifeup-panel-actions' });
		const connectBtn = buttonRow.createEl('button', { text: '连接测试' });
		const refreshBtn = buttonRow.createEl('button', { text: '刷新数据' });

		connectBtn.addEventListener('click', async () => {
			await this.plugin.testConnection();
			await this.refresh();
		});

		refreshBtn.addEventListener('click', async () => {
			try {
				await this.plugin.fetchDashboardData({ notifySuccess: true, notifyError: true });
			} catch (_) {
				// 已通知
			}
			await this.refresh();
		});

		const data = this.plugin.dashboardState.data;
		if (!data) {
			container.createEl('div', { text: '暂无数据，请先连接并刷新。' });
			return;
		}

		const list = container.createEl('ul', { cls: 'lifeup-panel-list' });
		this.renderRow(list, '金币', data.coin);
		this.renderRow(list, '可用番茄', data.tomatoAvailable);
		this.renderRow(list, '总番茄', data.tomatoTotal);
		this.renderRow(list, '已兑换番茄', data.tomatoExchanged);

		if (data.goldItemId) {
			this.renderRow(list, `物品(${data.goldItemId})拥有数`, data.goldOwn);
		}

		if (this.plugin.settings.enableSkillQuery) {
			container.createEl('h4', { text: '属性查询（query_skill: 按 AI Skills 定义）' });
			const skillList = container.createEl('ul', { cls: 'lifeup-panel-list' });
			for (const skill of data.skills || []) {
				const levelText = skill.level == null ? '-' : String(skill.level);
				const totalExpText = skill.totalExp == null ? '-' : String(skill.totalExp);
				const lineText = `${skill.name}(ID:${skill.id})：Lv.${levelText} / EXP ${totalExpText}`;
				skillList.createEl('li', { text: lineText });
			}
		}

		container.createEl('small', { text: `更新时间：${data.updatedAt}` });
	}

	renderRow(listEl, label, value) {
		const li = listEl.createEl('li');
		li.createSpan({ text: `${label}：` });
		li.createSpan({ text: value == null ? '-' : String(value) });
	}
}

class AiAnalysisPreviewModal extends Modal {
	constructor(app, plugin, todoTitle, analysis) {
		super(app);
		this.plugin = plugin;
		this.todoTitle = todoTitle;
		this.analysis = analysis;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: 'AI 分析预览' });
		contentEl.createEl('p', { text: `待办：${this.todoTitle}` });

		const list = contentEl.createEl('ul');
		list.createEl('li', { text: `重要程度（importance）：${this.analysis.importance}` });
		list.createEl('li', { text: `困难程度（difficulty）：${this.analysis.difficulty}` });
		list.createEl('li', { text: `紧急程度（urgency）：${this.analysis.urgency}` });
		list.createEl('li', { text: `建议属性 ID（skill_id）：${this.analysis.skill_id}` });
		list.createEl('li', { text: `时间建议（deadline_text）：${this.analysis.deadline_text || '-'}` });

		if (this.analysis.reason) {
			contentEl.createEl('p', { text: `说明：${this.analysis.reason}` });
		}

		const actionRow = contentEl.createDiv({ cls: 'lifeup-panel-actions' });
		const applyBtn = actionRow.createEl('button', { text: '按 AI 结果写入 LifeUp' });
		const closeBtn = actionRow.createEl('button', { text: '关闭' });

		applyBtn.addEventListener('click', async () => {
			applyBtn.disabled = true;
			try {
				await this.plugin.createLifeUpTaskAdvanced(this.todoTitle, this.analysis);
				new Notice('已按 AI 结果写入 LifeUp');
				this.close();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				new Notice(`写入失败：${message}`);
				applyBtn.disabled = false;
			}
		});

		closeBtn.addEventListener('click', () => this.close());
	}
}

class TaskWriteOptionsModal extends Modal {
	constructor(app, plugin, todoTitle, initialOptions, onSubmit) {
		super(app);
		this.plugin = plugin;
		this.todoTitle = String(todoTitle || '').trim();
		this.initialOptions = initialOptions || {};
		this.onSubmit = onSubmit;
		this.closedBySubmit = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: '写入前编辑参数' });
		contentEl.createEl('p', { text: `待办：${this.todoTitle}` });

		const form = contentEl.createDiv({ cls: 'lifeup-prewrite-form' });

		const parseRangeValue = (raw, min, max) => {
			if (raw == null || raw === '') {
				return null;
			}
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				return null;
			}
			if (n < min || n > max) {
				return null;
			}
			return Math.round(n);
		};

		const createRow = (label, placeholder, value = '') => {
			const row = form.createDiv({ cls: 'lifeup-prewrite-row' });
			row.createEl('label', { text: label });
			const input = row.createEl('input', { type: 'text' });
			input.placeholder = placeholder;
			input.value = value;
			return input;
		};

		const importanceInput = createRow('importance (1-4)', '留空则不传', String(this.initialOptions.importance || ''));
		const difficultyInput = createRow('difficulty (1-4)', '留空则不传', String(this.initialOptions.difficulty || ''));
		const skillIds = this.plugin.getAiSkillDefinitions().map((item) => item.id);
		const skillLabel = `skill_id (${skillIds.join('/')})`;
		const skillHint = `可选: ${skillIds.join(', ')}；留空则不传`;
		const skillInput = createRow(skillLabel, skillHint, String(this.initialOptions.skill_id || ''));
		const deadlineInput = createRow('deadline_text', '例如 2026-03-09 18:00 / 今天 22:00', String(this.initialOptions.deadline_text || ''));

		const tips = contentEl.createEl('small', {
			text: `提示：importance/difficulty 范围 1~4，skill_id 可选 ${skillIds.join(', ')}；留空将使用默认写入行为。`,
		});
		tips.addClass('lifeup-prewrite-tip');

		const actions = contentEl.createDiv({ cls: 'lifeup-panel-actions' });
		const submitBtn = actions.createEl('button', { text: '确认写入' });
		const cancelBtn = actions.createEl('button', { text: '取消' });

		submitBtn.addEventListener('click', () => {
			const importance = parseRangeValue(importanceInput.value.trim(), 1, 4);
			const difficulty = parseRangeValue(difficultyInput.value.trim(), 1, 4);
			const rawSkillId = skillInput.value.trim();
			const parsedSkillId = Number(rawSkillId);
			const skillId = Number.isFinite(parsedSkillId) && skillIds.includes(Math.round(parsedSkillId))
				? Math.round(parsedSkillId)
				: null;
			const deadlineText = String(deadlineInput.value || '').trim();

			this.closedBySubmit = true;
			this.onSubmit({
				confirmed: true,
				options: {
					importance,
					difficulty,
					skill_id: skillId,
					deadline_text: deadlineText,
				},
			});
			this.close();
		});

		cancelBtn.addEventListener('click', () => {
			this.closedBySubmit = true;
			this.onSubmit({ confirmed: false, options: null });
			this.close();
		});
	}

	onClose() {
		if (!this.closedBySubmit && this.onSubmit) {
			this.onSubmit({ confirmed: false, options: null });
		}
		this.contentEl.empty();
	}
}

class LifeUpSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'LifeUp 同步与面板设置' });
		containerEl.createEl('p', { text: '建议按顺序配置：连接 → 日记写入 → 日记同步 → 面板显示。' });

		containerEl.createEl('h3', { text: '1) 连接配置' });

		new Setting(containerEl)
			.setName('云人升代理地址（推荐）')
			.setDesc('支持完整地址，如 https://192.168.1.10:8080；填入后将优先使用')
			.addText((text) =>
				text
					.setPlaceholder('https://127.0.0.1:8080')
					.setValue(this.plugin.settings.baseUrl || '')
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim();
						renderBaseUrlValidation();
						await this.plugin.saveSettings();
					})
			);

		const baseUrlValidationEl = containerEl.createEl('div', { cls: 'lifeup-setting-validation' });
		const renderBaseUrlValidation = () => {
			const result = this.plugin.validateProxyBaseUrl(this.plugin.settings.baseUrl || '');
			baseUrlValidationEl.setText(result.message);
			baseUrlValidationEl.toggleClass('is-valid', result.ok);
			baseUrlValidationEl.toggleClass('is-invalid', !result.ok);
		};
		renderBaseUrlValidation();

		new Setting(containerEl)
			.setName('LifeUp 代理主机')
			.setDesc('兼容旧配置：仅当“云人升代理地址”为空时生效')
			.addText((text) =>
				text
					.setPlaceholder('localhost')
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						this.plugin.settings.host = value.trim() || 'localhost';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('LifeUp 代理端口')
			.setDesc('兼容旧配置：仅当“云人升代理地址”为空时生效')
			.addText((text) =>
				text
					.setPlaceholder('8080')
					.setValue(String(this.plugin.settings.port))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.port = Number.isFinite(parsed) ? parsed : 8080;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('请求超时（毫秒）')
			.setDesc('默认 10000')
			.addText((text) =>
				text
					.setPlaceholder('10000')
					.setValue(String(this.plugin.settings.timeoutMs))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.timeoutMs = Number.isFinite(parsed) ? parsed : 10000;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '2) Obsidian → LifeUp（日记同步）' });

		new Setting(containerEl)
			.setName('默认任务金币奖励')
			.setDesc('创建任务时传入 LifeUp 的 coin 参数')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings.defaultCoin))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.defaultCoin = Number.isFinite(parsed) ? parsed : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('任务清单 ID（category, type=task）')
			.setDesc('创建任务时传入 LifeUp 的 category 参数')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings.taskCategoryId))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.taskCategoryId = Number.isFinite(parsed) ? parsed : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('日记同步模式')
			.setDesc('推荐手动按钮；自动模式可能把打字过程中的待办同步出去')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('manual', '手动（按钮/命令）')
					.addOption('auto', '自动（文件变更触发）')
					.setValue(this.plugin.settings.diarySyncMode || 'manual')
					.onChange(async (value) => {
						this.plugin.settings.diarySyncMode = value === 'auto' ? 'auto' : 'manual';
						this.plugin.settings.enableDiaryAutoSync = this.plugin.settings.diarySyncMode === 'auto';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('日记文件夹')
			.setDesc('例如 Daily 或 journal/daily（相对库路径）')
			.addText((text) =>
				text
					.setPlaceholder('Daily')
					.setValue(this.plugin.settings.diaryFolder || '')
					.onChange(async (value) => {
						this.plugin.settings.diaryFolder = this.plugin.normalizeFolderPath(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('日记标题格式（正则）')
			.setDesc('用于匹配文件名，如 ^\\d{4}-\\d{2}-\\d{2}$')
			.addText((text) =>
				text
					.setPlaceholder('^\\d{4}-\\d{2}-\\d{2}$')
					.setValue(this.plugin.settings.diaryTitlePattern || '')
					.onChange(async (value) => {
						this.plugin.settings.diaryTitlePattern = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('仅同步本地今天日记')
			.setDesc('开启后要求文件名等于本地日期（YYYY-MM-DD），如 2026-03-02')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.onlySyncTodayDiary))
					.onChange(async (value) => {
						this.plugin.settings.onlySyncTodayDiary = Boolean(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('启用感想同步')
			.setDesc('同步日记中的感想行到 LifeUp feeling 接口')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.enableFeelingSync))
					.onChange(async (value) => {
						this.plugin.settings.enableFeelingSync = Boolean(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('感想行前缀')
			.setDesc('例如 > 或 >!；连续前缀行会合并为一条感想')
			.addText((text) =>
				text
					.setPlaceholder('>')
					.setValue(String(this.plugin.settings.feelingPrefix || '> '))
					.onChange(async (value) => {
						this.plugin.settings.feelingPrefix = value || '> ';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('感想采集模式')
			.setDesc('仅限有前缀，或从前缀行开始采集到下一个空行')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('prefix-only', '仅限有前缀')
					.addOption('prefix-until-blank', '前缀起始，持续到下一个空行')
					.setValue(this.plugin.settings.feelingCaptureMode || 'prefix-only')
					.onChange(async (value) => {
						this.plugin.settings.feelingCaptureMode = value === 'prefix-until-blank' ? 'prefix-until-blank' : 'prefix-only';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('感想严格绑定模式')
			.setDesc('开启后：感想必须紧跟事项块（中间无空行/普通文本）才会绑定为事项感想')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.strictFeelingBinding))
					.onChange(async (value) => {
						this.plugin.settings.strictFeelingBinding = Boolean(value);
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '3) LifeUp → Obsidian（写回日记）' });

		new Setting(containerEl)
			.setName('启用从 LifeUp 写入日记')
			.setDesc('从指定 categoryId 拉取任务并写入日记固定区块')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.enableTaskPullToDiary))
					.onChange(async (value) => {
						this.plugin.settings.enableTaskPullToDiary = Boolean(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('写入触发模式')
			.setDesc('自动：打开匹配日记时写入；手动：按钮/命令触发')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('auto', '自动（打开日记时）')
					.addOption('manual', '手动（按钮/命令）')
					.setValue(this.plugin.settings.taskPullMode || 'auto')
					.onChange(async (value) => {
						this.plugin.settings.taskPullMode = value === 'manual' ? 'manual' : 'auto';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('拉取任务清单 ID（categoryId）')
			.setDesc('调用 /tasks/{categoryId} 写入日记')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings.pullTaskCategoryId))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.pullTaskCategoryId = Number.isFinite(parsed) ? parsed : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('写入区块标题')
			.setDesc('写入日记的标题文本，如 ## LifeUp 待办（自动写入）')
			.addText((text) =>
				text
					.setPlaceholder('## LifeUp 待办（自动写入）')
					.setValue(this.plugin.settings.pullSectionTitle || '')
					.onChange(async (value) => {
						this.plugin.settings.pullSectionTitle = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '4) 数据面板' });

		new Setting(containerEl)
			.setName('启用属性查询（query_skill）')
			.setDesc('开启后读取属性 ID 1~6 并显示在数据面板')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.enableSkillQuery))
					.onChange(async (value) => {
						this.plugin.settings.enableSkillQuery = Boolean(value);
						await this.plugin.saveSettings();
						await this.plugin.refreshPanelView();
					})
			);

		new Setting(containerEl)
			.setName('请求超时（毫秒）')
			.setDesc('默认 10000')
			.addText((text) =>
				text
					.setPlaceholder('10000')
					.setValue(String(this.plugin.settings.timeoutMs))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.timeoutMs = Number.isFinite(parsed) ? parsed : 10000;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('面板查询物品 ID')
			.setDesc('用于在面板中查询指定物品拥有数，填 0 则不查询')
			.addText((text) =>
				text
					.setPlaceholder('5')
					.setValue(String(this.plugin.settings.goldItemId))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.goldItemId = Number.isFinite(parsed) ? parsed : 0;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: '5) 实验性 AI 配置' });

		new Setting(containerEl)
			.setName('启用实验性 AI 功能')
			.setDesc('用于后续 AI 自动评估和建议功能')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.enableAiFeature))
					.onChange(async (value) => {
						this.plugin.settings.enableAiFeature = Boolean(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('优先使用系统钥匙串（桌面）')
			.setDesc('桌面端优先写入系统钥匙串；移动端或失败时自动回退 data.json')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.useSystemKeychain))
					.onChange(async (value) => {
						this.plugin.settings.useSystemKeychain = Boolean(value);
						await this.plugin.saveSettings();
						await this.plugin.initKeytar();
					})
			);

		new Setting(containerEl)
			.setName('AI API 地址')
			.setDesc('例如 OpenAI 兼容接口地址')
			.addText((text) =>
				text
					.setPlaceholder('https://api.openai.com/v1/chat/completions')
					.setValue(String(this.plugin.settings.aiApiBaseUrl || ''))
					.onChange(async (value) => {
						this.plugin.settings.aiApiBaseUrl = value.trim() || DEFAULT_SETTINGS.aiApiBaseUrl;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('AI 模型')
			.setDesc('例如 gpt-4o-mini')
			.addText((text) =>
				text
					.setPlaceholder('gpt-4o-mini')
					.setValue(String(this.plugin.settings.aiModel || ''))
					.onChange(async (value) => {
						this.plugin.settings.aiModel = value.trim() || DEFAULT_SETTINGS.aiModel;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('AI System 提示词模板')
			.setDesc('发送给模型的 system 提示词，可按你的偏好调整')
			.addTextArea((text) =>
				text
					.setPlaceholder('你是任务分析助手...')
					.setValue(String(this.plugin.settings.aiSystemPromptTemplate || DEFAULT_AI_SYSTEM_PROMPT))
					.onChange(async (value) => {
						this.plugin.settings.aiSystemPromptTemplate = value || DEFAULT_AI_SYSTEM_PROMPT;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('AI User 提示词模板')
			.setDesc('支持变量 {{todoTitle}}，例如：待办标题：{{todoTitle}}')
			.addTextArea((text) =>
				text
					.setPlaceholder('待办标题：{{todoTitle}}')
					.setValue(String(this.plugin.settings.aiUserPromptTemplate || DEFAULT_AI_USER_PROMPT))
					.onChange(async (value) => {
						this.plugin.settings.aiUserPromptTemplate = value || DEFAULT_AI_USER_PROMPT;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('AI Skills 定义（JSON）')
			.setDesc('用于约束 skill_id 的可选 ID/个数/说明。格式: [{"id":1,"description":"体能"}]')
			.addTextArea((text) =>
				text
					.setPlaceholder('[{"id":1,"description":"体能/健康"}]')
					.setValue(String(this.plugin.settings.aiSkillDefinitionsJson || DEFAULT_AI_SKILLS_JSON))
					.onChange(async (value) => {
						this.plugin.settings.aiSkillDefinitionsJson = value || DEFAULT_AI_SKILLS_JSON;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('AI API Key')
			.setDesc('输入后自动保存；桌面优先钥匙串，失败自动回退本地配置')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('sk-...')
					.setValue('')
					.onChange(async (value) => {
						await this.plugin.setAiApiKey(value);
					});
			});
	}
}

module.exports = LifeUpTodoPlugin;
