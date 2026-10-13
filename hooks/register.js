/**
 * cc-palette — a command palette pane for Claude Code.
 *
 * `/palette` opens a pane with two tabs:
 *   MCPs    — the MCP servers configured for this session (global and project)
 *   Models  — the session model, what settings/env configure, and a switcher
 *             when /config exposes a model row
 *
 * The command registers with `immediate: true`, so it runs while Claude is
 * working. Bind Ctrl+P (or Cmd+P) to `command:palette` in
 * ~/.claude/keybindings.json to open it from the keyboard — see the README.
 *
 * When the composer holds a draft, the draft is stashed while the pane is open
 * and restored when it closes, so the pane takes the keyboard right away.
 */

const PANE_ID = 'cc-palette'
const STASH_KEY = 'stashed-draft'

let tab = 'mcps'
let data = null
let notice = ''

function asString(value) {
  return typeof value === 'string' ? value : ''
}

async function readJson($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

function describeServer(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const kind = asString(cfg.type) || (asString(cfg.url) ? 'http' : 'stdio')
  const target =
    asString(cfg.url) ||
    [asString(cfg.command), ...(Array.isArray(cfg.args) ? cfg.args : [])]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' ')
  return { kind, target }
}

async function collect($) {
  const home = asString(await $.env.get('HOME'))
  const cwd = await $.session.cwd()
  const mcps = []
  const indexByName = {}

  // Later sources override earlier ones: project config wins over global.
  const add = (name, config, scope) => {
    const { kind, target } = describeServer(config)
    const entry = { name, scope, kind, target }
    const i = indexByName[name]
    if (i === undefined) {
      indexByName[name] = mcps.length
      mcps.push(entry)
    } else {
      mcps[i] = entry
    }
  }

  const claudeJson = await readJson($, home + '/.claude.json')
  const globalServers =
    claudeJson && claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object'
      ? claudeJson.mcpServers
      : {}
  for (const [name, config] of Object.entries(globalServers)) add(name, config, 'global')

  const projects =
    claudeJson && claudeJson.projects && typeof claudeJson.projects === 'object'
      ? claudeJson.projects
      : {}
  const projectEntry = projects[cwd]
  const projectServers =
    projectEntry && projectEntry.mcpServers && typeof projectEntry.mcpServers === 'object'
      ? projectEntry.mcpServers
      : {}
  for (const [name, config] of Object.entries(projectServers)) add(name, config, 'project')

  const localMcp = await readJson($, cwd + '/.mcp.json')
  const localServers =
    localMcp && localMcp.mcpServers && typeof localMcp.mcpServers === 'object'
      ? localMcp.mcpServers
      : {}
  for (const [name, config] of Object.entries(localServers)) {
    add(name, config, 'project (.mcp.json)')
  }

  const settings = await readJson($, home + '/.claude/settings.json')
  const projectSettings = await readJson($, cwd + '/.claude/settings.json')
  const models = {
    session: await $.session.model(),
    configured:
      asString(projectSettings && projectSettings.model) ||
      asString(settings && settings.model),
    env: asString(await $.env.get('ANTHROPIC_MODEL')),
    smallFast: asString(await $.env.get('ANTHROPIC_SMALL_FAST_MODEL')),
  }

  // `/config` rows about the model. A choice row is switchable from the pane;
  // the rows a session actually has are the engine's to say, so read live.
  let configs = []
  try {
    const rows = await $.config.list()
    configs = rows
      .filter((row) => /model/i.test(row.key) || /model/i.test(row.label))
      .map((row) => ({
        key: row.key,
        label: row.label,
        kind: row.kind,
        value: typeof row.value === 'string' ? row.value : String(row.value),
        options: Array.isArray(row.options) ? row.options.slice() : [],
        isLocked: row.isLocked === true,
      }))
  } catch {}

  return { mcps, models, configs }
}

async function stashDraft($) {
  const box = await $.prompt.read()
  if (!box.text) return { stashed: false, hint: false }
  await $.store.set(STASH_KEY, box.text)
  const cleared = await $.prompt.fill({ text: '', mode: 'replace' })
  if (!cleared.isFilled) {
    await $.store.delete(STASH_KEY)
    return { stashed: false, hint: true }
  }
  return { stashed: true, hint: false }
}

async function restoreDraft($) {
  const stash = await $.store.get(STASH_KEY)
  if (typeof stash !== 'string' || stash === '') return
  const box = await $.prompt.read()
  const text = box.text ? stash + '\n' + box.text : stash
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) await $.store.delete(STASH_KEY)
}

function mcpRows(Box, Text, mcps) {
  if (mcps.length === 0) {
    return [Text({ dimColor: true, children: ['No MCP servers configured for this session.'] })]
  }
  return mcps.map((mcp) =>
    Box({
      key: 'mcp-' + mcp.name,
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Text({ color: 'green', children: ['●'] }),
            Text({ bold: true, children: [mcp.name] }),
            Text({ dimColor: true, children: [mcp.kind + ' · ' + mcp.scope] }),
          ],
        }),
        ...(mcp.target
          ? [Text({ dimColor: true, wrap: 'truncate-end', children: ['  ' + mcp.target] })]
          : []),
      ],
    }),
  )
}

function modelRows(Box, Text, Select, models, configs, onSwitch) {
  const row = (key, label, value) =>
    Box({
      key: 'model-' + key,
      flexDirection: 'row',
      columnGap: 1,
      children: [Text({ bold: true, children: [label] }), Text({ children: [value] })],
    })

  const rows = [row('session', 'Session', models.session || 'unknown')]
  if (models.configured) rows.push(row('default', 'Default (settings)', models.configured))
  if (models.env) rows.push(row('env', 'ANTHROPIC_MODEL', models.env))
  if (models.smallFast) rows.push(row('small', 'Small/fast', models.smallFast))
  rows.push(Text({ children: [' '] }))

  const switchable = configs.filter(
    (config) => config.kind === 'choice' && config.options.length > 0 && !config.isLocked,
  )
  for (const config of switchable) {
    rows.push(
      Select({
        key: 'switch-' + config.key,
        label: config.label,
        options: config.options.map((option) => ({ value: option, label: option })),
        value: config.value,
        onSelect: (value) => onSwitch(config.key, value),
      }),
    )
  }

  if (switchable.length === 0) {
    rows.push(
      Text({
        dimColor: true,
        children: ['Switch models with /model — this pane shows what is configured.'],
      }),
    )
  }
  return rows
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'palette',
        description: 'Open the palette pane: MCP servers and models',
        argumentHint: '[mcps|models]',
        immediate: true,
      })
    } catch {
      // A built-in or another plugin already owns /palette; everything else still loads.
    }
    // A draft left stashed by an interrupted session comes back here.
    try {
      await restoreDraft($)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'palette' }, async ($, e) => {
    const arg = asString(e.args).trim().toLowerCase()
    if (arg === 'mcps' || arg === 'models') tab = arg

    const panes = await $.ui.panes()
    if (panes.some((pane) => pane.id === PANE_ID)) {
      // The shortcut pressed again closes the pane, like a palette toggle.
      try {
        await $.ui.close({ id: PANE_ID })
      } catch {}
      return {}
    }

    const stash = await stashDraft($)
    notice = stash.hint
      ? 'Composer has text — press Ctrl+X Tab to give this pane the keyboard.'
      : stash.stashed
        ? 'Draft stashed — it returns when the palette closes.'
        : ''
    data = null
    await $.ui.open({ id: PANE_ID, title: 'Palette', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID) {
      notice = ''
      try {
        await restoreDraft($)
      } catch {}
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button, Select } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    if (!data) data = await collect($)

    const switchModel = async (key, value) => {
      try {
        const result = await $.config.set({ key, value })
        notice =
          result && result.deny
            ? 'Model change refused: ' + result.deny
            : 'Model set to ' + value + '.'
      } catch (error) {
        notice = 'Model change failed: ' + (error && error.message ? error.message : String(error))
      }
      data = null
      redraw()
    }

    const tabButton = (name, label, hotkey) =>
      Button({
        key: 'tab-' + name,
        label,
        hotkey,
        plain: true,
        dimColor: tab !== name,
        onPress: () => {
          tab = name
          redraw()
        },
      })

    const header = Box({
      flexDirection: 'row',
      columnGap: 3,
      children: [
        tabButton('mcps', 'MCPs', '1'),
        tabButton('models', 'Models', '2'),
        Button({
          key: 'refresh',
          label: 'Refresh',
          hotkey: 'r',
          plain: true,
          dimColor: true,
          onPress: () => {
            data = null
            redraw()
          },
        }),
      ],
    })

    const body =
      tab === 'mcps'
        ? mcpRows(Box, Text, data.mcps)
        : modelRows(Box, Text, Select, data.models, data.configs, switchModel)

    return Box({
      flexDirection: 'column',
      children: [
        header,
        Text({ children: [' '] }),
        ...body,
        ...(notice
          ? [Text({ children: [' '] }), Text({ dimColor: true, children: [notice] })]
          : []),
      ],
    })
  })
}
