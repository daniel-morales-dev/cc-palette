# cc-palette

A command palette pane for **Claude Code**: browse your MCP servers and models without leaving the prompt.

Type `/palette` and a pane opens beside the transcript with two tabs:

| Tab | Shows |
| --- | --- |
| **MCPs** | Every MCP server available to the session — global servers from `~/.claude.json`, project-scoped servers, and the project's `.mcp.json` — with transport and launch target |
| **Models** | The session's current model, the default configured in settings, model-related environment overrides — and a button that opens the native `/model` picker to switch |

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
- On the Models tab, **Change model** opens the native `/model` picker — switch the model before you send
- With the Ctrl+P binding below, the shortcut toggles the pane open and closed

The pane reads configuration when it opens; press `r` after changing MCP servers or settings.

### Open it from the keyboard (Ctrl+P / Cmd+P)

Mods can't bind global keys, but Claude Code's own keybindings can run a slash command. Add this to `~/.claude/keybindings.json` (run `/keybindings` to create the file):

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+p": "command:palette",
        "cmd+p": "command:palette"
      }
    }
  ]
}
```

Now `Ctrl+P` opens the palette — even while you are typing — and pressing it again closes it. The file is watched, so changes apply without restarting Claude Code. (`cmd+p` needs a terminal that reports the Super key, such as one with the Kitty keyboard protocol.)

A draft in the composer is stashed while the pane is open and put back when it closes, so the pane takes the keyboard right away.

## How it works

The mod is a single hooks module (`hooks/register.js`):

- `session.start` registers the `/palette` command and restores a stashed draft after an interrupted session
- `command.run` stashes any composer draft, opens the pane (`$.ui.open`) — or closes it when it is already open
- `ui.close` restores the stashed draft when the pane closes
- `ui.render`, filtered to this pane, reads the configuration through the mods API and draws the tabs

Data sources:

- MCP servers: `mcpServers` in `~/.claude.json`, `projects[<cwd>].mcpServers` in the same file, and `mcpServers` in `<project>/.mcp.json`. Later sources override earlier ones, so project config wins over global.
- Models: the session model (`$.session.model()`), `model` from `~/.claude/settings.json` or the project's `.claude/settings.json`, and the `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` environment variables. The Models tab lists any `/config` rows about the model (`$.config.list()`) and its **Change model** button runs `/model` (`$.command.run`), so you can switch without leaving the pane.

## Development

```bash
claude plugin validate .
claude --plugin-dir .
```

With `--plugin-dir`, the hooks module reloads when you save it.

## License

MIT
