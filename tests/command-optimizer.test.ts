import { expect, mock, test } from 'claude-code/testing'

const ABOVE_PROMPT = {
  plugin: 'command-optimizer',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 36 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {}
  }
} as const

const REPLY = {
  suggestions: [
    { command: '/plan', kind: 'slash', label: '/plan', reason: 'Plan multi-file auth refactor before editing' },
    { command: '/made-up-command', kind: 'slash', label: '/made-up-command', reason: 'Not a real command' },
    { command: '/security-review', kind: 'slash', label: '/security-review', reason: 'Audit auth token validation changes' },
    { command: '!npm test', kind: 'cli', label: '!npm test', reason: 'Run existing auth unit tests' }
  ]
}

type Engine = {
  model: number
  asked: string[][]
  ran: string[]
  sent: string[]
  filled: string[]
  entered: { text: string; context?: readonly string[] }[]
}

// Stubs standing for the engine beneath the plugin. `answer` picks the dialog option.
function stubEngine(
  on: any,
  answer: (options: string[]) => string | undefined = () => undefined,
  extra: { commands?: any[]; reply?: object; switches?: object } = {}
) {
  const got: Engine = { model: 0, asked: [], ran: [], sent: [], filled: [], entered: [] }
  mock.store(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.list', () => ({
    value: [{ name: 'deploy', description: 'Deploy service to staging', source: 'plugin' }, ...(extra.commands ?? [])]
  }))
  on('env.get', ($: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\Users\me' : undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: Boolean(extra.switches) && String(e.path).endsWith('switches.json') }))
  on('fs.read', () => ({ value: JSON.stringify(extra.switches ?? {}) }))
  on('command.register', () => ({ value: { command: 'command-optimizer' } }))
  on('session.messages', () => ({ value: [] }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('prompt.fill', ($: any, e: any) => {
    got.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($: any, e: any) => {
    if (e.origin?.kind === 'plugin') got.sent.push(e.text)
    else got.entered.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  on('command.run', ($: any, e: any) => {
    got.ran.push('/' + e.command + (e.args ? ' ' + e.args : ''))
    return { text: 'ok' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => {
    const q = e.questions[0]
    const options = q.options.map((o: any) => o.label)
    got.asked.push(options)
    const picked = answer(options)
    if (picked === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [q.question]: picked } } }
  })
  on('model.complete', () => {
    got.model += 1
    return {
      value: {
        isAnswered: true,
        text: JSON.stringify(extra.reply ?? REPLY),
        usage: { input_tokens: 120, output_tokens: 65, cache_read_input_tokens: 1150, cache_creation_input_tokens: 0 }
      }
    }
  })
  return got
}

const composer = { kind: 'composer' } as const
const PROMPT = 'Refactor the JWT authentication middleware across all routes'

test('after Enter, Sonnet offers commands; picking one runs it, then sends the prompt', async ($, on) => {
  const clock = mock.clock(on)
  const got = stubEngine(on, (options) => options[0])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const r = await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.model).toBe(1)
  // the unknown command is dropped; 3 suggestions + "send as is"
  expect(got.asked[0]).toEqual([
    '/plan, then my prompt',
    '/security-review, then my prompt',
    'Run !npm test first',
    'Just send my prompt'
  ])
  expect((r as any).drop).toContain('/plan')
  expect(got.entered).toEqual([])

  await clock.advance(1)
  expect(got.ran).toEqual(['/plan'])
  expect(got.sent).toEqual([PROMPT])
})

test('"Just send my prompt" sends it unchanged', async ($, on) => {
  const got = stubEngine(on, (options) => options[options.length - 1])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.entered.map((p) => p.text)).toEqual([PROMPT])
  expect(got.ran).toEqual([])
})

test('a shell pick asks Claude to run it first', async ($, on) => {
  const got = stubEngine(on, (options) => options.find((o) => o.includes('!npm test')))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.entered).toHaveLength(1)
  expect(String(got.entered[0]!.context)).toContain('npm test')
})

test('a dismissed dialog sends the prompt', async ($, on) => {
  const got = stubEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.entered.map((p) => p.text)).toEqual([PROMPT])
})

test('skips slash commands, shell escapes, short replies and non-person prompts', async ($, on) => {
  const got = stubEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: '!git status', origin: composer } as any)
  await $.prompt.submit({ text: 'yes', origin: composer } as any)
  await $.prompt.submit({ text: 'continue.', origin: composer } as any)
  expect(got.model).toBe(0)
  await $.prompt.submit({ text: 'Add pagination to the users list endpoint', origin: composer } as any)
  expect(got.model).toBe(1)
})

test('turned off, it makes no model calls', async ($, on) => {
  const got = stubEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const reply = await $.command.run({ command: 'command-optimizer', args: 'off' })
  expect(reply.text).toContain('off')
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.model).toBe(0)
})

test('band mode draws the suggestions above the prompt', async ($, on) => {
  const got = stubEngine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'command-optimizer', args: 'band' })
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.asked).toEqual([])
  expect(got.entered.map((p) => p.text)).toEqual([PROMPT])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...ABOVE_PROMPT, surface })
    expect(await ui.find({ key: 'cmd-opt-btn-0' })).toBeDefined()
    expect(await ui.find({ key: 'cmd-opt-btn-2' })).toBeDefined()
    expect(await ui.find({ key: 'cmd-opt-btn-3' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...ABOVE_PROMPT, surface: 'terminal' })
  await ui.press({ key: 'cmd-opt-btn-2' })
  await ui.unmount()
  expect(got.filled).toEqual(['!npm test'])

  const status = await $.command.run({ command: 'command-optimizer', args: '' })
  expect(status.text).toContain('checks: 1')
  expect(status.text).toContain('prompt-cache reads: 1')
})

const EFFORT_MOD = [
  { name: 'effort', description: 'Set effort', source: 'builtin' },
  { name: 'effort-optimizer', description: 'Effort Optimizer', source: 'plugin', plugin: 'effort-optimizer' }
]

test('with Effort Optimizer: no /effort suggestions, and the prompt comes back for its check', async ($, on) => {
  const clock = mock.clock(on)
  const reply = {
    suggestions: [
      { command: '/effort high', label: '/effort high', reason: 'Tricky auth logic' },
      { command: '/plan', label: '/plan', reason: 'Plan the refactor first' }
    ]
  }
  const got = stubEngine(on, (options) => options[0], { commands: EFFORT_MOD, reply })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const r = await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.asked[0]).toEqual(['/plan, then my prompt', 'Just send my prompt'])
  expect((r as any).drop).toContain('back in the box')

  await clock.advance(1)
  expect(got.ran).toEqual(['/plan'])
  expect(got.sent).toEqual([])
  expect(got.filled).toEqual([PROMPT])

  // The person presses Enter on it: it goes through unchecked, as their own prompt
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.model).toBe(1)
  expect(got.entered.map((p) => p.text)).toEqual([PROMPT])

  const status = await $.command.run({ command: 'command-optimizer', args: '' })
  expect(status.text).toContain('Working alongside: effort-optimizer')
})

test('the /mods switchboard turns it off', async ($, on) => {
  const got = stubEngine(on, undefined, { switches: { 'command-optimizer': false } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.prompt.submit({ text: PROMPT, origin: composer } as any)
  expect(got.model).toBe(0)
  expect(got.entered.map((p) => p.text)).toEqual([PROMPT])
})
