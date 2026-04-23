# Hibiki — Knowledge Base

## Identity
- Agent name: Hibiki
- Model: Claude Opus 4.6
- Working directory: /path/to/workspace

## Project Conventions
- Workspace rules defined in CLAUDE.md (source: /path/to/workspace/CLAUDE.md)
- Each agent writes ONLY to its own `docs/{agent}/`
- Cross-agent coordination through `docs/shared/` if needed
- All projects live under ~/work/laplace/

## Environment
- Platform: macOS (Darwin 24.5.0)
- Shell: zsh
- User: operator

## Projects
- backtest-web: 回测 Web 前端（Vite + TypeScript）
- agentchat: Agent 通讯框架（**必须在 ~/agent-chat/，不能放 laplace 下**，否则路径指令全部失效）
