import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.resolve(__dirname, '..', 'scripts', 'suggest-commands-hook.mjs');

function makeFakeClaudeDir(replyText, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-opt-test-'));
  const scriptPath = path.join(dir, 'fake-claude.mjs');
  const argsLogPath = path.join(dir, 'args.json');
  const stdinLogPath = path.join(dir, 'stdin.txt');
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
fs.writeFileSync(${JSON.stringify(argsLogPath)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(stdinLogPath)}, Buffer.concat(chunks).toString('utf8'));
if (${JSON.stringify(Boolean(opts.fail))}) process.exit(1);
process.stdout.write(${JSON.stringify(replyText)});
`
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
  } else {
    const shPath = path.join(dir, 'claude');
    fs.writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
    fs.chmodSync(shPath, 0o755);
  }
  return { dir, argsLogPath, stdinLogPath };
}

function runHook(inputObj, envOverrides = {}) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(inputObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      CMD_OPTIMIZER_INTERNAL: '',
      ...envOverrides
    }
  });
}

describe('scripts/suggest-commands-hook.mjs', () => {
  test('skips short, slash, bang, and trivial prompts', () => {
    for (const prompt of ['', 'ok', 'continue.', '/plan', '!npm test', 'short']) {
      const res = runHook({ prompt, session_id: 'skip-test' });
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
    }
  });

  test('handles partial state file, passes prompt via stdin to claude shim, and filters invalid items', () => {
    const sessionId = `hook-valid-${Date.now()}`;
    const stateFile = path.join(os.tmpdir(), `claude-cmd-optimizer-${sessionId}.json`);
    fs.writeFileSync(stateFile, JSON.stringify({}));

    const reply = JSON.stringify({
      suggestions: [
        { command: '', reason: 'empty' },
        { command: '/plan', reason: 'Design auth changes first' },
        { command: '!npm test' }
      ]
    });
    const fake = makeFakeClaudeDir(reply);
    try {
      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
      const prompt = 'Refactor "auth" & JWT %check% across\nmultiple routes';
      const res = runHook(
        { prompt, session_id: sessionId },
        { [pathKey]: fake.dir, CMD_OPTIMIZER_MODEL: 'haiku' }
      );
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(
        out.systemMessage,
        '⚡ Sonnet Command Suggestions: [1] /plan (Design auth changes first) · [2] !npm test'
      );
      const passedArgs = JSON.parse(fs.readFileSync(fake.argsLogPath, 'utf8'));
      assert.deepEqual(passedArgs, ['-p', '--model', 'haiku', '--max-turns', '1']);
      const stdinSeen = fs.readFileSync(fake.stdinLogPath, 'utf8');
      assert.ok(stdinSeen.includes(prompt));
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
      fs.rmSync(stateFile, { force: true });
    }
  });

  test('drops non-JSON model replies without emitting garbage systemMessage', () => {
    const sessionId = `hook-nonjson-${Date.now()}`;
    const stateFile = path.join(os.tmpdir(), `claude-cmd-optimizer-${sessionId}.json`);
    const fake = makeFakeClaudeDir('Sorry, I could not understand that.');
    try {
      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
      const res = runHook(
        { prompt: 'Refactor the JWT authentication middleware across all routes', session_id: sessionId },
        { [pathKey]: fake.dir }
      );
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');
    } finally {
      fs.rmSync(fake.dir, { recursive: true, force: true });
      fs.rmSync(stateFile, { force: true });
    }
  });
});
