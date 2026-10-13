/**
 * cc-palette — a command palette pane for Claude Code.
 *
 * `/palette` opens a pane with two tabs:
 *   MCPs    — the MCP servers configured for this session (global and project)
 *   Models  — the session model and effort, one-press switches through the
 *             native /model and /effort commands (the model list from
 *             /config), and a button that opens the /model picker
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
let lastStep = null
let pendingStatus = ''
let pinnedModel = ''
let pinnedEffort = ''

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

// The keyboard cannot be taken back programmatically once the pane loses it
// (verified live: re-opens, waits and fresh ids are all refused), so a pick
// dismisses the pane: the next Ctrl+P opens it fresh, and a fresh open takes
// the keyboard every time.
function closePane($) {
  try {
    $.ui.close({ id: PANE_ID })
  } catch {}
}

// After the pane is gone, a toast is the message that shows: `$.ui.status`
// is dropped from a press or render context, a toast is not.
function flushStatusSoon($) {
  try {
    if (pendingStatus) {
      $.ui.toast(pendingStatus, { timeoutMs: 6000 })
      pendingStatus = ''
    }
  } catch {}
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

function modelRows(Box, Text, Button, models, configs, onPickModel, onPickEffort, onOpenPicker) {
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
  rows.push(Text({ children: [' '] }))

  // The /config row names the models this build offers; a press switches the
  // session through the native /model command, versions and all.
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
      rows.push(
        Button({
          key: 'pick-model-' + option,
          label:
            (option === pinnedModel ? '● ' : option === modelRow.value ? '✓ ' : '  ') +
            prettyValue(option),
          plain: true,
          dimColor: option !== modelRow.value && option !== pinnedModel,
          onPress: () => onPickModel(option),
        }),
      )
    }
    rows.push(Text({ children: [' '] }))
  }

  rows.push(Text({ bold: true, children: ['Effort'] }))
  for (const level of EFFORTS) {
    rows.push(
      Button({
        key: 'pick-effort-' + level,
        label: (level === pinnedEffort ? '● ' : '  ') + prettyValue(level),
        plain: true,
        dimColor: level !== pinnedEffort && !(lastStep && lastStep.effort === level),
        onPress: () => onPickEffort(level),
      }),
    )
  }
  rows.push(Text({ children: [' '] }))

  if (pinnedModel || pinnedEffort) {
    const pinned = [pinnedModel && prettyValue(pinnedModel), pinnedEffort && prettyValue(pinnedEffort)]
      .filter(Boolean)
      .join(' · ')
    rows.push(
      Text({
        dimColor: true,
        children: ['● pinned (' + pinned + ') — press a pinned option again to apply it to the session.'],
      }),
    )
    rows.push(Text({ children: [' '] }))
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
    // A new session starts with fresh data: servers and models may differ.
    data = null
    lastStep = null
    pinnedModel = ''
    pinnedEffort = ''
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
    const mine = panes.find((pane) => pane.id === PANE_ID)
    if (mine) {
      // Open: the shortcut closes it. An unfocused pane can only come back
      // focused through a fresh open, so closing is also the way back.
      closePane($)
      if (!mine.isFocused) {
        pendingStatus = 'Palette closed — Ctrl+P reopens it focused.'
        flushStatusSoon($)
      }
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

  // The Session and Effort rows read the last request's own values: the hook
  // only observes. Main loop only — a subagent keeps the model its agent file
  // names.
  on('turn.step', async function* ($, e, next) {
    try {
      if (!e.agentId) lastStep = { model: e.model, effort: e.effort }
    } catch {}
    yield* next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    if (!data) {
      try {
        data = await collect($)
      } catch (error) {
        data = {
          mcps: [],
          models: {},
          configs: [],
          error: error && error.message ? error.message : String(error),
        }
      }
    }

    // Pressing an option pins it and keeps the keyboard; pressing the pinned
    // option again applies every pin to the session (native commands) and
    // dismisses the pane.
    const commitPicks = async () => {
      const picks = []
      if (pinnedModel)
        picks.push({ command: 'model', args: pinnedModel, label: prettyValue(pinnedModel) })
      if (pinnedEffort)
        picks.push({ command: 'effort', args: pinnedEffort, label: prettyValue(pinnedEffort) })
      pinnedModel = ''
      pinnedEffort = ''
      data = null
      const applied = []
      let failure = ''
      for (const pick of picks) {
        try {
          await $.command.run({ command: pick.command, args: pick.args })
          applied.push(pick.label)
        } catch (error) {
          failure =
            'Could not run /' +
            pick.command +
            ' ' +
            pick.args +
            ': ' +
            (error && error.message ? error.message : String(error))
          break
        }
      }
      closePane($)
      pendingStatus = failure || 'Session set to ' + applied.join(' · ') + '.'
      flushStatusSoon($)
    }

    const pickModel = (value) => {
      if (value === pinnedModel) {
        commitPicks()
        return
      }
      pinnedModel = value
      redraw()
    }
    const pickEffort = (value) => {
      if (value === pinnedEffort) {
        commitPicks()
        return
      }
      pinnedEffort = value
      redraw()
    }

    const openModelPicker = async () => {
      try {
        await $.command.run({ command: 'model' })
      } catch (error) {
        // Direct run refused: put /model in the composer so Enter runs it.
        try {
          await $.prompt.fill({ text: '/model', mode: 'replace' })
          pendingStatus = 'Could not run /model directly — it is in your prompt: press Enter.'
          closePane($)
          flushStatusSoon($)
          return
        } catch {
          pendingStatus =
            'Could not open the model picker: ' +
            (error && error.message ? error.message : String(error))
          closePane($)
          flushStatusSoon($)
          return
        }
      }
      data = null
      pendingStatus = 'Model picker open — pick a model, then Ctrl+P reopens the palette.'
      closePane($)
      flushStatusSoon($)
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

    const body = data.error
      ? [
          Text({ children: ['Could not read the configuration: ' + data.error] }),
          Text({ dimColor: true, children: ['Press r to retry.'] }),
        ]
      : tab === 'mcps'
        ? mcpRows(Box, Text, data.mcps)
        : modelRows(
            Box,
            Text,
            Button,
            data.models,
            data.configs,
            pickModel,
            pickEffort,
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
