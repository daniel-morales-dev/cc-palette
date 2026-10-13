# cc-palette

A command palette pane for **Claude Code**: browse your MCP servers and models without leaving the prompt.

Type `/palette` and a pane opens beside the transcript with two tabs:

| Tab | Shows |
| --- | --- |
| **MCPs** | Every MCP server available to the session — global servers from `~/.claude.json`, project-scoped servers, and the project's `.mcp.json` — with transport and launch target |
| **Models** | The session's current model, the default configured in settings, and model-related environment overrides |

Built as a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods), so the command registers with `immediate: true`: it works **while Claude is working**, like OpenCode's `ctrl+p` palette.

## Install

### From the marketplace (recommended)

```bash
claude plugin marketplace add daniel-morales-dev/cc-palette
claude plugin install cc-palette@cc-palette
```

Then run `/palette` in any session. If you installed from your shell with a session open, run `/reload-plugins` there.

### Try it without installing

```bash
claude --plugin-dir /path/to/cc-palette
```

### Requirements

- Claude Code v2.1.287 or later (mods)
- Mods are on by default; nothing else to enable

## Usage

- `/palette` — open the pane on the MCPs tab
- `/palette models` — open it on the Models tab
- Keys while the pane has focus:
  - `1` / `2` — switch between MCPs and Models
  - `r` — refresh the data
  - `Tab` / arrows — move between controls
  - `Esc` — close the pane

The pane reads configuration when it opens; press `r` after changing MCP servers or settings.

## How it works

The mod is a single hooks module (`hooks/register.js`):

- `session.start` registers the `/palette` command
- `command.run` opens the pane (`$.ui.open`)
- `ui.render`, filtered to this pane, reads the configuration through the mods API and draws the tabs

Data sources:

- MCP servers: `mcpServers` in `~/.claude.json`, `projects[<cwd>].mcpServers` in the same file, and `mcpServers` in `<project>/.mcp.json`. Later sources override earlier ones, so project config wins over global.
- Models: the session model (`$.session.model()`), `model` from `~/.claude/settings.json` or the project's `.claude/settings.json`, and the `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` environment variables.

## Development

```bash
claude plugin validate .
claude --plugin-dir .
```

With `--plugin-dir`, the hooks module reloads when you save it.

## License

MIT
