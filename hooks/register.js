// Command Optimizer mod for Claude Code
// After the person presses Enter, Sonnet checks the prompt before Claude starts and, when a
// command would help (/plan, /effort high, /clear, !npm test, ...), offers to run it first.

const BUILTIN_COMMANDS = [
  { name: 'plan', description: 'Switch to Plan mode to design multi-file architecture before editing code' },
  { name: 'effort', description: 'Adjust model thinking effort: /effort low, /effort medium, /effort high, /effort xhigh, /effort max' },
  { name: 'model', description: 'Switch active model (sonnet for speed/coding, opus for deep architecture, haiku for quick tasks)' },
  { name: 'compact', description: 'Summarize and compact conversation history to free context window tokens' },
  { name: 'context', description: 'Inspect token breakdown and see which files/tools are filling the context window' },
  { name: 'clear', description: 'Clear conversation transcript and reset context when switching to an unrelated task' },
  { name: 'diff', description: 'Open the interactive diff viewer to inspect uncommitted file edits' },
  { name: 'review', description: 'Review current branch changes or a pull request for bugs, regressions, and style' },
  { name: 'security-review', description: 'Run a dedicated security audit on recent code changes' },
  { name: 'rewind', description: 'Rewind code and conversation to a previous checkpoint when an approach goes wrong' },
  { name: 'btw', description: 'Ask a quick side question (/btw <question>) without polluting main conversation history' },
  { name: 'init', description: 'Generate a starter CLAUDE.md project instruction file for the repository' },
  { name: 'memory', description: 'Edit CLAUDE.md persistent project instructions and coding conventions' },
  { name: 'doctor', description: 'Diagnose Claude Code installation, environment, and tool configuration issues' },
  { name: 'tasks', description: 'View and manage active background tasks and subagents' },
  { name: 'usage', description: 'Check current plan usage limits, rate limits, and session cost' },
  { name: 'mcp', description: 'Inspect, connect, or authenticate Model Context Protocol (MCP) servers' },
  { name: 'permissions', description: 'View or configure tool approval and allow/deny permission rules' }
]

// Static rubric. Sent first and marked for the prompt cache, so repeated checks in a
// session read it from the cache instead of paying for it again.
const STATIC_RUBRIC = `You are the Command Optimizer for Claude Code.
For each prompt the user sends, you look at the prompt and the recent session trajectory and recommend 1 to 3 high-leverage commands they should consider running now or right after this turn.

### Command Categories You Can Suggest
1. **Claude Code slash commands (\`kind: "slash"\`)**:
   - \`/plan\`: complex features, multi-file refactors, migrations, or architectural changes where jumping straight into edits risks rework.
   - \`/effort low\`: quick tweaks, copy edits, formatting, brainstorming, or simple single-file questions.
   - \`/effort high\`: tricky concurrency, financial calculations, security-sensitive logic, or edge-case-heavy refactors.
   - \`/effort medium\`: moving from heavy verification back to normal implementation work.
   - \`/diff\`: the user just asked for code changes and should inspect the diff before committing or continuing.
   - \`/review\`: wrapping up a feature, preparing a PR, or asking whether the implementation looks ready.
   - \`/security-review\`: the prompt touches authentication, JWTs, OAuth, SQL, shell execution, secrets, permissions, or input sanitization.
   - \`/compact\` or \`/context\`: the session has run many turns, or it is moving between milestones and should keep a summary.
   - \`/clear\`: the new prompt pivots to an unrelated topic and old context only adds noise and cost.
   - \`/rewind\`: the user says a recent edit broke tests or went down the wrong path.
   - \`/btw\`: a tangential conceptual question in the middle of a coding task.
   - \`/init\` or \`/memory\`: the user states a recurring project rule (for example "always use bun") that belongs in CLAUDE.md.
   - \`/doctor\`, \`/mcp\` or \`/permissions\`: environment, MCP connection, or permission-prompt problems.
   - Any custom or plugin command from the session catalog below that matches the user's intent.
   Only suggest slash commands that appear in the session catalog below.

2. **Shell escapes (\`kind: "cli"\`, prefixed with \`!\`)**:
   - In Claude Code, \`!<command>\` (for example \`!git status\`, \`!npm test\`, \`!pytest -q\`, \`!tsc --noEmit\`) runs it in the project shell and adds the output to the conversation.
   - Suggest one when a quick test, typecheck, lint, or git check is the fastest next action. Never suggest destructive commands (rm, reset --hard, force pushes, deploys).

### When Not To Suggest
- If no command would clearly help, return an empty list: \`{"suggestions":[]}\`. An empty list is better than a weak suggestion.

### Output Contract
- Output ONLY one valid JSON object, with no markdown fences or commentary.
- 0 to 3 items in \`"suggestions"\`, highest utility first.
- \`"label"\` is the command itself (\`"/plan"\`, \`"/effort high"\`, \`"!npm test"\`).
- \`"reason"\` is under 12 words and specific to the current prompt.

JSON schema:
{
  "suggestions": [
    {
      "command": "/plan",
      "kind": "slash",
      "label": "/plan",
      "reason": "Multi-file auth refactor benefits from upfront planning"
    }
  ]
}`

const MAX_CACHE_ENTRIES = 50
const MAX_RECENT_PROMPTS = 3
const MIN_PROMPT_CHARS = 12
// ask: check after Enter and offer to run a command before Claude starts (default)
// band: check alongside the turn and show suggestions above the prompt, never waiting
const MODES = ['ask', 'band']
const MODE_ALIASES = { gate: 'ask', recommend: 'band', context: 'band' }
const MODELS = ['sonnet', 'haiku', 'opus']
// Prompts that are clearly acknowledgements: not worth a model call.
const TRIVIAL_PROMPT = /^(y|yes|no|n|ok|okay|sure|thanks|thank you|continue|go on|go ahead|do it|proceed|next|lgtm|done)[.!]*$/i
// Only the person's own prompts are checked, not task notifications, peers, or this mod's own resubmits.
const PERSON_ORIGINS = new Set(['composer', 'bridge'])
const SEND_AS_IS = 'Just send my prompt'

// Module state shared across hooks in the session
let enabled = true
let mode = 'ask'
let model = 'sonnet'
let suggestions = []
let sessionCommands = []
let knownCommands = new Set(BUILTIN_COMMANDS.map((c) => c.name))
let recentPrompts = []
let checking = false
let dismissed = false
let totalChecks = 0
let memoHits = 0
let promptCacheReads = 0
let lastCacheReadTokens = 0
let checkSeq = 0

// Other mods this one works alongside. A partner that owns a command takes it off this mod's list
// (Effort Optimizer already picks the effort level, so /effort is never suggested twice), and a
// partner that checks the person's prompts gets the prompt back from the composer after a command
// runs, so it checks that prompt too.
const PARTNERS = {
  'effort-optimizer': { owns: ['effort'], checksPrompts: true, does: 'picks the effort level for each prompt' }
}
let partners = [] // names of PARTNERS present in this session
// The text this mod put back into the prompt box, so pressing Enter on it is not checked a second time.
let skipOnce = ''
// The /mods switchboard (~/.claude/mods/switches.json) can turn this mod off, as it does Effort Optimizer.
const NAME = 'command-optimizer'
let switchedOff = false
let switchesPath = ''

function ownedByPartner(name) {
  return partners.some((p) => PARTNERS[p].owns.includes(name))
}

function promptCheckingPartners() {
  return partners.filter((p) => PARTNERS[p].checksPrompts)
}

async function readSwitch($) {
  if (!switchesPath) return
  try {
    if (await $.fs.exists(switchesPath)) {
      const json = JSON.parse(String(await $.fs.read(switchesPath)))
      switchedOff = json[NAME] === false
    } else {
      switchedOff = false
    }
  } catch {
    // Keep the last answer
  }
}

// In-memory LRU of results for identical prompt + history within the session
const suggestionCache = new Map()

function resetState() {
  enabled = true
  mode = 'ask'
  model = 'sonnet'
  suggestions = []
  sessionCommands = []
  knownCommands = new Set(BUILTIN_COMMANDS.map((c) => c.name))
  recentPrompts = []
  checking = false
  dismissed = false
  totalChecks = 0
  memoHits = 0
  promptCacheReads = 0
  lastCacheReadTokens = 0
  checkSeq = 0
  partners = []
  skipOnce = ''
  switchedOff = false
  switchesPath = ''
  suggestionCache.clear()
}

function normalizeName(name) {
  return String(name || '').replace(/^\//, '').trim()
}

function asMode(value) {
  const v = String(value || '').toLowerCase()
  if (MODES.includes(v)) return v
  return MODE_ALIASES[v] || ''
}

function buildCatalogText(dynamicCommands) {
  const seen = new Set()
  const lines = []
  for (const cmd of [...dynamicCommands, ...BUILTIN_COMMANDS]) {
    const name = normalizeName(cmd && cmd.name)
    if (!name || seen.has(name) || name === NAME || ownedByPartner(name)) continue
    seen.add(name)
    lines.push('- /' + name + ': ' + (cmd.description || 'Session slash command'))
  }
  return '### Active Session Slash Commands\n' + lines.join('\n')
}

// A slash suggestion must name a command this session has; a cli one must start with `!`.
function isKnownCommand(cmd) {
  if (/[\r\n]/.test(cmd)) return false
  if (cmd.startsWith('!')) return cmd.slice(1).trim().length > 0
  if (!cmd.startsWith('/')) return false
  const name = cmd.slice(1).split(/\s+/)[0]
  return name !== NAME && !ownedByPartner(name) && knownCommands.has(name)
}

function parseSuggestions(rawText) {
  if (!rawText || typeof rawText !== 'string') return []
  try {
    const startIdx = rawText.indexOf('{')
    const endIdx = rawText.lastIndexOf('}')
    const jsonSlice =
      startIdx !== -1 && endIdx > startIdx ? rawText.slice(startIdx, endIdx + 1) : rawText.trim()
    const parsed = JSON.parse(jsonSlice)
    if (!parsed || !Array.isArray(parsed.suggestions)) return []
    const seen = new Set()
    const out = []
    for (const item of parsed.suggestions) {
      if (!item || typeof item.command !== 'string') continue
      const cmd = item.command.trim()
      if (!cmd || seen.has(cmd) || !isKnownCommand(cmd)) continue
      seen.add(cmd)
      out.push({
        command: cmd,
        kind: cmd.startsWith('!') ? 'cli' : 'slash',
        label: String(item.label || cmd).trim().slice(0, 32) || cmd.slice(0, 32),
        reason: String(item.reason || 'Recommended for this prompt')
          .trim()
          .replace(/\s*[—–]\s*/g, ', ')
          .slice(0, 90)
      })
      if (out.length === 3) break
    }
    return out
  } catch {
    return []
  }
}

function shouldCheck(e) {
  if (!enabled || switchedOff || e.command || e.isMeta) return false
  if (e.origin && !PERSON_ORIGINS.has(e.origin.kind)) return false
  const text = (e.text || '').trim()
  if (text.length < MIN_PROMPT_CHARS) return false
  if (text.startsWith('/') || text.startsWith('!')) return false
  return !TRIVIAL_PROMPT.test(text)
}

async function loadSavedConfig($) {
  try {
    const savedMode = asMode(await $.store.get('mode'))
    if (savedMode) mode = savedMode
    const savedEnabled = await $.store.get('enabled')
    if (typeof savedEnabled === 'boolean') enabled = savedEnabled
  } catch {
    // Ignore store errors on restricted runners
  }
}

function setStatus($, text) {
  try {
    $.ui.status(text)
  } catch {
    // The status line is a nicety
  }
}

// Fill the command into the prompt box; copy it to the clipboard where the box can't take it.
async function applyCommandChoice($, commandText, surface) {
  try {
    const res = await $.prompt.fill({ text: commandText })
    if (res && res.isFilled) {
      $.ui.toast('Filled `' + commandText + '` into the prompt box')
      return 'filled'
    }
  } catch {
    // fall through to the clipboard
  }
  try {
    const copied = await $.ui.copy(surface ? { text: commandText, surface } : { text: commandText })
    if (copied && copied.isCopied) {
      $.ui.toast('Copied `' + commandText + '` to the clipboard')
      return 'copied'
    }
  } catch {
    // fall through
  }
  $.ui.toast('Could not fill or copy `' + commandText + '`; type it at the prompt')
  return 'failed'
}

function remember(cacheKey, parsed) {
  if (suggestionCache.has(cacheKey)) suggestionCache.delete(cacheKey)
  if (suggestionCache.size >= MAX_CACHE_ENTRIES) {
    suggestionCache.delete(suggestionCache.keys().next().value)
  }
  suggestionCache.set(cacheKey, parsed)
}

// Claude's last reply, for context: what the person is answering often decides the command.
async function lastReply($) {
  try {
    const messages = await $.session.messages()
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m && m.role === 'assistant' && m.text && m.text.trim()) return m.text.trim().slice(0, 600)
    }
  } catch {
    // No transcript to read
  }
  return ''
}

async function evaluatePrompt($, promptText) {
  const seq = ++checkSeq
  const historyContext =
    recentPrompts.length > 0
      ? 'Recent prompts earlier in this session:\n' +
        recentPrompts.map((p, i) => i + 1 + '. ' + p).join('\n') +
        '\n\n'
      : ''
  const cacheKey = historyContext + 'CURRENT:' + promptText

  if (suggestionCache.has(cacheKey)) {
    const cached = suggestionCache.get(cacheKey)
    remember(cacheKey, cached) // refresh LRU position
    memoHits += 1
    const wasChecking = checking
    checking = false
    setStatus($, undefined)
    if (mode === 'band') {
      suggestions = cached
      dismissed = false
      $.ui.invalidate('ui.render')
    } else if (wasChecking) {
      $.ui.invalidate('ui.render')
    }
    return cached
  }

  checking = true
  setStatus($, 'Sonnet is checking for useful commands…')
  if (mode === 'band') {
    dismissed = false
    $.ui.invalidate('ui.render')
  }

  const reply = await lastReply($)
  let response = null
  try {
    response = await $.model.complete({
      model,
      prompt: [
        { text: STATIC_RUBRIC + '\n\n' + buildCatalogText(sessionCommands) + partnerNote(), cache: true },
        {
          text:
            historyContext +
            (reply ? 'Claude’s last reply (first 600 characters):\n<reply>\n' + reply + '\n</reply>\n\n' : '') +
            'Current user prompt:\n<prompt>\n' +
            promptText.slice(0, 4000) +
            '\n</prompt>'
        }
      ],
      maxTokens: 300,
      effort: 'low',
      timeoutMs: 15000
    })
  } catch (err) {
    // Only a request the engine refuses to send rejects (a blocked model, say)
    $.ui.log('command-optimizer: model call refused: ' + String(err && err.message), { to: 'debug' })
    response = null
  } finally {
    setStatus($, undefined)
  }

  totalChecks += 1
  if (response && response.usage) {
    lastCacheReadTokens = Number(response.usage.cache_read_input_tokens || 0)
    if (lastCacheReadTokens > 0) promptCacheReads += 1
  }
  if (response && !response.isAnswered) {
    $.ui.log('command-optimizer: no suggestions (' + response.reason + ')', { to: 'debug' })
  }

  const parsed = response && response.isAnswered ? parseSuggestions(response.text) : []
  if (response && response.isAnswered) remember(cacheKey, parsed)

  if (seq === checkSeq) {
    checking = false
    if (mode === 'band') {
      suggestions = parsed
      $.ui.invalidate('ui.render')
    }
  }
  return parsed
}

function partnerNote() {
  if (partners.length === 0) return ''
  return (
    '\n\n### Other Mods In This Session\n' +
    partners
      .map((p) => {
        const owned = PARTNERS[p].owns.map((c) => '/' + c).join(', ')
        return '- ' + p + ' ' + PARTNERS[p].does + '. Never suggest ' + owned + '; that mod handles it.'
      })
      .join('\n')
  )
}

// Runs the chosen slash command, then hands the held prompt on. Done from a timer: a command
// can't run inside the prompt.submit hook the turn waits on.
// With a prompt-checking partner (Effort Optimizer) the prompt goes back into the prompt box,
// so the person's Enter sends it as their own and the partner checks it; otherwise it is sent.
function runThenSend($, command, promptText) {
  const parts = command.slice(1).split(/\s+/)
  const name = parts[0]
  const args = parts.slice(1).join(' ')
  const checkers = promptCheckingPartners()
  $.clock.after(0, async () => {
    let ranOk = true
    try {
      await $.command.run(args ? { command: name, args } : { command: name })
    } catch (err) {
      ranOk = false
      $.ui.toast('Could not run `' + command + '`: ' + String((err && err.message) || err).slice(0, 120))
    }
    if (checkers.length > 0) {
      skipOnce = promptText.trim()
      try {
        const res = await $.prompt.fill({ text: promptText })
        if (res && res.isFilled) {
          $.ui.toast(
            (ranOk ? 'Ran ' : 'Could not run ') +
              command +
              '. Your prompt is back in the box: press Enter to send it'
          )
          return
        }
      } catch {
        // fall back to sending it
      }
      skipOnce = ''
    }
    try {
      await $.prompt.submit({ text: promptText, asUser: true })
    } catch {
      await applyCommandChoice($, promptText)
    }
  })
}

// The ask flow: show Sonnet's suggestions in a dialog before Claude starts.
async function askBeforeSending($, e, next, current) {
  const options = current.map((s) =>
    s.kind === 'cli' ? 'Run ' + s.label + ' first' : s.label + ', then my prompt'
  )
  let answer = ''
  try {
    answer = await $.ui.ask(
      'Sonnet suggests ' +
        current.map((s) => s.label + ' (' + s.reason + ')').join('; ') +
        '. Run one before Claude starts?',
      { header: 'Commands', options: [...options, SEND_AS_IS] }
    )
  } catch {
    // Dismissed, or nobody to ask: send the prompt as it is
    return next(e)
  }
  const picked = current[options.indexOf(answer)]
  if (!picked) return next(e)

  if (picked.kind === 'cli') {
    // Claude runs the shell command first, through the normal permission prompt
    const shell = picked.command.slice(1).trim()
    $.ui.toast('Claude will run `' + shell + '` first')
    return next({
      ...e,
      context: [
        ...(e.context ?? []),
        'Before anything else, the user asked you to run this shell command and use its output: `' + shell + '`'
      ]
    })
  }

  runThenSend($, picked.command, e.text)
  return {
    drop:
      'Running ' + picked.command + ' first; ' +
      (promptCheckingPartners().length > 0
        ? 'then your prompt goes back in the box for you to send.'
        : 'your prompt is sent right after it.')
  }
}

function statusText() {
  return (
    'Command Optimizer: ' +
    (enabled ? 'ON' : 'OFF') +
    ' · mode: `' + mode + '`' +
    ' · model: `' + model + '`' +
    ' · checks: ' + totalChecks +
    ' · memo hits: ' + memoHits +
    ' · prompt-cache reads: ' + promptCacheReads +
    (lastCacheReadTokens > 0 ? ' (' + lastCacheReadTokens + ' cached tokens last call)' : '') +
    (switchedOff ? '\nTurned off in the /mods switchboard.' : '') +
    (partners.length > 0 ? '\nWorking alongside: ' + partners.join(', ') + '.' : '') +
    '\nUsage: `/command-optimizer [ask | band | 1 | 2 | 3 | on | off]`'
  )
}

export function register(on, options) {
  resetState()
  const optModel = options && String(options.model || '').trim().toLowerCase()
  if (MODELS.includes(optModel)) model = optModel
  if (options && asMode(options.defaultMode)) mode = asMode(options.defaultMode)

  // 1. Session start: load saved settings, discover commands, register /command-optimizer
  on('session.start', async ($, e, next) => {
    await loadSavedConfig($)
    try {
      const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
      switchesPath = home
        ? home.split('\\').join('/').replace(/\/+$/, '') + '/.claude/mods/switches.json'
        : ''
      await readSwitch($)
    } catch {
      switchesPath = ''
    }
    try {
      const listed = await $.command.list()
      if (Array.isArray(listed)) {
        sessionCommands = listed.map((c) => ({ name: c.name || '', description: c.description || '' }))
        const names = new Set(listed.map((c) => normalizeName(c.name)))
        const owners = new Set(listed.map((c) => c.plugin).filter(Boolean))
        partners = Object.keys(PARTNERS).filter((p) => names.has(p) || owners.has(p))
        sessionCommands = sessionCommands.filter((c) => !ownedByPartner(normalizeName(c.name)))
        knownCommands = new Set([
          ...BUILTIN_COMMANDS.map((c) => c.name),
          ...sessionCommands.map((c) => normalizeName(c.name)).filter(Boolean)
        ])
      } else {
        sessionCommands = []
        partners = []
        knownCommands = new Set(BUILTIN_COMMANDS.map((c) => c.name))
      }
    } catch {
      sessionCommands = []
      partners = []
      knownCommands = new Set(BUILTIN_COMMANDS.map((c) => c.name))
    }
    try {
      await $.command.register({
        name: 'command-optimizer',
        description: 'Sonnet command suggestions after Enter. ask | band | 1-3 | on | off',
        argumentHint: '[ask|band|1|2|3|on|off]',
        immediate: true
      })
    } catch {
      // Already registered on hot-reload
    }
    return next(e)
  })

  // 2. Clear stale turn state after /clear, /resume, or a fork
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    checkSeq += 1
    recentPrompts = []
    suggestions = []
    checking = false
    dismissed = false
    skipOnce = ''
    setStatus($, undefined)
    await loadSavedConfig($)
    $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  // 3. /command-optimizer: mode switching, status, quick-pick 1-3
  on('command.run', { command: 'command-optimizer' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()

    if (arg === '1' || arg === '2' || arg === '3') {
      const chosen = suggestions[Number(arg) - 1]
      if (!chosen) return { text: 'No suggestion #' + arg + ' is active.' }
      await applyCommandChoice($, chosen.command)
      dismissed = true
      $.ui.invalidate('ui.render')
      return { text: 'Prepared `' + chosen.command + '`: ' + chosen.reason }
    }

    if (arg === 'off' || arg === 'disable') {
      checkSeq += 1
      enabled = false
      checking = false
      suggestions = []
      setStatus($, undefined)
      await $.store.set('enabled', false)
      $.ui.invalidate('ui.render')
      return { text: 'Command Optimizer is off. Run `/command-optimizer on` to turn it back on.' }
    }

    if (arg === 'on' || arg === 'enable') {
      enabled = true
      await $.store.set('enabled', true)
      $.ui.invalidate('ui.render')
      return { text: 'Command Optimizer is on (mode: `' + mode + '`).' }
    }

    if (asMode(arg)) {
      checkSeq += 1
      mode = asMode(arg)
      enabled = true
      checking = false
      suggestions = []
      setStatus($, undefined)
      await $.store.set('mode', mode)
      await $.store.set('enabled', true)
      $.ui.invalidate('ui.render')
      return {
        text:
          'Command Optimizer mode: `' + mode + '`. ' +
          (mode === 'ask'
            ? 'After you press Enter, Sonnet checks the prompt and offers to run a helpful command before Claude starts.'
            : 'Sonnet checks each prompt alongside the turn and shows suggestions above the prompt, never waiting.')
      }
    }

    await readSwitch($)
    return { text: statusText() }
  })

  // 4. After Enter: check the prompt
  on('prompt.submit', async ($, e, next) => {
    // The prompt this mod handed back after running a command: send it, unchecked this time
    if (skipOnce && (!e.origin || PERSON_ORIGINS.has(e.origin.kind)) && (e.text || '').trim() === skipOnce) {
      skipOnce = ''
      return next(e)
    }
    await readSwitch($)
    if (!shouldCheck(e)) return next(e)
    const promptText = e.text.trim()
    const recordPrompt = () => {
      recentPrompts = [...recentPrompts.slice(-(MAX_RECENT_PROMPTS - 1)), promptText.slice(0, 240)]
    }

    // band: check alongside the turn; the band fills when Sonnet answers.
    // Prompts with attachments can't be held and sent again, so they take this path too.
    if (mode === 'band' || (e.attachments && e.attachments.length > 0)) {
      const checkTask = evaluatePrompt($, promptText).catch(() => [])
      const runSeq = checkSeq
      recordPrompt()
      const turnResult = await next(e)
      const found = await checkTask
      if (mode !== 'band' && runSeq === checkSeq) {
        suggestions = found
        dismissed = false
        $.ui.invalidate('ui.render')
      }
      return turnResult
    }

    if (suggestions.length > 0) {
      suggestions = []
      $.ui.invalidate('ui.render')
    }

    // ask: Sonnet checks before Claude starts
    const current = await evaluatePrompt($, promptText)
    recordPrompt()
    if (current.length === 0) return next(e)
    return askBeforeSending($, e, next, current)
  }).catch(($, e, next) => {
    checking = false
    setStatus($, undefined)
    return next(e)
  })

  // 5. Annotate the spinner while a band-mode check runs
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!enabled || switchedOff || !checking) return next(e)
    return next({
      ...e,
      props: { ...e.props, suffix: ((e.props && e.props.suffix) || '') + ' · Sonnet checking commands…' }
    })
  })

  // 6. Band mode: suggestions above the prompt
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const downstream = await next(e)
    if (!enabled || switchedOff || dismissed || suggestions.length === 0 || (e.props && e.props.hasSurvey)) {
      return downstream
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const redraw = () => $.ui.invalidate('ui.render')

    // Each row is one plain Button (hotkey, command, dim reason), so rows line up and never overlap
    const rows = suggestions.map((item, idx) =>
      Button({
        key: 'cmd-opt-btn-' + idx,
        plain: true,
        hotkey: String(idx + 1),
        onPress: async (press) => {
          await applyCommandChoice($, item.command, press && press.surface)
          dismissed = true
          redraw()
        },
        children: [item.label, Text({ dimColor: true, children: ['  ' + item.reason] })]
      })
    )

    const panel = Box({
      key: 'command-optimizer-band',
      flexDirection: 'column',
      borderStyle: 'round',
      borderDimColor: true,
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          justifyContent: 'space-between',
          children: [
            Text({
              children: [
                Text({ bold: true, color: 'claude', children: ['⚡ Sonnet suggests'] }),
                Text({ dimColor: true, children: ['  press 1-' + suggestions.length + ' to fill'] })
              ]
            }),
            Button({
              key: 'cmd-opt-dismiss',
              label: '✕',
              plain: true,
              role: 'dismiss',
              onPress: () => {
                dismissed = true
                redraw()
              }
            })
          ]
        }),
        ...rows
      ]
    })

    return downstream ? Box({ flexDirection: 'column', children: [downstream, panel] }) : panel
  })
}
