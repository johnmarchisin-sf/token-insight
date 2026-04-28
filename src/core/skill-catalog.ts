// Discovers SKILL.md files installed on the user's machine and parses just
// enough YAML frontmatter to pull `name:` and `description:`. Used by the
// recommendations engine to detect when a recurring prompt cluster matches a
// skill the user already has installed.
//
// Three roots are walked, in this order:
//   1. ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md
//   2. ~/.claude/skills/<skill>/SKILL.md
//   3. <workspacePath>/.claude/skills/<skill>/SKILL.md (per workspace)
//
// `temp_git_*` plugin cache directories are skipped — they are transient
// install-time checkouts, not real installed skills.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalize, trigramsOf } from './prompt-clusterer.js';

export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: 'plugin' | 'global' | 'workspace';
  /** Display label, e.g. "superpowers:brainstorming", "user:session-wrap", "ws:token-insight/foo" */
  label: string;
  skillPath: string;
  /** Trigrams covering both the skill name (broken on dashes) and description, so a
   *  cluster prompt that mentions the skill name can match even if the description
   *  doesn't share vocabulary. */
  referenceTrigrams: string[];
}

export async function loadSkillCatalog(workspacePaths: string[]): Promise<SkillCatalogEntry[]> {
  const out: SkillCatalogEntry[] = [];
  const home = os.homedir();
  await collectPlugins(path.join(home, '.claude', 'plugins', 'cache'), out);
  await collectGlobal(path.join(home, '.claude', 'skills'), out);
  for (const ws of workspacePaths) {
    await collectWorkspace(ws, out);
  }
  return out;
}

async function safeReaddir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: { name: string; isDir: boolean }[] = [];
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      out.push({ name: e.name, isDir: e.isDirectory() });
    }
    return out;
  } catch {
    return [];
  }
}

/** ~/.claude/plugins/cache/<owner>/<plugin>/<version>/skills/<skill>/SKILL.md */
async function collectPlugins(root: string, out: SkillCatalogEntry[]): Promise<void> {
  for (const owner of await safeReaddir(root)) {
    if (!owner.isDir) continue;
    if (owner.name.startsWith('temp_git_')) continue;
    const ownerDir = path.join(root, owner.name);
    for (const plugin of await safeReaddir(ownerDir)) {
      if (!plugin.isDir) continue;
      const pluginDir = path.join(ownerDir, plugin.name);
      for (const version of await safeReaddir(pluginDir)) {
        if (!version.isDir) continue;
        const skillsDir = path.join(pluginDir, version.name, 'skills');
        for (const skill of await safeReaddir(skillsDir)) {
          if (!skill.isDir) continue;
          const skillFile = path.join(skillsDir, skill.name, 'SKILL.md');
          await pushIfValid(skillFile, 'plugin', `${plugin.name}:${skill.name}`, out);
        }
      }
    }
  }
}

/** ~/.claude/skills/<skill>/SKILL.md */
async function collectGlobal(root: string, out: SkillCatalogEntry[]): Promise<void> {
  for (const skill of await safeReaddir(root)) {
    if (!skill.isDir) continue;
    const skillFile = path.join(root, skill.name, 'SKILL.md');
    await pushIfValid(skillFile, 'global', `user:${skill.name}`, out);
  }
}

/** <workspacePath>/.claude/skills/<skill>/SKILL.md */
async function collectWorkspace(workspacePath: string, out: SkillCatalogEntry[]): Promise<void> {
  const skillsRoot = path.join(workspacePath, '.claude', 'skills');
  const wsName = path.basename(workspacePath) || workspacePath;
  for (const skill of await safeReaddir(skillsRoot)) {
    if (!skill.isDir) continue;
    const skillFile = path.join(skillsRoot, skill.name, 'SKILL.md');
    await pushIfValid(skillFile, 'workspace', `ws:${wsName}/${skill.name}`, out);
  }
}

async function pushIfValid(
  skillFile: string,
  source: SkillCatalogEntry['source'],
  label: string,
  out: SkillCatalogEntry[]
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(skillFile, 'utf8');
  } catch {
    return;
  }
  const fm = parseFrontmatter(raw);
  if (!fm.name || !fm.description) return;
  // Treat the skill name as additional trigram source. Names like
  // "finishing-a-development-branch" are split on dashes/underscores/colons so
  // each token feeds the trigram set on its own ("finishing", "development",
  // "branch") rather than being absorbed as one fused term.
  const nameTokens = fm.name.replace(/[-_:]+/g, ' ');
  const normalized = normalize(`${nameTokens} ${fm.description}`);
  const trigrams = [...trigramsOf(normalized)];
  if (trigrams.length === 0) return;
  out.push({
    name: fm.name,
    description: fm.description,
    source,
    label,
    skillPath: skillFile,
    referenceTrigrams: trigrams,
  });
}

/**
 * Minimal YAML frontmatter reader. Recognizes a leading `---` line and the
 * matching closing `---` line. Pulls single-line `name:` and `description:`
 * scalars (unquoted, single-quoted, or double-quoted). Anything fancier
 * (block scalars, nested keys) returns empty for the affected field.
 */
export function parseFrontmatter(raw: string): { name: string; description: string } {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { name: '', description: '' };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { name: '', description: '' };
  let name = '';
  let description = '';
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') name = value;
    else if (key === 'description') description = value;
  }
  return { name, description };
}
