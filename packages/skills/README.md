# @mandujs/skills

Claude Code plugin for the Mandu Framework. Provides 9 architecture skills, guard validation hooks, MCP integration, and development environment setup for agent-native fullstack development.

## 9 Skills

| Skill | Description |
|-------|-------------|
| **mandu-create-feature** | Feature scaffolding via MCP negotiate/generate pipeline |
| **mandu-create-api** | REST API generation with contracts and tests |
| **mandu-debug** | Error diagnosis and repair (8-category triage) |
| **mandu-explain** | Mandu concept reference (18 concepts) |
| **mandu-guard-guide** | Guard architecture guide (6 presets) |
| **mandu-deploy** | Production deployment (Docker, CI/CD, nginx) |
| **mandu-slot** | Filling API reference (ctx methods, lifecycle, middleware) |
| **mandu-fs-routes** | File-system routing rules and layout constraints |
| **mandu-hydration** | Island hydration and client import rules |

## Installation

### Via `mandu init` (Recommended)

```bash
bunx mandu init my-app
```

Skills are automatically installed during project creation.

### Manual Installation

```bash
bun add -D @mandujs/skills
bunx mandu-skills install
```

### Existing Project Upgrade

```bash
bunx mandu-skills install --force
```

## What Gets Installed

```
.claude/
  skills/
    mandu-create-feature.md
    mandu-create-api.md
    mandu-debug.md
    mandu-explain.md
    mandu-guard-guide.md
    mandu-deploy.md
    mandu-slot.md
    mandu-fs-routes.md
    mandu-hydration.md
  settings.json
.mcp.json
```

## CLI

```bash
mandu-skills install              # Install all skills
mandu-skills install --force      # Overwrite existing
mandu-skills install --dry-run    # Preview changes
mandu-skills list                 # List available skills
```

## Version Compatibility

| @mandujs/skills | @mandujs/core | @mandujs/mcp |
|-----------------|---------------|--------------|
| 1.0.x | >= 0.19.0 | >= 0.18.10 |

## License

MPL-2.0
