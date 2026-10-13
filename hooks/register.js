/**
 * cc-palette — a command palette pane for Claude Code.
 *
 * `/palette` opens a pane with two tabs:
 *   MCPs    — the MCP servers configured for this session (global and project)
 *   Models  — the session model and effort, one-press overrides for your next
 *             messages (model list from /config, effort levels), and a button
 *             that opens the native /model picker
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
let overrideModel = ''
let overrideEffort = ''
let lastStep = null

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

// "sonnet[1m]" reads as "Sonnet (1M)"; unknown values stay as they are.
function prettyValue(value) {
  const names = {
    best: 'Best',
    default: 'Default',
    fable: 'Fable',
    haiku: 'Haiku',
    high: 'High',
    low: 'Low',
    max: 'Max',
    medium: 'Medium',
    none: 'None',
    opus: 'Opus',
    opusplan: 'Opus plan',
    sonnet: 'Sonnet',
  }
  const plain = names[value]
  if (plain) return plain
  const oneM = /^([a-z]+)\[1m\]$/.exec(value)
  if (oneM && names[oneM[1]]) return names[oneM[1]] + ' (1M)'
  return value
}

// "claude-opus-5-5" reads as "Opus 5.5".
function prettyModel(id) {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(asString(id))
  if (!match) return asString(id)
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
  return family + ' ' + match[2] + '.' + match[3]
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

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
      .filter((row) => /model|effort/i.test(row.key) || /model|effort/i.test(row.label))
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

function modelRows(Box, Text, Button, models, configs, onPickModel, onPickEffort, onClear, onOpenPicker) {
  const row = (key, label, value) =>
    Box({
      key: 'model-' + key,
      flexDirection: 'row',
      columnGap: 1,
      children: [Text({ bold: true, children: [label] }), Text({ children: [value] })],
    })

  const active = lastStep && lastStep.model ? lastStep.model : models.session
  const rows = [row('session', 'Session', prettyModel(active) || 'unknown')]
  if (lastStep && lastStep.effort !== undefined && lastStep.effort !== null) {
    rows.push(row('effort', 'Effort', prettyValue(String(lastStep.effort))))
  }
  if (models.configured) rows.push(row('default', 'Default (settings)', models.configured))
  if (models.env) rows.push(row('env', 'ANTHROPIC_MODEL', models.env))
  if (models.smallFast) rows.push(row('small', 'Small/fast', models.smallFast))

  if (overrideModel || overrideEffort) {
    const parts = []
    if (overrideModel) parts.push(prettyValue(overrideModel))
    if (overrideEffort) parts.push('effort ' + prettyValue(overrideEffort))
    rows.push(row('override', 'Next message', parts.join(' · ')))
  }
  rows.push(Text({ children: [' '] }))

  // The /config row names the models this build offers.
  const modelRow =
    configs.find((config) => /^model$/i.test(config.label)) ||
    configs.find((config) => /^model$/i.test(config.key)) ||
    configs.find((config) => config.kind === 'choice' && config.options.length > 0 && !config.isLocked)

  for (const config of configs) {
    if (config === modelRow) continue
    rows.push(
      row('cfg-' + config.key, config.label, config.value + (config.isLocked ? ' (locked)' : '')),
    )
  }

  if (modelRow) {
    rows.push(Text({ bold: true, children: [modelRow.label] }))
    for (const option of modelRow.options) {
      const current = option === overrideModel
      rows.push(
        Button({
          key: 'pick-model-' + option,
          label: (current ? '✓ ' : '  ') + prettyValue(option),
          plain: true,
          dimColor: !current,
          onPress: () => onPickModel(option),
        }),
      )
    }
    rows.push(Text({ children: [' '] }))
  }

  rows.push(Text({ bold: true, children: ['Effort'] }))
  for (const level of EFFORTS) {
    const current = level === overrideEffort
    rows.push(
      Button({
        key: 'pick-effort-' + level,
        label: (current ? '✓ ' : '  ') + prettyValue(level),
        plain: true,
        dimColor: !current,
        onPress: () => onPickEffort(level),
      }),
    )
  }
  rows.push(Text({ children: [' '] }))

  if (overrideModel || overrideEffort) {
    rows.push(
      Button({
        key: 'clear-overrides',
        label: 'Clear overrides (use the session model)',
        onPress: () => onClear(),
      }),
    )
  }
  rows.push(
    Button({
      key: 'open-model-picker',
      label: 'Change model (opens /model)',
      onPress: () => onOpenPicker(),
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

  // The picks override the next requests: `turn.step` lets a hook name the
  // model and the effort each request goes out with. Main loop only — a
  // subagent keeps the model its agent file names.
  on('turn.step', async function* ($, e, next) {
    let input = e
    try {
      if (!e.agentId) {
        lastStep = { model: e.model, effort: e.effort }
        const patch = {}
        if (overrideModel) patch.model = overrideModel
        if (overrideEffort) patch.effort = overrideEffort
        if (patch.model !== undefined || patch.effort !== undefined) {
          input = { ...e, ...patch }
        }
      }
    } catch {}
    yield* next(input)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    if (!data) data = await collect($)

    const pickModel = (value) => {
      overrideModel = value === overrideModel ? '' : value
      notice = overrideModel
        ? 'Next message uses ' + prettyValue(overrideModel) + ' — press it again to clear.'
        : 'Model override cleared — the session model applies.'
      redraw()
    }

    const pickEffort = (value) => {
      overrideEffort = value === overrideEffort ? '' : value
      notice = overrideEffort
        ? 'Next message uses effort ' + prettyValue(overrideEffort) + ' — press it again to clear.'
        : 'Effort override cleared.'
      redraw()
    }

    const clearOverrides = () => {
      overrideModel = ''
      overrideEffort = ''
      notice = 'Overrides cleared — the session model and effort apply.'
      redraw()
    }

    const openModelPicker = async () => {
      try {
        await $.command.run({ command: 'model' })
        notice = 'Model picker opened — the pane refreshes when you are back.'
      } catch (error) {
        // Direct run refused: put /model in the composer so Enter runs it.
        try {
          await $.prompt.fill({ text: '/model', mode: 'replace' })
          notice = 'Could not run /model directly — it is in your prompt: press Enter.'
        } catch {
          notice =
            'Could not open the model picker: ' +
            (error && error.message ? error.message : String(error))
        }
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
        : modelRows(
            Box,
            Text,
            Button,
            data.models,
            data.configs,
            pickModel,
            pickEffort,
            clearOverrides,
            openModelPicker,
          )

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
