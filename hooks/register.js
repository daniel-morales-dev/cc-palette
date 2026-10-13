/**
 * cc-palette — a command palette pane for Claude Code.
 *
 * `/palette` opens a pane with two tabs:
 *   MCPs    — the MCP servers configured for this session (global and project)
 *   Models  — the session model and the models configured in settings/env
 *
 * The command registers with `immediate: true`, so it runs while Claude is
 * working, like OpenCode's ctrl+p palette.
 */

const PANE_ID = 'cc-palette'

let tab = 'mcps'
let data = null

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

  return { mcps, models }
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

function modelRows(Box, Text, models) {
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
  rows.push(
    Text({
      dimColor: true,
      children: ['Switch models with /model — this pane shows what is configured.'],
    }),
  )
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
    return next(e)
  })

  on('command.run', { command: 'palette' }, async ($, e) => {
    const arg = asString(e.args).trim().toLowerCase()
    if (arg === 'mcps' || arg === 'models') tab = arg
    data = null
    await $.ui.open({ id: PANE_ID, title: 'Palette', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    if (!data) data = await collect($)

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
      tab === 'mcps' ? mcpRows(Box, Text, data.mcps) : modelRows(Box, Text, data.models)

    return Box({
      flexDirection: 'column',
      children: [header, Text({ children: [' '] }), ...body],
    })
  })
}
