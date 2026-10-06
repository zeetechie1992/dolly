// Self-test for the pure parts of editor/captions.js and editor/summary.js.
// Run: /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/captions-selftest.js

/* global print */
const log = typeof print === 'function' ? print : (...a) => globalThis.console.log(...a);
const warnings = [];
if (!globalThis.console) globalThis.console = { log, warn: (...a) => warnings.push(a.join(' ')), error: log };

// jsc has setTimeout but no clearTimeout; long timers (request timeouts) are never needed here,
// so skip scheduling them instead of keeping the shell alive.
if (typeof globalThis.clearTimeout === 'undefined') {
  const nativeSetTimeout = globalThis.setTimeout;
  const cancelled = new Set();
  let nextId = 1;
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextId++;
    if (ms <= 1000) nativeSetTimeout(() => { if (!cancelled.delete(id)) fn(); }, ms);
    return id;
  };
  globalThis.clearTimeout = (id) => { if (id) cancelled.add(id); };
}

// Minimal AbortController for shells that lack one (jsc).
if (typeof globalThis.AbortController === 'undefined') {
  class Signal {
    constructor() { this.aborted = false; this.reason = undefined; this._fns = []; }
    addEventListener(type, fn) { this._fns.push(fn); }
    removeEventListener(type, fn) { this._fns = this._fns.filter((f) => f !== fn); }
  }
  globalThis.AbortController = class {
    constructor() { this.signal = new Signal(); }
    abort(reason) {
      if (this.signal.aborted) return;
      const err = new Error('Aborted');
      err.name = 'AbortError';
      this.signal.aborted = true;
      this.signal.reason = reason ?? err;
      this.signal._fns.slice().forEach((fn) => fn());
    }
  };
}

const { CAPTION_STYLES, buildCaptionChunks, activeChunkAt, toSRT, toVTT } = await import('../public/js/editor/captions.js');
const { CAPTION_STYLE_IDS } = await import('../public/js/lib/project.js');

let failures = 0, passes = 0;
function ok(cond, msg) {
  if (cond) passes++;
  else { failures++; log(`FAIL  ${msg}`); }
}
const eq = (a, b, msg) => ok(a === b, `${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ---------------- captions ---------------- */

eq(CAPTION_STYLES.map((s) => s.id).join(','), CAPTION_STYLE_IDS.join(','), 'style ids mirror CAPTION_STYLE_IDS');
eq(CAPTION_STYLES[0].name, 'Minimal', 'minimal first');
ok(CAPTION_STYLES.every((s) => s.name && s.description), 'every style has a name and description');

const transcript = [
  { id: 's1', start: 0.5, end: 6.2, text: 'Hey team, in this video I want to walk you through the new analytics dashboard.' },
  { id: 's2', start: 6.8, end: 13.0, text: 'The dashboard shows weekly active users, revenue and churn in one place.' },
  { id: 'blank', start: 13.1, end: 13.4, text: '   ' },
  { id: 's3', start: 13.5, end: 21.0, text: 'you can filter the dashboard by date range and by customer segment using the filters at the top' },
  { id: 's4', start: 21.5, end: 30.0, text: 'so if you pick enterprise customers the revenue chart updates instantly' },
  { id: 's5', start: 31.0, end: 40.0, text: "Next, let's look at the export button. Exporting creates a CSV file with every metric." },
  { id: 's6', start: 41.0, end: 52.0, text: 'We need to fix the timezone bug in the CSV export before Friday.' },
  { id: 's7', start: 53.0, end: 61.0, text: 'Also, make sure the revenue numbers match the finance report.' },
  { id: 's8', start: 62.0, end: 70.0, text: 'Sarah will update the onboarding docs with screenshots of the new dashboard.' },
  { id: 's9', start: 71.0, end: 78.0, text: "That's it for now, thanks for watching!" },
];

const chunks = buildCaptionChunks(transcript);
ok(chunks.length > transcript.length, `segments split into short chunks (${chunks.length})`);
ok(!chunks.some((c) => c.segmentId === 'blank'), 'blank segments skipped');
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  ok(c.words.length <= 7, `chunk ≤ 7 words: "${c.text}"`);
  ok(c.text.length <= 42 || c.words.length === 1, `chunk ≤ 42 chars: "${c.text}"`);
  ok(c.end > c.start, `chunk has positive duration: "${c.text}"`);
  ok(c.text === c.words.map((w) => w.text).join(' '), 'chunk text matches its words');
  ok(Math.abs(c.words[0].start - c.start) < 1e-9 && Math.abs(c.words[c.words.length - 1].end - c.end) < 1e-9, 'word times span the chunk');
  for (let w = 1; w < c.words.length; w++) ok(c.words[w].start >= c.words[w - 1].end - 1e-9, 'word times are monotonic');
  if (i > 0) ok(c.start >= chunks[i - 1].end - 1e-9, `chunks never overlap (${i})`);
}
const s1 = chunks.filter((c) => c.segmentId === 's1');
eq(s1[0].start, 0.5, 'first chunk starts at segment start');
ok(Math.abs(s1[s1.length - 1].end - 6.2) < 1e-9, 'last chunk of a segment ends at segment end');
ok(s1[0].text.endsWith(','), `prefers a break at punctuation: "${s1[0].text}"`);
// Longer words get proportionally more time.
const w0 = s1[0].words;
const dur = (w) => w.end - w.start;
ok(dur(w0.find((w) => w.text === 'team,')) > dur(w0.find((w) => w.text === 'Hey')), 'time distributed by character length');

const sentenceChunks = buildCaptionChunks([{ start: 0, end: 5, text: 'Hello everyone. Today I want to show you our new dashboard and how it works.' }]);
ok(sentenceChunks.some((c) => c.text.endsWith('everyone.')), `breaks at sentence ends: ${JSON.stringify(sentenceChunks.map((c) => c.text))}`);

const weird = buildCaptionChunks([
  { start: 3, end: 7, text: 'second overlapping segment' },
  { start: 0, end: 5, text: 'first   segment\nwith newline' },
  { start: 9, text: 'no end time here' },
  { start: 12, end: 12, text: 'zero length' },
  { start: NaN, end: 3, text: 'bad start' },
  null,
]);
ok(weird.length === 4, `odd segments handled (${weird.length})`);
eq(weird[0].text, 'first segment with newline', 'whitespace normalized, sorted by start');
for (let i = 1; i < weird.length; i++) ok(weird[i].start >= weird[i - 1].end - 1e-9, 'overlapping input → non-overlapping chunks');
ok(weird[2].end > weird[2].start + 0.5, 'missing end gets a readable duration');
ok(weird[3].end > 12, 'zero-length segment gets a duration');
eq(buildCaptionChunks([]).length, 0, 'empty transcript');
eq(buildCaptionChunks(null).length, 0, 'null transcript');
const custom = buildCaptionChunks([{ start: 0, end: 4, text: 'one two three four five six seven eight nine ten' }], { maxWords: 3, maxChars: 80 });
ok(custom.every((c) => c.words.length <= 3), 'maxWords respected');

// activeChunkAt
eq(activeChunkAt(chunks, 0.2), null, 'nothing before the first chunk');
eq(activeChunkAt(chunks, chunks[0].start), chunks[0], 'chunk active at its start');
eq(activeChunkAt(chunks, chunks[1].start), chunks[1], 'boundary belongs to the next chunk');
eq(activeChunkAt(chunks, (chunks[2].start + chunks[2].end) / 2), chunks[2], 'chunk active mid-way');
eq(activeChunkAt(chunks, 1000), null, 'nothing after the last chunk');
eq(activeChunkAt([], 1), null, 'empty list');
eq(activeChunkAt(chunks, NaN), null, 'NaN time');

// SRT / VTT
const simple = [
  { start: 1, end: 3.5, text: 'Hello <world> & you' },
  { start: 3725.5, end: 3727.25, text: 'An hour --> later' },
  { start: 4, end: 4, text: 'zero' },
  { start: 5, end: 6, text: '  ' },
];
eq(toSRT(simple), '1\n00:00:01,000 --> 00:00:03,500\nHello <world> & you\n\n2\n01:02:05,500 --> 01:02:07,250\nAn hour → later\n', 'SRT format');
eq(toVTT(simple), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello &lt;world&gt; &amp; you\n\n01:02:05.500 --> 01:02:07.250\nAn hour --&gt; later\n', 'VTT format');
eq(toSRT([]), '', 'empty SRT');
eq(toVTT([]), 'WEBVTT\n', 'empty VTT');
eq(toSRT([{ start: 1, end: 2, text: 'a' }, { start: 1.5, end: 3, text: 'b' }]).split('\n')[5], '00:00:02,000 --> 00:00:03,000', 'SRT cues never overlap');
eq(toSRT(simple, { trim: { start: 2, end: 3 } }), '1\n00:00:00,000 --> 00:00:01,000\nHello <world> & you\n', 'SRT re-timed to a trim');
const srtAll = toSRT(chunks);
ok(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/.test(srtAll), 'SRT from built chunks');
eq(srtAll.split('\n\n').filter(Boolean).length, chunks.length, 'one SRT cue per chunk');

/* ---------------- summary ---------------- */

const { transcriptHash, localSummary, generateSummary, summaryToMarkdown } = await import('../public/js/editor/summary.js');

const project = { id: 'p_test', title: 'Recording – Oct 6, 10:00', duration: 80, transcript, edit: { trim: { start: 0, end: 80 } }, summary: null };

const h1 = transcriptHash(transcript);
eq(transcriptHash(transcript), h1, 'hash is stable');
ok(transcriptHash(transcript.map((s, i) => (i === 3 ? { ...s, text: `${s.text} too` } : s))) !== h1, 'hash changes when text changes');
eq(transcriptHash(transcript.map((s) => ({ ...s, text: `  ${s.text}  ` }))), h1, 'hash ignores surrounding whitespace');
eq(transcriptHash([]), transcriptHash(undefined), 'empty hashes agree');
ok(/^[0-9a-z]+-[0-9a-f]{8}$/.test(h1), `hash format (${h1})`);

const local = localSummary(project);
log(`  local title: ${local.title}`);
log(`  local tldr: ${local.tldr}`);
log(`  local key points: ${JSON.stringify(local.key_points)}`);
log(`  local action items: ${JSON.stringify(local.action_items)}`);
log(`  local chapters: ${JSON.stringify(local.chapters)}`);
eq(local.source, 'local', 'local source');
eq(local.model, null, 'local model null');
eq(local.transcriptHash, h1, 'local summary carries the transcript hash');
ok(typeof local.generatedAt === 'number', 'generatedAt set');
ok(local.title && local.title !== 'Untitled recording' && /dashboard/i.test(local.title), 'title from keywords');
ok(local.tldr.length > 20 && local.tldr.length <= 280, 'tldr present and bounded');
ok(local.key_points.length >= 3 && local.key_points.length <= 5, `3–5 key points (${local.key_points.length})`);
ok(local.key_points.every((p) => p.length <= 140 && /^[A-Z]/.test(p)), 'key points trimmed and capitalized');
ok(!local.key_points.some((p) => local.tldr.includes(p)), 'key points distinct from tldr');
ok(local.action_items.some((a) => /timezone bug/.test(a)), '"we need to" → action item');
ok(local.action_items.some((a) => /make sure/i.test(a)), '"make sure" → action item');
ok(!local.action_items.some((a) => /look at the export/i.test(a)), 'narration ("let\'s look at") is not an action item');
ok(local.action_items.length <= 5, 'at most 5 action items');
ok(local.chapters.length >= 2 && local.chapters.length <= 5, `2–5 chapters (${local.chapters.length})`);
eq(local.chapters[0].start, 0, 'first chapter at 0');
ok(local.chapters.every((c, i) => c.title && c.start >= 0 && c.start <= 80 && (i === 0 || c.start > local.chapters[i - 1].start)), 'chapters sorted, titled, in range');

const empty = localSummary({ duration: 10, transcript: [] });
eq(empty.title, 'Untitled recording', 'empty transcript title');
eq(empty.key_points.length + empty.action_items.length + empty.chapters.length, 0, 'empty transcript lists');

const spoken = localSummary({
  duration: 400,
  transcript: Array.from({ length: 24 }, (_, i) => ({
    start: i * 16, end: i * 16 + 14,
    text: [
      'um so today i want to show you how the billing page works and how invoices get created',
      'the billing page lists every invoice for the account and you can download each invoice as a pdf',
      'uh we should probably add a search box because big accounts have hundreds of invoices',
      'next the payment settings let you change the card on file and the billing email',
    ][i % 4],
  })),
});
ok(/billing|invoice/i.test(spoken.title), `unpunctuated speech title (${spoken.title})`);
ok(spoken.chapters.length >= 2 && spoken.chapters.length <= 5, 'unpunctuated speech chapters');
ok(spoken.key_points.every((p) => /^[A-Z]/.test(p) && /[.!?…]$/.test(p) && !/\bum\b|\buh\b/i.test(p)), 'spoken sentences polished');
ok(/^I want to show you/.test(spoken.tldr) || spoken.tldr.length > 0, `spoken tldr (${spoken.tldr})`);

// Markdown
const md = summaryToMarkdown(local, project);
ok(md.startsWith(`# ${local.title}\n`), 'markdown title');
ok(md.includes('## TL;DR') && md.includes('## Key points') && md.includes('## Chapters'), 'markdown sections');
ok(md.includes('- [ ] '), 'markdown action items as checkboxes');
ok(md.includes('- **0:00** '), 'markdown chapter timestamps');
const trimmedMd = summaryToMarkdown({ ...local, chapters: [{ start: 0, title: 'Intro' }, { start: 10, title: 'Middle' }, { start: 70, title: 'Late' }] }, { ...project, edit: { trim: { start: 20, end: 60 } } });
ok(trimmedMd.includes('- **0:00** Middle') && !trimmedMd.includes('Intro') && !trimmedMd.includes('Late'), 'markdown chapters re-timed to the trim');
eq(summaryToMarkdown(null, project), '', 'markdown for no summary');

// generateSummary: runs locally (never touches the network) and honours abort
let fetchCalls = 0;
globalThis.fetch = () => { fetchCalls++; return Promise.reject(new Error('summaries must not use the network')); };
const gen = await generateSummary(project);
eq(gen.source, 'local', 'generateSummary is local');
eq(gen.transcriptHash, h1, 'generated summary carries the transcript hash');
eq(JSON.stringify(gen.chapters), JSON.stringify(local.chapters), 'generateSummary matches localSummary');
eq(fetchCalls, 0, 'generateSummary makes no network requests');

const pre = new AbortController();
pre.abort();
let abortName = null;
try { await generateSummary(project, { signal: pre.signal }); } catch (err) { abortName = err.name; }
eq(abortName, 'AbortError', 'already-aborted signal rejects');

log(`\n${passes} passed, ${failures} failed`);
if (failures) throw new Error(`${failures} self-test failure(s)`);
