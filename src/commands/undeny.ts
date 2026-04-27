import { loadConfig, removeDenylistEntry } from '../core/config.js';
import { bold, dim } from './format.js';

export async function runUndeny(idOrPrefix: string): Promise<void> {
  const cfg = await loadConfig();
  const matches = cfg.clusterDenylist.filter(
    (e) => e.id === idOrPrefix || e.id.startsWith(idOrPrefix)
  );
  if (matches.length === 0) {
    console.error(`No denylist entry matches "${idOrPrefix}".`);
    console.error(dim('Run `ti recommend --show-hidden` to see ids.'));
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${idOrPrefix}" — matches ${matches.length} entries:`);
    for (const m of matches) {
      console.error(`  ${m.id}  [${m.reason}]  ${m.repExcerpt.slice(0, 80)}`);
    }
    process.exit(1);
  }
  const target = matches[0];
  const removed = await removeDenylistEntry(target.id);
  if (removed) {
    console.log(bold(`Removed: ${target.id}  [${target.reason}]`));
    console.log(dim(`         ${target.repExcerpt.slice(0, 100)}`));
  } else {
    console.error('Entry no longer present (race?). Nothing to do.');
  }
}
