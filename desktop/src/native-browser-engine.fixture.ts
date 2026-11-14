/**
 * The browser engine as the Electron smoke tests load it: its TypeScript
 * modules compiled to ES modules in a scratch folder, beside a link to the
 * desktop's own dependencies (the shell's i18n imports a package).
 */
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `roots` and every local module they import, followed from their own import lines: a list kept by hand goes stale. */
export async function engineModules(roots: readonly string[] = ['native-browser']): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const pending = [...roots];
  while (pending.length) {
    const name = pending.pop()!;
    if (sources.has(name)) continue;
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    sources.set(name, source);
    for (const match of source.matchAll(/from '\.\/([\w-]+)\.js'/g)) pending.push(match[1]!);
  }
  return sources;
}

/** Writes `roots` and their local imports into `dir` as `<name>.js`, and links the desktop's `node_modules` there. */
export async function stageEngine(dir: string, roots: readonly string[] = ['native-browser']): Promise<void> {
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'junction');
  for (const [name, source] of await engineModules(roots)) {
    await writeFile(join(dir, `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText);
  }
}
