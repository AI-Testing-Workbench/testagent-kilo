---
"TestAgent": patch
---

修复 ps-bash 安装报 "spawn powershell.exe ENOENT"：PowerShell 改为绝对路径探测，兼容 PATH 被裁剪或仅安装 PowerShell 7 的 Windows 机器。
