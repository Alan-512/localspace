---
name: localspace-handoff
description: Use when producing a new-window handoff for a long LocalSpace coding task.
---

# LocalSpace Handoff

Use this skill when the user asks for a handoff, next-window continuation note, or long-task summary.

## Required sections


```markdown
# 新窗口交接说明

## 项目
路径：
当前分支 / worktree：
当前 Phase / Task：

## 最新提交
最新 commit：
最近关键 commit：

## 已完成
- 
- 
- 

## 当前状态
- 测试结果：
- git status：
- 已知问题：

## 下一步任务
1. 
2. 
3. 

## 重要约束
- 不要误判当前阶段
- 不要声明未完成能力为 supported
- 不要写死本地绝对路径
- 修改前先检查现有架构
```

Before writing the handoff, check recent commits, current Git status, validation results, and known caveats.

