const {
	Plugin,
	Notice,
	PluginSettingTab,
	Setting,
	MarkdownView,
	requestUrl,
	ItemView,
	TFile,
} = require('obsidian');

const VIEW_TYPE_LIFEUP_PANEL = 'lifeup-data-panel-view';

const DEFAULT_SETTINGS = {
	baseUrl: '',
	host: 'localhost',
	port: 8080,
	taskCategoryId: 0,
	defaultCoin: 0,
	goldItemId: 5,
	enableSkillQuery: false,
	enableDiaryAutoSync: false,
	diaryFolder: '',
	diaryTitlePattern: '^\\d{4}-\\d{2}-\\d{2}$',
	diarySyncedMap: {},
	timeoutMs: 10000,
};

class LifeUpTodoPlugin extends Plugin {
	async onload() {
		await this.loadSettings();
		this.dashboardState = {
			connected: false,
			lastError: '',
			data: null,
		};
		this.autoSyncTimers = new Map();

		this.registerView(
			VIEW_TYPE_LIFEUP_PANEL,
			(leaf) => new LifeUpPanelView(leaf, this)
		);

		this.addSettingTab(new LifeUpSettingTab(this.app, this));

		this.addRibbonIcon('gauge', '打开 LifeUp 数据面板', async () => {
			await this.activatePanelView();
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				if (!(view instanceof MarkdownView)) {
					return;
				}

				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line) || '';
				const singleTodo = this.extractTodoFromLine(lineText);
				const selectedTodos = this.extractTodosFromSelection(editor.getSelection());

				if (singleTodo) {
					menu.addItem((item) => {
						item
							.setTitle('写入 LifeUp：当前待办')
							.setIcon('check-circle')
							.onClick(async () => {
								await this.pushTodosToLifeUp([singleTodo]);
							});
					});
				}

				if (selectedTodos.length > 0) {
					menu.addItem((item) => {
						item
							.setTitle(`写入 LifeUp：选中待办（${selectedTodos.length}）`)
							.setIcon('list-checks')
							.onClick(async () => {
								await this.pushTodosToLifeUp(selectedTodos);
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
				const canRun = Boolean(active && this.isDiaryFileMatch(active));
				if (!checking && canRun) {
					this.syncDiaryFileTodos(active, { notifyResult: true });
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
	}

	onunload() {
		for (const timerId of this.autoSyncTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.autoSyncTimers.clear();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_LIFEUP_PANEL);
	}

	async loadSettings() {
		const loaded = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		if (loaded.defaultGold != null && loaded.defaultCoin == null) {
			const converted = Number(loaded.defaultGold);
			this.settings.defaultCoin = Number.isFinite(converted) ? converted : 0;
		}
		if (loaded.category != null && loaded.taskCategoryId == null) {
			const convertedCategory = Number(loaded.category);
			this.settings.taskCategoryId = Number.isFinite(convertedCategory) ? convertedCategory : 0;
		}
		if (!this.settings.diarySyncedMap || typeof this.settings.diarySyncedMap !== 'object') {
			this.settings.diarySyncedMap = {};
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	extractTodoFromLine(lineText) {
		const match = lineText.match(/^\s*[-*+]\s*\[\s\]\s+(.+?)\s*$/);
		if (!match) {
			return null;
		}
		return match[1].trim();
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
			return res.json;
		}

		if (res.text) {
			try {
				return JSON.parse(res.text);
			} catch (_) {
				return { raw: res.text };
			}
		}

		return {};
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
				for (let skillId = 1; skillId <= 6; skillId += 1) {
					try {
						const raw = await this.callLifeUpApi(`lifeup://api/query_skill?id=${skillId}`);
						skills.push({
							id: skillId,
							name: raw?.name ?? `属性${skillId}`,
							level: this.readNumberField(raw, ['level']),
							totalExp: this.readNumberField(raw, ['total_exp']),
							currentLevelExp: this.readNumberField(raw, ['current_level_exp']),
							untilNextLevelExp: this.readNumberField(raw, ['until_next_level_exp']),
						});
					} catch (_) {
						skills.push({
							id: skillId,
							name: `属性${skillId}`,
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
		const safeTitle = encodeURIComponent(title);
		const coin = Number(this.settings.defaultCoin) || 0;
		const category = Number(this.settings.taskCategoryId) || 0;
		const apiUrl = `lifeup://api/add_task?todo=${safeTitle}&category=${category}&coin=${coin}`;
		return await this.callLifeUpApi(apiUrl);
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
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return false;
		}

		const folder = this.normalizeFolderPath(this.settings.diaryFolder);
		if (!folder) {
			return false;
		}

		const filePath = (file.path || '').replace(/\\/g, '/');
		const inFolder = filePath === folder || filePath.startsWith(`${folder}/`);
		if (!inFolder) {
			return false;
		}

		const titleRegex = this.getDiaryTitleRegex();
		if (!titleRegex) {
			return false;
		}

		return titleRegex.test(file.basename);
	}

	scheduleDiaryAutoSync(file) {
		if (!this.settings.enableDiaryAutoSync) {
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

	extractTodoTitlesFromText(text) {
		const lines = String(text || '').split(/\r?\n/);
		const titles = [];
		for (const line of lines) {
			const todo = this.extractTodoFromLine(line);
			if (todo) {
				titles.push(todo);
			}
		}
		return titles;
	}

	async syncDiaryFileTodos(file, options = {}) {
		const { notifyResult = false } = options;
		if (!this.isDiaryFileMatch(file)) {
			return { success: 0, failed: 0, skipped: 0 };
		}

		const content = await this.app.vault.cachedRead(file);
		const currentTodos = this.extractTodoTitlesFromText(content);
		if (currentTodos.length === 0) {
			return { success: 0, failed: 0, skipped: 0 };
		}

		const syncedMap = this.settings.diarySyncedMap || {};
		const syncedList = Array.isArray(syncedMap[file.path]) ? syncedMap[file.path] : [];
		const syncedSet = new Set(syncedList);

		let success = 0;
		let failed = 0;
		let skipped = 0;

		for (const title of currentTodos) {
			if (syncedSet.has(title)) {
				skipped += 1;
				continue;
			}

			try {
				await this.createLifeUpTask(title);
				syncedSet.add(title);
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 自动同步失败:', title, err);
			}
		}

		syncedMap[file.path] = Array.from(syncedSet);
		this.settings.diarySyncedMap = syncedMap;
		await this.saveSettings();

		if (notifyResult) {
			new Notice(`日记同步完成：新增 ${success}，跳过 ${skipped}，失败 ${failed}`);
		}

		return { success, failed, skipped };
	}

	async pushTodosToLifeUp(todoTitles) {
		if (!todoTitles || todoTitles.length === 0) {
			new Notice('没有可写入的待办');
			return;
		}

		let success = 0;
		let failed = 0;

		for (const title of todoTitles) {
			try {
				await this.createLifeUpTask(title);
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 创建任务失败:', title, err);
			}
		}

		if (failed === 0) {
			new Notice(`已写入 LifeUp：${success} 条待办`);
			return;
		}

		new Notice(`写入完成：成功 ${success}，失败 ${failed}`);
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
			container.createEl('h4', { text: '属性查询（query_skill: 1~6）' });
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

class LifeUpSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'LifeUp 同步与面板设置' });

		const baseUrlSetting = new Setting(containerEl)
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
			.setDesc('兼容旧配置：当“云人升代理地址”为空时生效')
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
			.setDesc('兼容旧配置：当“云人升代理地址”为空时生效')
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
			.setName('启用日记自动同步')
			.setDesc('自动同步指定日记文件中的未完成待办到 LifeUp')
			.addToggle((toggle) =>
				toggle
					.setValue(Boolean(this.plugin.settings.enableDiaryAutoSync))
					.onChange(async (value) => {
						this.plugin.settings.enableDiaryAutoSync = Boolean(value);
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
	}
}

module.exports = LifeUpTodoPlugin;
