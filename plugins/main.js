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
	diarySyncMode: 'manual',
	enableDiaryAutoSync: false,
	diaryFolder: '',
	diaryTitlePattern: '^\\d{4}-\\d{2}-\\d{2}$',
	onlySyncTodayDiary: false,
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

		this.addRibbonIcon('list-todo', '同步当前日记待办到 LifeUp', async () => {
			await this.syncActiveDiaryFile({ notifyResult: true });
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
		if (loaded.diarySyncMode == null) {
			this.settings.diarySyncMode = loaded.enableDiaryAutoSync ? 'auto' : 'manual';
		}
		if (!['manual', 'auto'].includes(this.settings.diarySyncMode)) {
			this.settings.diarySyncMode = 'manual';
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

	async createLifeUpTaskWithSubtasks(node) {
		const createdTask = await this.createLifeUpTask(node.title);
		const taskId = this.extractFirstNumber(createdTask, ['task_id', '_ID', 'id']);

		if (!Array.isArray(node.children) || node.children.length === 0) {
			return;
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
		const currentTodoNodes = this.extractTodoTreeFromText(content);
		if (currentTodoNodes.length === 0) {
			return { success: 0, failed: 0, skipped: 0 };
		}

		const syncedMap = this.settings.diarySyncedMap || {};
		const syncedList = Array.isArray(syncedMap[file.path]) ? syncedMap[file.path] : [];
		const syncedSet = new Set(syncedList);

		let success = 0;
		let failed = 0;
		let skipped = 0;

		for (const node of currentTodoNodes) {
			const signature = this.buildTodoNodeSignature(node);
			if (syncedSet.has(signature) || syncedSet.has(node.title)) {
				skipped += 1;
				continue;
			}

			try {
				await this.createLifeUpTaskWithSubtasks(node);
				syncedSet.add(signature);
				syncedSet.add(node.title);
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 自动同步失败:', node.title, err);
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

	async pushTodoNodesToLifeUp(todoNodes) {
		if (!todoNodes || todoNodes.length === 0) {
			new Notice('没有可写入的待办');
			return;
		}

		let success = 0;
		let failed = 0;

		for (const node of todoNodes) {
			try {
				await this.createLifeUpTaskWithSubtasks(node);
				success += 1;
			} catch (err) {
				failed += 1;
				console.error('[lifeup-todo-plugin] 创建树形任务失败:', node.title, err);
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
