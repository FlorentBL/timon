/**
 * Reads a workflow of .github/workflows/ for the static tests of
 * scripts/release/: a workflow cannot run before it reaches GitHub, so what it
 * may reach is checked on its text. No YAML parser at the repository root: the
 * file is read line by line, which the plain block style of these workflows
 * allows (two-space indent, one key per line).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A line without its comment: a comment may explain what the workflow does not do. */
export const uncomment = (line) => line.replace(/(^|\s)#.*$/, '');

/** An action reference pinned on a full sha, its version in a comment. */
export const PINNED_USES = /^\s*(?:- )?uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+){0,2})\s*$/;

export function readWorkflow(name) {
  const text = readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8');
  const lines = text.split('\n');
  const code = lines.map(uncomment).join('\n');

  /** The jobs, by name, each with its own lines, comments removed (two-space indented keys under `jobs:`). */
  function jobs() {
    const start = lines.indexOf('jobs:');
    assert.ok(start > 0, `${name}: no jobs: block`);
    const found = new Map();
    let current = null;
    for (const line of lines.slice(start + 1)) {
      const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (m) { current = m[1]; found.set(current, []); continue; }
      if (current && (line.startsWith('    ') || !line.trim() || /^\s*#/.test(line))) found.get(current).push(uncomment(line));
      else if (current && /^\S/.test(line)) current = null;
    }
    return found;
  }

  const job = (jobName) => {
    const body = jobs().get(jobName);
    assert.ok(body, `${name}: no job ${jobName}`);
    return body;
  };

  /** The value of a four-space key of a job (`if`, `needs`, `uses`, `environment`…), or undefined. */
  const keyOf = (jobName, key) => job(jobName).map((line) => new RegExp(`^ {4}${key}:\\s*(.*?)\\s*$`).exec(line)?.[1]).find((value) => value !== undefined);

  /** The lines of a four-space block of a job (`with`, `secrets`, `permissions`…), without the key itself. */
  function blockOf(jobName, key) {
    const body = job(jobName);
    const start = body.findIndex((line) => new RegExp(`^ {4}${key}:\\s*$`).test(line));
    if (start < 0) return null;
    const found = [];
    for (const line of body.slice(start + 1)) {
      if (/^ {4}\S/.test(line)) break;
      if (line.trim()) found.push(line);
    }
    return found;
  }

  /** The steps of a job, each as its lines (a `      - ` item and what it holds). */
  function steps(jobName) {
    const found = [];
    let inSteps = false;
    for (const line of job(jobName)) {
      if (/^ {4}steps:\s*$/.test(line)) { inSteps = true; continue; }
      if (!inSteps) continue;
      if (/^ {4}\S/.test(line)) { inSteps = false; continue; }
      if (/^ {6}- /.test(line)) found.push([line]);
      else if (found.length) found.at(-1).push(line);
    }
    return found;
  }

  const stepNamed = (jobName, stepName) => {
    const found = steps(jobName).find((step) => step.some((line) => line.includes(`name: ${stepName}`)));
    assert.ok(found, `${name}: no step "${stepName}" in ${jobName}`);
    return found.join('\n');
  };

  /** The text of each `run:` block, single line or literal block. */
  function runBlocks() {
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      if (m[2] !== '|' && m[2] !== '>') { blocks.push(m[2]); continue; }
      const indent = m[1].length;
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
        body.push(lines[j]);
      }
      blocks.push(body.join('\n'));
    }
    return blocks;
  }

  /** The `on:` block, and the names of its triggers. */
  function triggers() {
    const on = /^on:\n((?: {2}.*\n|\s*\n)+)/m.exec(text);
    assert.ok(on, `${name}: no on: block`);
    return { block: on[1], names: on[1].split('\n').map((line) => /^ {2}([a-z_]+):/.exec(line)?.[1]).filter(Boolean) };
  }

  /** Every `uses:` of an action, as a map action -> sha; throws on one not pinned or pinned twice differently. */
  function pins() {
    const found = new Map();
    for (const line of lines.filter((l) => /^\s*(?:- )?uses:/.test(l) && !/uses:\s*\.\//.test(l))) {
      const m = PINNED_USES.exec(line);
      assert.ok(m, `${name}: not pinned on a sha with its version: ${line.trim()}`);
      const [, action, sha] = m;
      if (found.has(action)) assert.equal(found.get(action), sha, `${name}: ${action} is pinned twice differently`);
      found.set(action, sha);
    }
    return found;
  }

  /** Line numbers (0-based) of every checkout whose block does not say persist-credentials: false. */
  function checkoutsKeepingCredentials() {
    const keeping = [];
    lines.forEach((line, i) => {
      if (!/uses:\s*actions\/checkout@/.test(line)) return;
      const block = [];
      for (let j = i + 1; j < lines.length && !/^\s*- /.test(lines[j]) && lines[j].trim(); j++) block.push(lines[j]);
      if (!block.some((l) => /persist-credentials:\s*false/.test(l))) keeping.push(i);
    });
    return keeping;
  }

  return { name, text, lines, code, jobs, job, keyOf, blockOf, steps, stepNamed, runBlocks, triggers, pins, checkoutsKeepingCredentials };
}
