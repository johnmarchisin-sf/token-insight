import path from 'node:path';
import os from 'node:os';
import { loadConfig, setProfile } from '../core/config.js';
import {
  PROFILE_NAMES,
  ProfileName,
  isValidProfileName,
  getActiveProfile,
} from '../core/profile.js';
import { bold, dim } from './format.js';

export interface ProfileOpts {
  json?: boolean;
}

export async function runProfileShow(opts: ProfileOpts): Promise<void> {
  const c = await loadConfig();
  const effective = getActiveProfile();
  const configFile = path.join(os.homedir(), '.token-insight.json');
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          active: c.profile,
          effective,
          customKnownBuckets: c.customKnownBuckets,
          customDeepRollupBuckets: c.customDeepRollupBuckets,
          configFile,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }
  console.log(bold(`Active profile: ${c.profile}`));
  console.log(dim(`Known buckets: ${effective.knownBuckets.join(', ') || '(none)'}`));
  const deep = Object.entries(effective.deepRollupBuckets)
    .map(([b, subs]) => `${b}/[${subs.join('|')}]/<project>`)
    .join(', ');
  console.log(dim(`Deep rollup:   ${deep || '(none)'}`));
  console.log(dim(`Rate-limit framing: ${effective.rateLimitFraming ? 'on' : 'off'}`));
  if (c.customKnownBuckets.length > 0 || Object.keys(c.customDeepRollupBuckets).length > 0) {
    console.log();
    console.log(bold('User overrides'));
    if (c.customKnownBuckets.length > 0) {
      console.log(dim(`  + known buckets: ${c.customKnownBuckets.join(', ')}`));
    }
    if (Object.keys(c.customDeepRollupBuckets).length > 0) {
      const extra = Object.entries(c.customDeepRollupBuckets)
        .map(([b, subs]) => `${b}/[${subs.join('|')}]`)
        .join(', ');
      console.log(dim(`  + deep rollup:   ${extra}`));
    }
  }
  console.log();
  console.log(dim(`Available profiles: ${PROFILE_NAMES.join(', ')}`));
  console.log(dim(`Switch with: ti profile set <name>`));
  console.log(dim(`Edit overrides directly: ${configFile}`));
}

export async function runProfileSet(name: string): Promise<void> {
  if (!isValidProfileName(name)) {
    console.error(`Unknown profile "${name}". Valid: ${PROFILE_NAMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await setProfile(name as ProfileName);
  console.log(`Profile set to "${name}".`);
}
