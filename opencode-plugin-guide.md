# OpenCode 插件系统指南

> 来源：[知乎专栏](https://zhuanlan.zhihu.com/p/2027144829352583703)

## 概述

OpenCode 的插件系统本质是：**协议 + 事件编程** 的组合。

- **协议**：靠接口实现，JS 中通过 TypeScript 接口定义
- **事件编程**：靠观察者模式实现，JS 中靠注册回调函数实现

> JS 中没有"接口"，因此推荐用 TS 编写插件，充分利用 opencode 定义的接口协议。

事件编程的特点在 **Hook** 上很明显，在 **Tool** 上没有那么明显，但调用 Tool 本质上还是触发"Tool 调用"事件。

## 插件能力

通过插件，开发者可以轻松地：

1. **改变 opencode 的默认行为**
2. **集成外部服务**
3. **添加新特性**（主要通过添加 Hook 或 Tool 实现）

如果 opencode 的现有结果不能让你满意，可以通过 plugin 实现自己想要的结果。

## 核心概念

### Plugin 接口定义

```ts
import type { Plugin, PluginContext, PluginHandlers } from '@opencode-ai/plugin';

// Plugin 本质是一个异步回调函数，接收上下文，返回事件处理器映射
type Plugin = (ctx: PluginInput) => Promise<Hooks>;

// 上下文包含运行时信息
interface PluginInput {
  client: ReturnType<typeof createOpencodeClient>;
  project: Project;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $: BunShell;
}
```

### Hook 和 Tool 的区别

| 特性     | Hook                                     | Tool                                   |
| -------- | ---------------------------------------- | -------------------------------------- |
| 作用     | 监听并响应系统事件，修改行为或触发副作用 | 提供新的工具能力，可供 AI 主动调用     |
| 注册方式 | 通过事件名称注册处理器                   | 通过 `tool` 函数注册                   |
| 参数     | 事件上下文                               | 需要定义参数 schema 和执行函数         |
| 返回值   | 可影响执行流程                           | 工具执行结果                           |
| 用途     | 日志、统计、权限控制等                   | 扩展具体功能（如部署、通知等）         |

### 常用事件列表

| 事件名称              | 触发时机       | 参数                                        | 说明                     |
| --------------------- | -------------- | ------------------------------------------- | ------------------------ |
| `tool.execute.before` | Tool 执行前    | `ctx: { toolName, args, context }`          | 可修改参数或阻止执行     |
| `tool.execute.after`  | Tool 执行后    | `ctx: { toolName, args, result, context }`  | 可处理结果或记录日志     |
| `tool.execute.error`  | Tool 执行出错  | `ctx: { toolName, args, error, context }`   | 可处理错误或重试         |
| `session.start`       | 会话开始       | `ctx: { sessionId }`                        | 初始化会话资源           |
| `session.end`         | 会话结束       | `ctx: { sessionId }`                        | 清理会话资源             |
| `message.before`      | 消息处理前     | `ctx: { message, sessionId }`               | 可修改或过滤消息         |
| `message.after`       | 消息处理后     | `ctx: { message, response, sessionId }`     | 可记录或修改响应         |

> 更多事件请参考[官方文档](https://opencode.ai/docs/config#plugins)。

## 测试方式

### 方式一：简单 Hook

简单 Hook 是一个单文件，放到以下目录中，即可在初始化 opencode 时自动加载：

- 全局目录：`~/.config/opencode/plugins/`
- 项目目录：`.opencode/plugins/`

文件可随意命名，推荐使用 TypeScript。

#### 示例：监听 Tool 执行事件

```ts
import type { Plugin } from '@opencode-ai/plugin';

const myPlugin: Plugin = async (ctx: any): Promise<Record<string, unknown>> => {
  return {
    // 调用 tool 前执行
    'tool.execute.before': async (eventCtx: any) => {
      console.log('🔧 Tool执行前:', { toolName: eventCtx.toolName, args: eventCtx.args });
      throw new Error('测试错误 - 这会阻止 Tool 执行');
    },

    // 调用 tool 后执行
    'tool.execute.after': async (eventCtx: any) => {
      console.log('✅ Tool执行后:', {
        toolName: eventCtx.toolName,
        result: typeof eventCtx.result
      });
    },
  };
};

export default myPlugin;
```

#### 测试方法

将文件保存为 `my-plugin.ts`，放到 `.opencode/plugins/` 目录，然后输入指令触发 Tool 执行（如 `帮我总结网页：https://opencode.ai/docs/plugins`），观察日志输出。

### 方式二：复杂 Hook（完整项目）

复杂 Hook 是一个完整的 Node.js 项目，适合开发复杂插件。

在 opencode 的配置文件中添加 `plugins` 配置：

```json
{
  "plugin": [
    "file:///D:/xxx/project-name/src/index.ts"
  ]
}
```

> **注意**：
> - 配置项名称是 `plugin`（单数），不是 `plugins`
> - 使用 `file:///` 协议加载本地文件
> - Windows 路径需使用正斜杠 `/`

#### 生产环境引用方式

```json
{
  "plugin": [
    "oh-my-opencode"
  ]
}
```

## 开发步骤

### 1. 初始化项目

```bash
npm init -y
npm install @opencode-ai/plugin
npm install -D typescript @types/node tsx
npx tsc --init
```

### 2. 最简版验证

```ts
// src/index.ts
import type { Plugin } from '@opencode-ai/plugin';

const myPlugin: Plugin = async (ctx: any): Promise<Record<string, unknown>> => {
  console.log('🚀 插件已加载');

  return {
    'tool.execute.before': async () => {
      console.log('📌 Hook: tool.execute.before 触发');
    },
  };
};

export default myPlugin;
```

在配置文件中引入后，打开 opencode 触发任一 Tool（如执行 webfetch），看到日志输出即说明插件注册成功。

### 3. 扩展功能

建议：
- 将不同功能的处理器抽离到独立模块（hooks/tools）
- 使用统一的日志和错误处理
- 编写类型定义确保类型安全

### 4. 错误处理

```ts
const pluginWithErrorHandling: Plugin = async (ctx: any) => {
  return {
    'tool.execute.before': async (eventCtx: any) => {
      try {
        // 业务逻辑
        console.log('处理 Tool 执行前事件');
      } catch (error) {
        console.error('Hook 执行失败:', error);
      }
    },
  };
};
```

### 5. 发布插件

```bash
npm login
npm publish
```

发布后，其他用户可以通过配置文件引用：

```json
{
  "plugin": ["your-plugin-name"]
}
```

## Tool 开发

### 基础示例

```ts
import { type Plugin, tool } from "@opencode-ai/plugin";

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool for greeting",
        args: {
          name: tool.schema.string().describe("The name to greet"),
          language: tool.schema.string().optional().default("en").describe("Greeting language"),
        },
        async execute(args, context) {
          const { name, language = "en" } = args;
          const { directory } = context;

          const greetings: Record<string, string> = {
            en: `Hello ${name}!`,
            zh: `你好，${name}！`,
            ja: `こんにちは、${name}さん！`,
          };

          return `${greetings[language] || greetings.en} from ${directory}`;
        },
      }),
    },
  };
};
```

> **注意**：自定义 Tool 不能通过 `/` 命令直接调用，但可以通过 prompt 自然语言调用，AI 会根据需求选择合适的 Tool。

### Tool 最佳实践

- **参数验证**：使用 `tool.schema` 定义参数的校验规则
- **描述清晰**：`description` 和参数的 `describe` 要详细准确
- **错误处理**：捕获并妥善处理执行过程中的错误
- **返回格式**：返回清晰的结构化数据，便于 AI 理解
- **幂等性**：相同参数的多次调用应返回一致结果

## 常见问题

### Q1：插件没有生效？

- 检查文件路径是否正确
- 确认配置文件中的 `plugins` 字段写法正确（是 `plugin`，不是 `plugins`）
- 查看 opencode 日志是否有错误信息
- 确认插件已正确导出默认函数

### Q2：如何调试插件？

- 在插件中使用 `console.log` 输出调试信息
- 查看 opencode 启动控制台的日志输出
- 使用 try-catch 捕获并打印错误

### Q3：Plugin 的执行顺序是怎样的？

- 同一事件的所有 Handler 按照插件加载顺序依次执行
- 决定执行顺序需要在配置文件中按顺序声明插件
- 某些事件（如 `tool.execute.before`）可通过返回 `false` 阻止后续流程

### Q4：插件之间能否通信？

- 可以通过共享的全局变量或文件系统等方式进行通信
- 推荐使用文件系统，避免状态管理混乱
- 或者使用中间件模式，将共享逻辑抽取为独立插件

## 参考资源

- [官方文档](https://opencode.ai/docs/config#plugins)
- [oh-my-opencode 插件源码](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/docs/manifesto.md)
