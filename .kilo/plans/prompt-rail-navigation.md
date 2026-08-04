# 对话提示词导航需求与设计实现

## 1. 背景

长会话中包含大量用户提示词和智能体回复。当前用户只能通过滚动条逐段查找历史内容，难以快速判断会话结构，也无法直接跳转到指定提示词。

Kilo Code 上游已提供 Prompt Rail（提示词导航轨道）。本项目仍使用较早的 `MessageTurn` 级虚拟列表，不能直接覆盖上游 `MessageList`，因此本功能采用适配式移植：保留现有消息渲染、排队消息、自动滚动和历史分页行为，仅增加独立导航层。

## 2. 需求目标

### 2.1 核心目标

1. 在消息列表左侧显示一条紧凑的提示词导航轨道。
2. 每个已加载的用户提示词对应一个刻度。
3. 当前位于消息视口顶部的对话轮次应高亮对应刻度。
4. 鼠标悬停或键盘聚焦刻度时，显示提示词和回答摘要卡片。
5. 点击刻度或摘要行时，直接跳转到对应对话轮次。
6. 支持跳转到首个提示词和最新提示词。
7. 存在未加载历史时，支持渐进加载并最终跳转到会话第一条提示词。
8. 长会话中对轨道刻度和摘要列表进行容量控制及虚拟化，避免明显性能退化。

### 2.2 兼容性目标

1. 不改变现有消息内容和 `VscodeSessionTurn` 的渲染结构。
2. 不改变 Extension 与 CLI 的消息协议。
3. 不破坏现有自动滚动、滚动位置恢复、排队消息和历史消息 prepend 行为。
4. 不整体同步上游 `TranscriptRow`、搜索或滚动缓存架构。
5. 导航不可用或数据不足时，消息列表仍按原行为工作。
6. 鼠标、键盘和屏幕阅读器均可操作导航。

### 2.3 非目标

1. 不提供提示词搜索或过滤。
2. 不索引工具输出、推理文本、错误卡片和 diff 内容。
3. 不改变会话历史分页大小。
4. 不把对话列表从 `MessageTurn` 升级为 `TranscriptRow`。
5. 不修改后端数据存储格式。

## 3. 用户交互

### 3.1 轨道

- 会话少于两个提示词时不显示轨道。
- 轨道位于 `message-list-container` 左侧内边缘，不参与文档流，不压缩消息正文。
- 普通刻度代表提示词；排队提示词使用弱化样式；当前轮次使用增强样式。
- 当刻度数量超过可用高度时，保留历史入口、最近提示词和 overflow 汇总刻度。
- 在轨道上滚轮滚动时，滚动消息正文，而不是产生独立滚动区域。

### 3.2 预览卡片

- 悬停或聚焦刻度后显示浮动卡片。
- 每行显示一行提示词摘要和最多两行回答摘要。
- 用户消息只有图片或文件时，用回答摘要补充提示词标签。
- 暂无回答时显示占位文案。
- 排队提示词显示排队状态。
- 超过 30 个已加载提示词时，摘要列表使用虚拟列表。
- 摘要列表接近顶部时按需加载更早历史。

### 3.3 键盘操作

- `ArrowUp` / `ArrowDown`：切换相邻刻度。
- `Home` / `End`：切换到轨道首项或末项。
- `Enter` / `Space`：激活当前项。
- `Escape`：关闭预览卡片。
- 使用 roving `tabIndex`，轨道仅保留一个 Tab 停靠点。

## 4. 数据设计

### 4.1 PromptRailItem

```ts
interface PromptRailItem {
  key: string
  turn: string
  queued: boolean
  prompt: string
  answer: string
}
```

- `key`：当前实现使用用户消息 ID，可直接关联 `data-message` 和虚拟列表索引。
- `turn`：对话轮次 ID，当前与用户消息 ID 一致，保留语义字段便于未来升级。
- `queued`：是否为待处理的排队提示词。
- `prompt`：清洗并截断后的用户文本。
- `answer`：同一轮次中所有 assistant text part 合并后的摘要。

### 4.2 PromptRailEntry

```ts
type PromptRailEntry =
  | { type: "prompt"; item: PromptRailItem; index: number }
  | { type: "overflow"; count: number; index: number }
  | { type: "history" }
```

- `prompt`：可直接跳转的已加载提示词。
- `overflow`：因轨道高度不足而折叠的已加载提示词区间。
- `history`：服务端仍有未加载历史时的入口。

### 4.3 摘要规则

1. 仅提取非 synthetic 的 `text` part。
2. 删除 fenced code 和 inline code，避免卡片被代码主导。
3. Markdown 链接保留标签、删除 URL；图片全部删除。
4. 删除标题、列表和引用前缀，合并连续空白。
5. 提示词最多 160 字符，回答最多 220 字符，超出后以省略号结束。

## 5. 实现设计

### 5.1 纯逻辑层

新增 `webview-ui/src/components/chat/prompt-rail.ts`：

- 从当前 `MessageTurn[]`、`getParts()` 和 queued ID 集合生成导航项。
- 计算轨道容量和刻度间距。
- 生成 prompt、overflow、history 条目。
- 决定渐进历史加载的下一步动作。
- 不依赖 DOM 或 VS Code API，可由 Bun 单元测试直接覆盖。

### 5.2 UI 组件

新增 `webview-ui/src/components/chat/PromptRail.tsx`：

- 使用 Solid signal/memo/effect 管理打开、悬停、焦点和浮层位置。
- 使用 `Portal` 防止浮层被消息滚动容器裁剪。
- 使用 `VList` 虚拟化超长摘要列表。
- 使用 kilo-ui 的 `IconButton`、`Spinner` 和 `Tooltip`。
- 所有可见文字和 ARIA label 均使用本地化文案。

### 5.3 MessageList 接入

修改 `webview-ui/src/components/chat/MessageList.tsx`：

1. 保存 `VirtualizerHandle`，建立用户消息 ID 到虚拟列表索引的映射。
2. 点击导航项时暂停自动跟随，再通过 `scrollToIndex()` 跳转。
3. 对已挂载但不在虚拟列表中的排队项，使用 `data-message` 定位并调用 `scrollIntoView()`。
4. 使用 `ResizeObserver` 同步 transcript 高度，动态限制轨道容量。
5. 消息滚动后通过已挂载的 `data-message` 节点判断视口顶部轮次，并在动画帧中更新活跃刻度。
6. 会话切换、消息 prepend 和列表数据变化后重新计算导航状态。

### 5.4 历史分页

将 Session Context 中的 `loadOlderMessages()` 返回值从 `void` 改为 `boolean`：

- 确实发送请求时返回 `true`。
- 未连接、无更多历史、正在加载或无 cursor 时返回 `false`。
- 现有忽略返回值的调用保持兼容。
- “跳到第一条”使用消息数量检测每次 prepend 是否有进展；有更多历史则继续加载，最后跳转；无进展则停止，防止请求循环。

### 5.5 样式

新增 `webview-ui/src/styles/prompt-rail.css` 并由 `chat.css` 导入：

- 轨道绝对定位在当前消息容器左侧，不修改正文宽度。
- 卡片固定定位，限制在消息容器和 viewport 范围内。
- 支持排队、活跃、悬停、聚焦和 overflow 样式。
- 支持 `prefers-reduced-motion`。
- 浮层宽度随窄侧边栏收缩，避免越过 viewport。

## 6. 兼容性与风险控制

| 风险 | 控制措施 |
|---|---|
| 覆盖当前自定义 MessageList | 只增加局部状态和组件挂载，不替换文件 |
| 虚拟列表跳转失败 | 同时提供 Virtualizer 索引跳转和已挂载 DOM fallback |
| prepend 后滚动跳位 | 保留现有 `shift`，导航卡片的 `VList` 同步使用 prepend 状态 |
| 自动滚动把导航跳转拉回底部 | 跳转前调用 `autoScroll.pause()` |
| 历史加载死循环 | 检查加载前后消息数量并使用 `historyAction()` 停止无进展请求 |
| 窄侧边栏遮挡正文 | 轨道限制在现有左侧 padding 内，浮层宽度使用 viewport 上限 |
| 大量提示词造成卡顿 | 轨道容量折叠，卡片超过阈值后启用 `VList` |
| 文案键缺失 | 为当前注册的全部 locale 增加相同键并运行 i18n 检查 |

## 7. 验收标准

1. 两条及以上提示词时显示轨道，一条或空会话时不显示。
2. 点击任意已加载提示词能跳到对应用户消息顶部。
3. 滚动正文时，活跃刻度能随当前顶部轮次更新。
4. hover/focus 卡片能展示清洗、截断后的提示词和回答。
5. 排队、无回答、图片消息均有合理展示。
6. 存在未加载历史时，首条导航能逐页加载并最终跳转。
7. 卡片滚动到顶部能加载更早一页，且 prepend 后位置稳定。
8. 30 条以上提示词时卡片使用虚拟列表，交互保持流畅。
9. 轨道滚轮能滚动正文。
10. 键盘导航和 ARIA label 可用。
11. 会话切换、回滚边界、排队消息、自动滚动和滚动恢复保持现有行为。
12. Prompt Rail 单元测试、webview 类型检查和 lint 通过；若仓库存在既有失败，应确认未新增本功能相关失败。

## 8. 完整功能 TODO

- [x] 新增 Prompt Rail 纯逻辑模块。
- [x] 覆盖文本清洗、截断、图片消息、排队状态和回答聚合测试。
- [x] 覆盖容量、overflow、history 和分页决策测试。
- [x] 新增 PromptRail Solid 组件。
- [x] 实现轨道 tick、活跃态、排队态和 overflow 态。
- [x] 实现 hover/focus 预览卡片。
- [x] 实现摘要列表虚拟化。
- [x] 实现首条、最新和任意提示词跳转。
- [x] 实现卡片顶部按需加载历史。
- [x] 实现鼠标滚轮转发。
- [x] 实现完整键盘和 ARIA 支持。
- [x] 在 MessageList 保存虚拟列表 handle 和索引。
- [x] 在 MessageList 跟踪 transcript 高度和活跃轮次。
- [x] 在 MessageList 接入渐进历史加载和跳转。
- [x] 修改 `loadOlderMessages()` 返回请求是否启动。
- [x] 新增独立 Prompt Rail 样式并导入。
- [x] 补齐所有已注册语言的 Prompt Rail 文案。
- [x] 新增用户可见功能 changeset。
- [x] 运行目标单测、i18n 检查、类型检查、lint 和格式检查。
- [x] 检查最终 diff，确认未覆盖现有 TestAgent 自定义逻辑。

## 9. 验证命令

在 `packages/kilo-vscode` 下执行：

```bash
bun test ./tests/unit/prompt-rail.test.ts
bun test ./tests/unit/i18n-keys.test.ts
bun run check-types:webview
bun run lint
bun run format:check
```
