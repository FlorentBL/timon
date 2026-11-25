/**
 * A `/id` sent at the head of a message is inlined by the DAEMON, which reads
 * `~/.claude` (skills, commands, plugins) — not by the mission's CLI, which
 * runs with its own `CLAUDE_CONFIG_DIR` and never sees them. So the composer's
 * slash popup is right to offer `claude-user` and `plugin` skills without a
 * "not in missions" badge: picking one does load it (TODO #619). Only
 * attaching one to an agent needs an import into Timon.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const claudeHome = mkdtempSync(join(process.env.TIMON_HOME as string, 'claude-home-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

writeSkill(join(claudeHome, 'skills'), 'geo-audit', 'GEO-AUDIT-PROCEDURE');
mkdirSync(join(claudeHome, 'commands'), { recursive: true });
writeFileSync(join(claudeHome, 'commands', 'ship.md'), 'SHIP-COMMAND for $ARGUMENTS\n');
const pluginRoot = join(claudeHome, 'plugins', 'cache', 'seo');
writeSkill(join(pluginRoot, 'skills'), 'rank', 'RANK-PROCEDURE');

// A plugin that files its skills by category and names them in its manifest
// (TIM-0168), plus paths the manifest must not reach out through.
const catRoot = join(claudeHome, 'plugins', 'cache', 'mattpocock-skills');
const outside = join(claudeHome, 'plugins', 'cache', 'outside');
writeSkill(join(catRoot, 'skills', 'engineering'), 'handoff', 'HANDOFF-PROCEDURE');
writeSkill(join(catRoot, 'skills', 'engineering'), 'review', 'ENGINEERING-REVIEW');
writeSkill(join(catRoot, 'skills', 'writing'), 'review', 'WRITING-REVIEW');
writeSkill(join(catRoot, 'skills', 'writing'), 'edit', 'EDIT-PROCEDURE');
writeSkill(outside, 'escape', 'ESCAPED');
let linked = false;
try {
  symlinkSync(join(outside, 'escape'), join(catRoot, 'linked'), 'dir');
  linked = true;
} catch { /* no symlink right (Windows without developer mode) */ }
mkdirSync(join(catRoot, '.claude-plugin'), { recursive: true });
writeFileSync(join(catRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
  name: 'mattpocock-skills',
  skills: [
    './skills/writing',
    './skills/engineering/handoff',
    './skills/engineering/review',
    '../outside/escape',
    join(outside, 'escape'),
    './linked',
  ],
}));
writeSkill(join(pluginRoot, 'skills'), 'edit', 'SEO-EDIT');

writeFileSync(join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: {
    'seo@market': [{ installPath: pluginRoot }],
    'mattpocock-skills@market': [{ installPath: catRoot }],
  },
}));

const { listAllSkills, pluginManifestSkillDirs } = await import('./skill-registry.js');
const { expandSlashCommand } = await import('./slash.js');

test('the popup lists them under their own source', () => {
  const sources = new Map(listAllSkills().map((e) => [e.id, e.source]));
  assert.equal(sources.get('geo-audit'), 'claude-user');
  assert.equal(sources.get('ship'), 'claude-user');
  assert.equal(sources.get('seo:rank'), 'plugin');
});

test('a ~/.claude skill picked at the head of the message is inlined', async () => {
  const { expanded, skill } = await expandSlashCommand('/geo-audit example.com');
  assert.equal(skill, 'geo-audit');
  assert.match(expanded, /GEO-AUDIT-PROCEDURE/);
  assert.match(expanded, /example\.com/);
});

test('a ~/.claude command is expanded with its arguments', async () => {
  const { expanded, skill } = await expandSlashCommand('/ship v2');
  assert.equal(skill, 'ship');
  assert.match(expanded, /SHIP-COMMAND for v2/);
});

test('a plugin skill, namespaced, is inlined too', async () => {
  const { expanded, skill } = await expandSlashCommand('/seo:rank the homepage');
  assert.equal(skill, 'seo:rank');
  assert.match(expanded, /RANK-PROCEDURE/);
});

test('mid-sentence, no source is expanded: the popup only types the id', async () => {
  const { expanded, skill } = await expandSlashCommand('please run /geo-audit');
  assert.equal(skill, null);
  assert.equal(expanded, 'please run /geo-audit');
});

test('a plugin manifest lists skills filed by category', () => {
  const ids = listAllSkills().filter((e) => e.source === 'plugin').map((e) => e.id);
  assert.ok(ids.includes('mattpocock-skills:handoff'));
  assert.ok(ids.includes('mattpocock-skills:review'));
  assert.ok(ids.includes('mattpocock-skills:edit'));
});

test('a manifest path out of the plugin root is refused', () => {
  const dirs = pluginManifestSkillDirs(catRoot);
  assert.equal(dirs.length, 3);
  assert.ok(dirs.every((d) => d.startsWith(catRoot + sep)));
  assert.ok(!listAllSkills().some((e) => e.id.endsWith(':escape')));
  if (linked) assert.ok(!dirs.some((d) => d.endsWith(`${sep}linked`)));
});

test('one skill name in two categories: the smaller path wins, the other is shadowed', async () => {
  const reviews = listAllSkills().filter((e) => e.id === 'mattpocock-skills:review');
  assert.equal(reviews.length, 2);
  const winner = reviews.find((e) => !e.shadowed);
  assert.ok(winner);
  assert.ok(winner.path.includes(`${sep}engineering${sep}`));
  const { expanded } = await expandSlashCommand('/mattpocock-skills:review now');
  assert.match(expanded, /ENGINEERING-REVIEW/);
});

test('a categorised plugin skill is inlined by its full id', async () => {
  const { expanded, skill } = await expandSlashCommand('/mattpocock-skills:handoff to Sam');
  assert.equal(skill, 'mattpocock-skills:handoff');
  assert.match(expanded, /HANDOFF-PROCEDURE/);
});
