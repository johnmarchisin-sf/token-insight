// Hour-of-day and day-of-week aggregations. Lets the user see when in the
// workday they typically burn through tokens fastest.

import { Session } from './types.js';

export interface HourBucket {
  hour: number; // 0-23 in local time
  totalTokens: number;
  turnCount: number;
}

export interface DayHourBucket {
  dayOfWeek: number; // 0=Sun..6=Sat
  hour: number;
  totalTokens: number;
  turnCount: number;
}

export function byHourOfDay(sessions: Session[]): HourBucket[] {
  const out: HourBucket[] = [];
  for (let h = 0; h < 24; h++) out.push({ hour: h, totalTokens: 0, turnCount: 0 });
  for (const s of sessions) {
    for (const t of s.turns) {
      const tokens =
        t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      if (tokens === 0) continue;
      const h = t.ts.getHours();
      out[h].totalTokens += tokens;
      out[h].turnCount += 1;
    }
  }
  return out;
}

export function byDayHour(sessions: Session[]): DayHourBucket[] {
  const map = new Map<string, DayHourBucket>();
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      map.set(`${d}-${h}`, { dayOfWeek: d, hour: h, totalTokens: 0, turnCount: 0 });
    }
  }
  for (const s of sessions) {
    for (const t of s.turns) {
      const tokens =
        t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;
      if (tokens === 0) continue;
      const d = t.ts.getDay();
      const h = t.ts.getHours();
      const b = map.get(`${d}-${h}`)!;
      b.totalTokens += tokens;
      b.turnCount += 1;
    }
  }
  return [...map.values()];
}
