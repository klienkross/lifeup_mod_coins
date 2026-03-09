# lifeup_mod_coins

Obsidian 插件（草稿版）：在 Obsidian 日记与 LifeUp 之间同步待办（通过云人升 API）。

## 主要功能：

- 把obsidian的待办  `- [ ] ` 格式写入lifeup（手动）
- 把lifeup指定列表的任务写入obsidian的日记（自动/手动）
- 把obsidian的日记写入lifeup指定列表（自动/手动）
- 侧边栏简单查询：属性/金币/番茄数量/物品拥有数量

### v0.2.0
- 增加写入感想功能
- 增加配置迁移功能，不会因为旧版本数据卡住了！
- 实验性功能（可开关）：AI辅助填写importance/difficulty/skill_id/deadline
- 更新：属性查询支持自定义了！在AI skills 定义栏内设置后使用

## 可能问题：
- 更新后obsidian卡住：删除插件所在文件夹`.obsidian\plugins\Lifeup`中的`data.json`再试。（需要重新配置）

## 配置方法：

1. 配置好人升和云人升，获取需要的id、手机端IP（`IP:端口`，例如：`http://192.168.1.1:12345`）。详情见人升/云人升使用指南。
2. 将`\plugins` 中的文件（或压缩包里的文件）（`main.js`、`manifest.json`、`styles.css`）放置在Obsidian仓库下的 `.obsidian\plugins\Lifeup` 文件夹内。详情见obsidian插件使用指南。
3. 打开obsidian-设置-选项-第三方插件-已安装插件，刷新并启用`LifeUp ToDo Sync` 
   ![LifeUp ToDo Sync](./notes/attachments/Pasted%20image%2020260306173517.png)
4. 在设置-第三方插件-`LifeUp ToDo Sync`-连接配置 中填入手机端IP。在数据面板（下述：使用方法-1）中点击测试连接，数据正常显示则连接完成！
	1. 注意：obsidian和运行人升的手机端必须处在相同WiFi下。
	2. 再次启动obsidian时会自动连接，不必重新设置。
5. 使用 AI 功能：在插件设置中启用实验性 AI 功能，并填写 `AI API 地址 / AI 模型 / AI API Key`。如需自定义技能范围与说明，配置 `AI Skills 定义（JSON）`。完整用法见下文 `使用方法 -> 5. AI辅助填写`。


## 使用方法：

### 1. 数据面板：
   位于左边栏按钮。
   ![数据面板按钮](./notes/attachments/Pasted%20image%2020260306181436.png)  
   点击后会出现在右边栏。正常连接如图所示：  
   ![数据面板](./notes/attachments/Pasted%20image%2020260306174733.png)  
**可以在设置中开启/关闭属性查询和物品查询。** 

### 2. 待办写入：

1). 单条写入：右键点击-写入lifeup

2). 多条写入：选中-右键点击-写入lifeup

3). 全篇日记写入：见3.日记同步

#### **注意：** 子任务规则
同步到 LifeUp 时：主任务会创建为任务，子项会创建为 subtask。已勾选子项会自动标记完成。  
多级子任务会拍平为一层并拼接路径，例如：`二级 > 三级 > 四级`。  
**LifeUp 本身只有一层 subtask。深层结构较多时会显得杂乱。因此不建议用于同步多层子任务。**


### 3. 日记同步

#### 1). Obsidian -> LifeUp

在插件设置中填写`任务清单 ID`（默认为0）、`默认任务金币奖励`（默认为0）、`日记文件夹`、`日记标题格式（正则）`、`仅同步本地今天日记`（可选）  
 **注意：日记同步模式推荐 `手动（按钮/命令）`，避免把打字中间态同步出去。**   
 手动同步按钮在这里：  
      ![Obsidian -> LifeUp](./notes/attachments/1.png)  
或使用命令：`同步当前日记待办到 LifeUp`

#### 2). LifeUp -> Obsidian
在插件设置中填写：`启用从 LifeUp 写入日记`、 `写入触发模式`（手动/自动）、`拉取任务清单 ID`（默认为0）、`写入区块标题`  
手动同步按钮在这里：  
     	![LifeUp -> Obsidian](./notes/attachments/Pasted%20image%2020260306211250.png)  
或使用命令：`从 LifeUp 写入当前日记任务`

#### **写回日记区块说明：**

LifeUp 写回使用受控区块，插件会覆盖更新该区块而不是反复追加：  
```
<!-- LIFEUP_TASKS_START -->
（内容）
<!-- LIFEUP_TASKS_END -->
```
该区块会被排除出“反向推送到 LifeUp”的解析，避免循环同步。

---更新：v 0.2.0 ---
### 4. 感想同步

用于把日记中的感想文本同步到 LifeUp 的 `feeling` 接口。

#### 1). 先开启功能
在插件设置中打开以下项：

- `启用感想同步`
- `感想行前缀`（默认 `>`）
- `感想采集模式`
- `感想严格绑定模式`

#### 2). 日记里怎么写

默认前缀是 `>`，例如：

```md
- [ ] 晨跑 20 分钟
> 今天状态不错，配速比昨天稳
> 晚上记得拉伸
```

#### 3). 两种采集模式

- `仅限有前缀`：只采集以你设置的前缀开头的行。
- `前缀起始，持续到下一个空行`：从第一行前缀开始，后续普通行也会并入，直到遇到空行。

#### 4). 严格绑定说明

- 开启 `感想严格绑定模式`：感想必须紧跟在事项块后面（中间没有空行/普通文本）才会绑定到该事项。
- 关闭后：绑定更宽松，无法绑定时也会作为普通感想写入。

#### 5). 触发同步

感想不会单独上传，而是跟随「日记同步（Obsidian -> LifeUp）」一起执行：

- 按钮：左侧功能按钮 `同步当前日记待办到 LifeUp`
- 命令：`同步当前日记待办到 LifeUp`

#### 注意

- 感想与待办一样，会记录同步痕迹，避免重复写入。
- LifeUp 写回日记的受控区块（`LIFEUP_TASKS_START/END`）不会参与感想解析。

### 5. AI辅助填写

用于在写入待办前，自动建议 `importance / difficulty / skill_id / deadline_text`，并支持手动修改后再写入。

#### 1). 启用与配置

在插件设置中填写：

- `启用实验性 AI 功能`
- `AI API 地址`
- `AI 模型`
- `AI API Key`
- `AI System 提示词模板`
- `AI User 提示词模板`
- `AI Skills 定义（JSON）`

桌面端会优先使用系统钥匙串保存 key；失败时回退到本地配置。

#### 2). 使用入口

- 右键单条待办：`AI 分析当前待办（预览）`
- 命令面板：`AI 分析当前待办（预览）`

预览弹窗中点击 `按 AI 结果写入 LifeUp` 即可。

#### 3). 写入前编辑

无论是普通写入还是 AI 预览后写入，都会出现“写入前编辑参数”弹窗，可手动改：

- `importance (1-4)`
- `difficulty (1-4)`
- `skill_id`（范围由 skills JSON 决定）
- `deadline_text`（例如 `今天 22:00`、`2026-03-09 18:00`）

留空表示该字段不额外传入，按插件默认行为处理。

#### 4). Skills JSON 怎么写

`AI Skills 定义（JSON）` 同时影响三件事：

- AI 提示词里的技能说明
- AI 返回 `skill_id` 的合法范围
- 侧边栏 `query_skill` 的查询/展示顺序

示例：

```json
[
   { "id": 1, "description": "体能/健康" },
   { "id": 2, "description": "学习/认知" },
   { "id": 5, "description": "项目开发" },
   { "id": 9, "description": "长期副业" }
]
```

#### 5). 提示词变量

- `{{todoTitle}}`：当前待办标题
- `{{skillGuide}}`：自动注入的技能定义说明（可放在 system 或 user 模板中）

如果模板里不写 `{{skillGuide}}`，插件会自动把技能说明追加到提示词末尾。


## 贡献代码：

**不要pr，我看不懂。想要个人修改可以随意Fork。**

有增加功能的建议可以回帖或发送issue。会看，不过不一定能实现，作者能力有限。

Github仓库：<https://github.com/klienkross/lifeup_mod_coins>
