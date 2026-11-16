# @smitfire/board

Single-authority 6-column HITL Kanban & cycle-checked DAG plugin natively integrated into DeepSeek Harness (`@deepseek-ai/dsh@0.2.2-rc.3`) WebUI and standalone MCP servers.

- **Columns**: `backlog | ready | in_progress | review | done | blocked`
- **DAG & Scopes**: DFS cycle rejection on `blockedBy`, automatic promotion from `backlog -> ready` when dependencies hit `done`, `writeScopes` overlap warnings, and optimistic CAS `expectedRevision`.
- **Native WebUI Integration**: Registers `main`, `sidebar.panellist`, and `conversation.input.dock` client slots + loopback-guarded `/ns-board/api/{state,events,cards,move}` SSE/HTTP endpoints + `/board` slash command.

## Test
```bash
npm test
```
