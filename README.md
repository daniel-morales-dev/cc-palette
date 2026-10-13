# cc-palette

A command palette pane for **Claude Code**: browse your MCP servers and models without leaving the prompt.

Type `/palette` and a pane opens beside the transcript with two tabs:

| Tab | Shows |
| --- | --- |
| **MCPs** | Every MCP server available to the session — global servers from `~/.claude.json`, project-scoped servers, and the project's `.mcp.json` — with transport and launch target |
| **Models** | The session's model and effort, one-press switches through the native `/model` and `/effort` commands (model options from `/config`, effort levels low → max), and a button that opens the `/model` picker |

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
- On the Models tab, press a model or an effort level to switch the session right away — it applies to your next message — or use **Change model** for the native `/model` picker
- With the Ctrl+P binding below, the shortcut opens the pane and closes it; a pick dismisses the pane by itself, so the next Ctrl+P always brings it back fresh, focused on the same tab

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
    },
    {
      "context": "Pane",
      "bindings": {
        "space": "abovePrompt:press"
      }
    }
  ]
}
```

Now `Ctrl+P` opens the palette — even while you are typing — and pressing it again closes it. A pick (a model or an effort) dismisses the pane on its own and reports under the prompt, so the next `Ctrl+P` opens it fresh and focused, on the same tab. The second binding makes `Space` press the focused option inside the pane, like `Enter`. The file is watched, so changes apply without restarting Claude Code. (`cmd+p` needs a terminal that reports the Super key, such as one with the Kitty keyboard protocol.)

A draft in the composer is stashed while the pane is open and put back when it closes, so the pane takes the keyboard right away.

## How it works

The mod is a single hooks module (`hooks/register.js`):

- `session.start` registers the `/palette` command and restores a stashed draft after an interrupted session
- `command.run` stashes any composer draft, opens the pane (`$.ui.open`) with the keyboard, and closes it on the next press — a pane that lost the keyboard cannot take it back (verified against the engine), so a fresh open is the way back, and a pick dismisses the pane itself
- `ui.close` restores the stashed draft when the pane closes
- `turn.step` observes the model and effort each request goes out with, for the Session and Effort rows
- `ui.render`, filtered to this pane, reads the configuration through the mods API and draws the tabs

Data sources:

- MCP servers: `mcpServers` in `~/.claude.json`, `projects[<cwd>].mcpServers` in the same file, and `mcpServers` in `<project>/.mcp.json`. Later sources override earlier ones, so project config wins over global.
- Models: the session model (`$.session.model()`), `model` from `~/.claude/settings.json` or the project's `.claude/settings.json`, and the `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` environment variables. The model options come from the `/config` row (`$.config.list()`); a press runs the native `/model <alias>` or `/effort <level>` (`$.command.run`) — the same switch the slash commands make, so the status line at the bottom reflects it. A pick dismisses the pane and leaves the result under the prompt; Ctrl+P opens it again, focused on the same tab. Effort needs a model that supports it (Opus, Sonnet); on a model without it the pane says so. **Change model** opens the picker for versions and the effort slider.

## Development

```bash
claude plugin validate .
claude --plugin-dir .
```

With `--plugin-dir`, the hooks module reloads when you save it.

## License

MIT
