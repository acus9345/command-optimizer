#!/usr/bin/env node
// Standalone UserPromptSubmit Command Hook for Claude Code
// Evaluates every submitted prompt with Claude Sonnet (using Anthropic ephemeral prompt caching
// and per-session history tracking) and returns 1-3 command suggestions via systemMessage.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const input = readStdinJson();
const userPrompt = (input.prompt || '').trim();
const sessionId = String(input.session_id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');

// Skip empty prompts, slash commands, direct shell escapes, or internal recursive invocations
if (
  !userPrompt ||
  userPrompt.startsWith('/') ||
  userPrompt.startsWith('!') ||
  userPrompt.length < 12 ||
  /^(y|yes|no|n|ok|okay|sure|thanks|thank you|continue|go on|go ahead|do it|proceed|next|lgtm|done)[.!]*$/i.test(userPrompt) ||
  process.env.CMD_OPTIMIZER_INTERNAL === '1'
) {
  process.exit(0);
}

// Load lightweight session state (recent prompts + deduplication cache) from os.tmpdir()
const stateFile = path.join(os.tmpdir(), `claude-cmd-optimizer-${sessionId}.json`);
let state = { recentPrompts: [], cache: {} };
try {
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }
} catch {
  state = { recentPrompts: [], cache: {} };
}

const promptHash = crypto
  .createHash('sha1')
  .update(JSON.stringify({ recent: state.recentPrompts.slice(-2), prompt: userPrompt }))
  .digest('hex');

if (state.cache && state.cache[promptHash]) {
  process.stdout.write(JSON.stringify(state.cache[promptHash]) + '\n');
  process.exit(0);
}

const SYSTEM_PROMPT = `You are the Claude Code Command Optimizer.
For every prompt the user sends in this session, recommend 1 to 3 relevant Claude Code slash commands or !<cli> shell escapes:
- /plan (complex multi-file features or refactors)
- /effort low | /effort medium | /effort high (match effort to task complexity)
- /diff (inspect file changes before committing)
- /review or /security-review (audit code quality or security-sensitive logic)
- /compact or /context or /clear (manage context window)
- /rewind (recover from broken approach), /btw (side question), /init or /memory (save CLAUDE.md rules)
- !<cli> (e.g. !git status, !npm test, !pytest) when a quick shell command helps.

Return STRICT JSON only:
{"suggestions":[{"command":"/plan","reason":"Design multi-file changes first"}]}`;

const recentContext =
  Array.isArray(state.recentPrompts) && state.recentPrompts.length > 0
    ? `Recent session prompts:\n${state.recentPrompts.slice(-2).map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n`
    : '';
const userMessage = `${recentContext}Current prompt: ${userPrompt}`;

let rawReply = '';

// Path A: Direct Anthropic Messages API with ephemeral prompt caching
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.CMD_OPTIMIZER_MODEL || 'claude-sonnet-5-5',
        max_tokens: 220,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' }
          }
        ],
        messages: [{ role: 'user', content: userMessage }]
      }),
      signal: AbortSignal.timeout(9000)
    });
    if (res.ok) {
      const data = await res.json();
      rawReply = (data.content?.[0]?.text || '').trim();
    }
  } catch {
    // Fall back to headless claude CLI below
  }
}

// Path B: Fallback to `claude -p --model sonnet` CLI
if (!rawReply) {
  const proc = spawnSync(
    'claude',
    ['-p', '--model', 'sonnet', '--max-turns', '1', `${SYSTEM_PROMPT}\n\n${userMessage}`],
    {
      encoding: 'utf8',
      timeout: 14000,
      env: { ...process.env, CMD_OPTIMIZER_INTERNAL: '1' }
    }
  );
  if (proc.status === 0 && proc.stdout) {
    rawReply = proc.stdout.trim();
  }
}

if (!rawReply) {
  process.exit(0);
}

let formattedLine = '';
try {
  const sIdx = rawReply.indexOf('{');
  const eIdx = rawReply.lastIndexOf('}');
  const parsed = JSON.parse(sIdx !== -1 && eIdx > sIdx ? rawReply.slice(sIdx, eIdx + 1) : rawReply);
  if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
    formattedLine =
      '⚡ Sonnet Command Suggestions: ' +
      parsed.suggestions
        .slice(0, 3)
        .map((s, i) => `[${i + 1}] ${s.command} (${s.reason})`)
        .join(' · ');
  }
} catch {
  formattedLine = rawReply.split('\n')[0].slice(0, 240);
}

if (!formattedLine) {
  process.exit(0);
}

const output = {
  systemMessage: formattedLine,
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: `Session command recommendations for this turn: ${formattedLine}`
  }
};

// Persist updated session trajectory & cache
try {
  state.recentPrompts = [...(state.recentPrompts || []).slice(-2), userPrompt.slice(0, 200)];
  state.cache = state.cache || {};
  state.cache[promptHash] = output;
  // Keep only the 50 newest cached results
  const keys = Object.keys(state.cache);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete state.cache[k];
  fs.writeFileSync(stateFile, JSON.stringify(state));
} catch {
  // Ignore temp file write errors
}

process.stdout.write(JSON.stringify(output) + '\n');
