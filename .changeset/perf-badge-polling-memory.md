---
"TestAgent": patch
---

降低工作台内存与后台开销:设置/Marketplace 等面板不再各自启动 diff 徽章 git 轮询,徽章轮询间隔放宽到 15 秒,设置页隐藏时释放 webview 内存,Changes 面板隐藏时暂停 diff 轮询;任务时间线条带在流式输出期间改为最多每秒重算一次,降低渲染进程 CPU 与内存增长。
