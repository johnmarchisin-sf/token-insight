import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDecayingSections } from './context-inspector.js';

const FILE = '/tmp/CLAUDE.md';

test('matches H2 "Recent Changes" heading', () => {
  const md = [
    '# Project',
    '',
    '## Recent Changes',
    '- did a thing',
    '- did another',
    '',
    '## Setup',
    'unrelated',
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Recent Changes');
  assert.equal(sections[0].startLine, 3);
  assert.equal(sections[0].endLine, 6);
  assert.equal(sections[0].lineCount, 4);
});

test('matches multiple decaying headings of varied levels', () => {
  const md = [
    '# Title',
    '## Next Steps',
    'a',
    '### Future Work',
    'b',
    '## Setup',
    'c',
    '## Known Issues',
    'd',
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  const headings = sections.map((s) => s.heading);
  assert.deepEqual(headings.sort(), ['Future Work', 'Known Issues', 'Next Steps']);
});

test('excludes H1 even when text matches', () => {
  const md = '# Recent Changes\nbody';
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 0);
});

test('does not match headings whose decay-word is not at the start', () => {
  const md = '## My Recent Changes\nbody\n## Recently Used\nbody';
  const sections = extractDecayingSections(md, FILE);
  // "My Recent Changes" — no match (decay word not at start)
  // "Recently Used" — `recent\s+\w+` requires the form "recent <word>"
  //   so "Recently" alone does not match. Both filtered out.
  assert.equal(sections.length, 0);
});

test('section runs to EOF when no following heading', () => {
  const md = '# Title\n## TODO\n- a\n- b\n- c';
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].endLine, 5);
  assert.equal(sections[0].lineCount, 4);
});

test('section bounded by same-or-higher level heading, not deeper', () => {
  const md = [
    '# Title',
    '## Next Steps',          // line 2
    'body of next steps',     // line 3
    '### Sub of Next Steps',  // line 4 — deeper, should NOT close section
    'still inside',           // line 5
    '## Other',               // line 6 — same level, closes
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].startLine, 2);
  assert.equal(sections[0].endLine, 5);
});

test('estimatedTokens scales with byte count', () => {
  const longBody = 'word '.repeat(200); // ~1000 bytes
  const md = `# Title\n## Status\n${longBody}`;
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.ok(sections[0].estimatedTokens > 200, 'expected >200 tok for ~1k-byte section');
});

test('returns empty for content with no matching headings', () => {
  const md = '# Title\n## Setup\nfoo\n## Architecture\nbar';
  assert.deepEqual(extractDecayingSections(md, FILE), []);
});

test('section bounded by shallower heading', () => {
  const md = [
    '## Preamble',
    '### Status',          // line 2 — matched, deeper level
    'body',                // line 3
    '## Other',            // line 4 — shallower than ###, closes the section
  ].join('\n');
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Status');
  assert.equal(sections[0].startLine, 2);
  assert.equal(sections[0].endLine, 3);
});

test('matches "Last updated: DATE" heading', () => {
  const md = '# Title\n## Last updated: 2026-05-04\n- some content';
  const sections = extractDecayingSections(md, FILE);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, 'Last updated: 2026-05-04');
});
