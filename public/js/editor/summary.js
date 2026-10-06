// Recording summaries: a fast extractive summary computed entirely in the browser (no
// server, no API key), plus Markdown export. No DOM access at import time, so this module
// loads in a bare JS shell.

import { clamp, formatTime } from '../lib/util.js';

const MAX_POINT_CHARS = 140;
const MAX_TLDR_CHARS = 280;
const UNTITLED = 'Untitled recording';


/* ------------------------------------------------------------------ */
/* Transcript helpers                                                  */
/* ------------------------------------------------------------------ */

const normalizeSpace = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const round2 = (x) => Math.round(x * 100) / 100;

/** Stable 32-bit FNV-1a over "start|text" lines (whitespace-normalized). */
export function transcriptHash(transcript) {
  let hash = 0x811c9dc5;
  let count = 0;
  for (const seg of Array.isArray(transcript) ? transcript : []) {
    const text = normalizeSpace(seg?.text);
    if (!text) continue;
    const start = Number(seg?.start);
    const line = `${Number.isFinite(start) ? start.toFixed(2) : '0.00'}|${text}\n`;
    for (let i = 0; i < line.length; i++) {
      hash ^= line.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    count++;
  }
  return `${count.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Sorted segments with finite times and non-empty text. */
function cleanTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .map((s) => {
      const text = normalizeSpace(s?.text);
      const start = Math.max(0, Number(s?.start));
      let end = Number(s?.end);
      if (!Number.isFinite(end) || end < start) end = start + clamp(text.split(' ').length * 0.35, 1, 8);
      return { start, end, text };
    })
    .filter((s) => s.text && Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
}

function projectDuration(project, transcript) {
  const d = Number(project?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  return transcript.reduce((max, s) => Math.max(max, s.end), 0);
}

/* ------------------------------------------------------------------ */
/* Text analysis                                                       */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(`
a about above actually after again against ago ah ahead all almost along already alright also although always am among amongst an and
another any anybody anyone anything anyway anyways anywhere are aren't around as ask asked asking at away awesome back bad basically be
became because become been before being below best better between big bit both but by came can can't cannot cause come comes coming could
couldn't cool did didn't do does doesn't doing don't done down during each easy eight either else enough especially etc even ever every
everybody everyone everything exactly example far feel few fifth find fine first five folks for four from front fun get gets getting give
given gives go goes going gone gonna good got gotta great guess guys had hadn't happen happens has hasn't have haven't having he he'd he'll
he's hello her here here's hey hi him himself his hit hmm honestly how however i i'd i'll i'm i've if in indeed instead into is isn't it
it'd it'll it's its itself just keep kind kinda know known last later least left less let let's lets like literally little look looked
looking looks lot lots made make makes making many may maybe me mean means might mine more most mostly much must my myself need needed
needs never new next nice nine no nobody none nope nor not nothing now of off oh ok okay on once one ones only onto open or other others
otherwise our ours ourselves out over own part per perhaps pretty probably put quick quickly quite rather really right said same saw say
saying says second see seeing seem seemed seems seen seven she she'll she's should shouldn't show showed showing shown shows side since six
so some somebody someone something sometimes somewhat somewhere soon sort sorry start started starting still stuff such super sure take
taken takes taking talk talking tell ten than thank thanks that that's the their theirs them themselves then there there's these they
they'd they'll they're they've thing things think thinking third this those though three through thus to today together too took toward
towards tried tries try trying two uh uhm um umm under until up upon us use used uses using usually very via video wanna want wanted wants
was wasn't watch way ways we we'd we'll we're we've well went were weren't what what's whatever when where where's whether which while
who who's whole whom whose why will with within without won't wow would wouldn't yeah yep yes yet you you'd you'll you're you've your
yours yourself yourselves click clicked clicking clicks scroll scrolling press pressing type typing
`.trim().split(/\s+/));

const ACRONYMS = new Set(['ai', 'api', 'apis', 'ui', 'ux', 'url', 'urls', 'css', 'html', 'js', 'sql', 'pr', 'prs', 'qa', 'kpi', 'kpis', 'okr', 'okrs',
  'sdk', 'json', 'csv', 'pdf', 'ceo', 'cto', 'cfo', 'coo', 'crm', 'seo', 'saas', 'b2b', 'b2c', 'gpu', 'cpu', 'ram', 'db', 'aws', 'gcp', 'hr', 'faq',
  'mvp', 'roi', 'eta', 'q1', 'q2', 'q3', 'q4', 'ci', 'cd', 'ml', 'llm', 'vp', 'pm', 'id', 'ids', 'mrr', 'arr', 'nps', 'sla', 'ssd']);
const SPECIAL_CASE = {
  ios: 'iOS', macos: 'macOS', iphone: 'iPhone', ipad: 'iPad', github: 'GitHub', gitlab: 'GitLab', javascript: 'JavaScript',
  typescript: 'TypeScript', youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok', chatgpt: 'ChatGPT', openai: 'OpenAI',
  graphql: 'GraphQL', postgresql: 'PostgreSQL', wifi: 'Wi-Fi', ecommerce: 'eCommerce',
};

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const BOUNDARY_RE = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
const ABBREV_END = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|approx|inc|ltd|no|fig|e\.g|i\.e)\.$/i;
const TERMINAL_RE = /[.!?…]["'”’)\]]*$/;
const SOFT_BREAK = new Set(['so', 'and', 'but', 'then', 'now', 'next', 'also', 'because', 'which', 'okay', 'alright', 'anyway']);
const SUMMARY_CUE = /\b(?:in this (?:video|recording|loom)|today (?:i|we)|i (?:want|wanted) to (?:show|walk|share|give|talk)|(?:i'm|i am|we're|we are) going to (?:show|walk|go over|cover|talk)|walk (?:you )?through|the (?:goal|idea|point|plan) (?:is|was|here)|quick (?:update|overview|demo|walkthrough)|overview of|the main)\b/i;

// Lowercase speech-recognition output → conventional casing for well-known terms.
const CASE_FIX = (() => {
  const map = { ...SPECIAL_CASE };
  for (const a of ['ai', 'api', 'ui', 'ux', 'url', 'css', 'html', 'sql', 'pdf', 'csv', 'json', 'sdk', 'ceo', 'cto', 'cfo', 'coo', 'crm',
    'seo', 'saas', 'faq', 'kpi', 'okr', 'mvp', 'roi', 'eta', 'qa', 'llm', 'aws', 'gcp', 'b2b', 'b2c', 'mrr', 'arr', 'nps', 'sla']) map[a] = a.toUpperCase();
  for (const a of ['api', 'url', 'kpi', 'okr', 'pdf', 'csv', 'faq', 'pr', 'id', 'llm']) map[`${a}s`] = `${a.toUpperCase()}s`;
  map.saas = 'SaaS';
  return map;
})();
const fixCasing = (text) => text.replace(/[a-z][a-z0-9]*/g, (w) => CASE_FIX[w] || w);

const isContent = (bare) => (bare.length >= 3 || ACRONYMS.has(bare)) && !/^\d+$/.test(bare) && !STOPWORDS.has(bare);

function stem(word) {
  if (word.length <= 3 || ACRONYMS.has(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is|ous)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Content tokens with gaps: null marks a stopword so bigrams only join truly adjacent words. */
function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(WORD_RE)) {
    const surface = m[0].replace(/’/g, "'").replace(/[-']+$/, '').replace(/'s$/i, '');
    const lower = surface.toLowerCase();
    if (!lower || STOPWORDS.has(m[0].toLowerCase().replace(/’/g, "'")) || !isContent(lower)) { out.push(null); continue; }
    out.push({ stem: stem(lower), surface });
  }
  return out;
}

function splitSentences(text) {
  const out = [];
  let last = 0;
  BOUNDARY_RE.lastIndex = 0;
  let m;
  while ((m = BOUNDARY_RE.exec(text))) {
    const end = m.index + m[0].length;
    const piece = text.slice(last, end).trim();
    if (ABBREV_END.test(piece)) continue;
    if (piece) out.push(piece);
    last = end;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push(rest);
  return out.flatMap(splitLong);
}

/** Speech recognition often returns long unpunctuated runs; cut them near natural joints. */
function splitLong(sentence) {
  const words = sentence.split(' ');
  if (words.length <= 32) return [sentence];
  const size = Math.ceil(words.length / Math.ceil(words.length / 22));
  const lower = (w) => (w || '').toLowerCase().replace(/[^\p{L}']/gu, '');
  const out = [];
  let from = 0;
  while (words.length - from > size + 4) {
    let cut = from + size;
    for (let d = 0; d <= 5; d++) {
      if (cut + d < words.length && SOFT_BREAK.has(lower(words[cut + d]))) { cut += d; break; }
      if (cut - d > from + 6 && (SOFT_BREAK.has(lower(words[cut - d])) || /[,;:]$/.test(words[cut - d - 1]))) { cut -= d; break; }
    }
    out.push(words.slice(from, cut).join(' '));
    from = cut;
  }
  out.push(words.slice(from).join(' '));
  return out;
}

const LEAD_FILLER = /^(?:(?:so|okay|ok|alright|all right|um+|uh+|uhm|erm|hmm+|well|yeah|yep|and|but|also|now|anyway|anyways|basically|like)\b[,.]?\s+)+/i;

/** Readable sentence: no fillers or stutters, capitalized, terminal punctuation, optional length cap. */
function polish(raw, max = 0) {
  let s = raw
    .replace(/\b(?:um+|uh+|uhm|erm|hmm+)\b[,.]?\s*/gi, '')
    .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = s.replace(LEAD_FILLER, '');
  if (stripped.length >= 8) s = stripped;
  s = s.replace(/^[,.;:!?\-–—\s]+/, '');
  s = s.replace(/(^|[\s"“(])i(?=$|[\s,!?;:'’]|\.(?!e\.))/g, '$1I');
  s = fixCasing(s);
  if (!s) s = normalizeSpace(raw);
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!TERMINAL_RE.test(s)) s = `${s.replace(/[,;:\-–—]+$/, '')}.`;
  return max ? truncate(s, max) : s;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s,;:.!?\-–—]+$/, '')}…`;
}

function titleWord(surface) {
  const lower = surface.toLowerCase();
  if (SPECIAL_CASE[lower]) return SPECIAL_CASE[lower];
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (/[A-Z]/.test(surface.slice(1))) return surface; // already cased, e.g. "DevOps"
  return surface.charAt(0).toUpperCase() + surface.slice(1).toLowerCase();
}

function joinTitle(parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} & ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

/** Splits the transcript into timed sentences and gathers term statistics. */
function analyze(transcript) {
  const sentences = [];
  for (const seg of transcript) {
    const pieces = splitSentences(seg.text);
    const total = pieces.reduce((sum, p) => sum + p.length, 0) || 1;
    const span = Math.max(0, seg.end - seg.start);
    let acc = 0;
    for (const raw of pieces) {
      const start = seg.start + (span * acc) / total;
      acc += raw.length;
      const tokens = tokenize(raw);
      const content = tokens.filter(Boolean);
      sentences.push({
        raw, start, end: seg.start + (span * acc) / total, tokens, content,
        stems: new Set(content.map((t) => t.stem)),
        words: raw.split(' ').length,
        index: sentences.length,
        score: 0,
      });
    }
  }

  const tf = new Map();        // stem -> count
  const surfaces = new Map();  // stem -> Map(surface -> count)
  const firstSeen = new Map(); // stem -> sentence index
  const bigrams = new Map();   // "stemA stemB" -> count
  for (const s of sentences) {
    s.tokens.forEach((tok, i) => {
      if (!tok) return;
      tf.set(tok.stem, (tf.get(tok.stem) || 0) + 1);
      if (!firstSeen.has(tok.stem)) firstSeen.set(tok.stem, s.index);
      const forms = surfaces.get(tok.stem) || new Map();
      forms.set(tok.surface, (forms.get(tok.surface) || 0) + 1);
      surfaces.set(tok.stem, forms);
      const next = s.tokens[i + 1];
      if (next && next.stem !== tok.stem) {
        const key = `${tok.stem} ${next.stem}`;
        bigrams.set(key, (bigrams.get(key) || 0) + 1);
      }
    });
  }

  const n = sentences.length;
  for (const s of sentences) {
    let sum = 0;
    for (const tok of s.content) sum += tf.get(tok.stem);
    let score = s.content.length ? sum / Math.pow(s.content.length, 0.6) : 0;
    if (s.words < 5) score *= 0.55;
    else if (s.words > 45) score *= 0.8;
    if (/\?["'”’)]*$/.test(s.raw)) score *= 0.8;
    if (n > 3 && s.index / n < 0.12) score *= 1.12; // intros tend to state the topic
    if (SUMMARY_CUE.test(s.raw)) score *= 1.3;
    s.score = score;
  }

  const display = (st) => {
    const forms = surfaces.get(st);
    if (!forms) return st;
    let best = st, bestCount = -1;
    for (const [form, count] of forms) {
      if (count > bestCount || (count === bestCount && form.length < best.length)) { best = form; bestCount = count; }
    }
    return best;
  };
  return { sentences, tf, bigrams, firstSeen, display };
}

/**
 * Picks up to `maxItems` key phrases (unigrams or adjacent bigrams), at most `maxWords` words in total.
 * @param {Array<{stems:string[], score:number, order:number}>} candidates
 */
function pickPhrases(candidates, maxItems, maxWords) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.order - b.order);
  const chosen = [];
  let words = 0;
  for (const c of sorted) {
    if (chosen.length >= maxItems) break;
    const overlapping = chosen.filter((x) => x.stems.some((st) => c.stems.includes(st)));
    if (overlapping.length) {
      // A bigram may absorb a unigram it contains ("design" → "design system").
      if (c.stems.length === 2 && overlapping.length === 1 && overlapping[0].stems.length === 1 && words + 1 <= maxWords) {
        chosen[chosen.indexOf(overlapping[0])] = c;
        words += 1;
      }
      continue;
    }
    if (words + c.stems.length > maxWords) continue;
    chosen.push(c);
    words += c.stems.length;
  }
  return chosen;
}

function phraseCandidates(tf, bigrams, firstSeen, { idf = () => 1, minBigram = 2 } = {}) {
  const out = [];
  for (const [st, count] of tf) out.push({ stems: [st], score: count * idf(st), order: firstSeen.get(st) ?? 0 });
  for (const [key, count] of bigrams) {
    if (count < minBigram) continue;
    const stems = key.split(' ');
    out.push({ stems, score: count * 1.6 * Math.max(idf(stems[0]), idf(stems[1])), order: Math.min(firstSeen.get(stems[0]) ?? 0, firstSeen.get(stems[1]) ?? 0) });
  }
  return out;
}

const phraseText = (doc, phrase) => phrase.stems.map((st) => titleWord(doc.display(st))).join(' ');

function similarity(a, b) {
  if (!a.stems.size || !b.stems.size) return 0;
  let shared = 0;
  for (const st of a.stems) if (b.stems.has(st)) shared++;
  return shared / (a.stems.size + b.stems.size - shared);
}

/* ------------------------------------------------------------------ */
/* Local (extractive) summary                                          */
/* ------------------------------------------------------------------ */

const ACTION_CUES = [
  { re: /\baction items?\b/i, weight: 5 },
  { re: /\b(?:todos?|to-dos?|to do list)\b/i, weight: 5 },
  { re: /\bnext steps?\b/i, weight: 4 },
  { re: /\bmake sure\b/i, weight: 4 },
  { re: /\bwe (?:need|have|got) to\b|\bwe must\b/i, weight: 4 },
  { re: /\bfollow[- ]?up\b/i, weight: 3 },
  { re: /\b(?:i|you|they|someone|somebody|everyone) (?:need|needs|have|has) to\b/i, weight: 3 },
  { re: /\blet['’]s\b/i, weight: 2 },
  { re: /\bshould\b/i, weight: 2 },
  { re: /\bwill\b|\b(?:i|we|you|they)['’]ll\b/i, weight: 1 },
];
// Screen-recording narration that sounds like an intent but is not a follow-up.
const NARRATION = /\blet['’]s (?:just |quickly |now )?(?:take a (?:quick )?look|look|see|go (?:to|into|over|back|ahead)|start|jump|dive|check (?:out|it)|switch|open|click|scroll|zoom|head|move on|get started|begin)\b|\b(?:you|we)(?:['’]ll| will) (?:see|notice|find)\b|\b(?:this|it|that) will (?:show|open|take you|pop up|appear)\b/i;

function actionItems(sentences) {
  const candidates = [];
  for (const s of sentences) {
    if (s.words < 4) continue;
    let weight = 0, hits = 0;
    for (const cue of ACTION_CUES) {
      if (cue.re.test(s.raw)) { weight = Math.max(weight, cue.weight); hits++; }
    }
    if (!weight) continue;
    if (weight < 4 && (NARRATION.test(s.raw) || /\?["'”’)]*$/.test(s.raw))) continue;
    candidates.push({ s, rank: weight + (hits - 1) * 0.5 });
  }
  candidates.sort((a, b) => b.rank - a.rank || b.s.score - a.s.score);
  const strong = candidates.filter((c) => c.rank >= 2).length;
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= 5) break;
    if (c.rank < 2 && strong + picked.filter((p) => p.rank < 2).length >= 3) continue; // a bare "will" is a weak signal
    if (picked.some((p) => similarity(p.s, c.s) >= 0.6)) continue;
    picked.push(c);
  }
  const seen = new Set();
  return picked
    .sort((a, b) => a.s.index - b.s.index)
    .map((c) => polish(c.s.raw, MAX_POINT_CHARS))
    .filter((text) => !seen.has(text) && seen.add(text));
}

function buildChapters(doc, duration) {
  const S = doc.sentences;
  if (!S.length) return [];
  const total = duration > 0 ? duration : S[S.length - 1].end;
  const want = total < 60 ? 2 : total < 180 ? 3 : total < 480 ? 4 : 5;
  const count = Math.max(1, Math.min(want, S.length));
  const minGap = Math.min(10, total * 0.08);

  // Bucket boundaries at even time steps, snapped to the nearest sentence start.
  const starts = [0];
  for (let i = 1; i < count; i++) {
    const target = (total * i) / count;
    const prevIdx = starts[starts.length - 1];
    const prevTime = starts.length === 1 ? 0 : S[prevIdx].start;
    let best = -1, bestDist = Infinity;
    for (let j = prevIdx + 1; j < S.length; j++) {
      if (S[j].start - prevTime < minGap) continue;
      const dist = Math.abs(S[j].start - target);
      if (dist < bestDist) { bestDist = dist; best = j; }
    }
    if (best < 0 || total - S[best].start < minGap) break;
    starts.push(best);
  }
  const buckets = starts.map((idx, b) => S.slice(idx, b + 1 < starts.length ? starts[b + 1] : S.length));

  // Title each bucket by the terms most specific to it.
  const local = buckets.map((sents) => {
    const tf = new Map(), bigrams = new Map(), firstSeen = new Map();
    for (const s of sents) {
      s.tokens.forEach((tok, i) => {
        if (!tok) return;
        tf.set(tok.stem, (tf.get(tok.stem) || 0) + 1);
        if (!firstSeen.has(tok.stem)) firstSeen.set(tok.stem, s.index);
        const next = s.tokens[i + 1];
        if (next && next.stem !== tok.stem) {
          const key = `${tok.stem} ${next.stem}`;
          bigrams.set(key, (bigrams.get(key) || 0) + 1);
        }
      });
    }
    return { tf, bigrams, firstSeen };
  });
  const df = new Map();
  for (const l of local) for (const st of l.tf.keys()) df.set(st, (df.get(st) || 0) + 1);
  const B = buckets.length;
  // Distinctive to this bucket first; then overall topic weight; then longer (usually more specific) words.
  const idf = (st) => 1 + Math.log(B / (df.get(st) || 1)) + 0.04 * (doc.tf.get(st) || 0) + 0.02 * Math.min(doc.display(st).length, 10);

  const chapters = [];
  const usedStems = new Set();
  buckets.forEach((sents, b) => {
    const l = local[b];
    const cands = phraseCandidates(l.tf, l.bigrams, l.firstSeen, { idf, minBigram: 1 })
      .filter((c) => c.stems.length === 1 || (doc.bigrams.get(c.stems.join(' ')) || 0) >= 2);
    let phrases = pickPhrases(cands, 2, 3);
    let title = joinTitle(phrases.map((p) => phraseText(doc, p)));
    if (title && phrases.every((p) => p.stems.every((st) => usedStems.has(st)))) {
      // Same topic words as an earlier chapter: describe it by what is new here instead.
      const fresh = pickPhrases(cands.filter((c) => !c.stems.some((st) => usedStems.has(st))), 2, 3);
      if (fresh.length) {
        phrases = fresh;
        title = joinTitle(fresh.map((p) => phraseText(doc, p)));
      }
    }
    if (!title) title = b === 0 ? 'Introduction' : b === B - 1 && B > 1 ? 'Wrap-up' : `Part ${b + 1}`;
    if (chapters.length && chapters[chapters.length - 1].title === title) return; // merge into the previous chapter
    phrases.forEach((p) => p.stems.forEach((st) => usedStems.add(st)));
    chapters.push({ start: b === 0 ? 0 : round2(sents[0].start), title });
  });
  return chapters;
}

const LEAD_IN = /^(?:(?:hey|hi|hello|ok(?:ay)?|alright|all right|so|um+|uh+|well|right|yeah|good (?:morning|afternoon|evening))\b[\s,!.-]*)+(?:(?:team|everyone|everybody|all|guys|folks|there|y'all)\b[\s,!.-]*)?/i;
const FILLER_START = /^(?:(?:in this (?:video|recording|loom)|today|here|i(?:'m| am) going to|i want(?:ed)? to|let me|i'll|we'll|just)\b[\s,]*)+/i;
const WEAK_END = /\b(?:a|an|the|of|to|for|and|or|with|on|in|at|by|is|are|this|that|my|our|your)$/i;

/** Turns a spoken sentence into a short title, or '' when it doesn't make a good one. */
function headline(sentence) {
  if (!sentence || !sentence.raw) return '';
  let text = String(sentence.raw).replace(/\s+/g, ' ').trim();
  text = text.split(/(?<=[.!?])\s/)[0].replace(LEAD_IN, '').replace(FILLER_START, '').replace(/[.!?,;:]+$/, '').trim();
  let words = text.split(' ').filter(Boolean);
  if (words.length > 8) words = words.slice(0, 8);
  while (words.length > 3 && WEAK_END.test(words[words.length - 1])) words.pop();
  if (words.length < 3) return '';
  const out = words.join(' ').replace(/[,;:-]+$/, '');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Extractive summary computed locally (no network).
 * @param {object} project
 * @returns {object} Summary with source 'local'
 */
export function localSummary(project) {
  const transcript = cleanTranscript(project?.transcript);
  const duration = projectDuration(project, transcript);
  const meta = { source: 'local', model: null, generatedAt: Date.now(), transcriptHash: transcriptHash(project?.transcript) };
  if (!transcript.length) {
    return { title: UNTITLED, tldr: 'No speech was transcribed in this recording.', key_points: [], action_items: [], chapters: [], ...meta };
  }

  const doc = analyze(transcript);
  const { sentences } = doc;

  const ranked = sentences.filter((s) => s.content.length).sort((a, b) => b.score - a.score || a.index - b.index);

  // Speakers usually name the topic up front ("Hey team, quick walkthrough of …"), so a
  // cleaned-up opening sentence makes a far more natural title than a keyword list.
  const titlePhrases = pickPhrases(phraseCandidates(doc.tf, doc.bigrams, doc.firstSeen), 3, 4);
  const title = headline(sentences[0]) || headline(ranked[0]) || joinTitle(titlePhrases.map((p) => phraseText(doc, p))) || UNTITLED;
  const tldrSents = [];
  if (ranked.length) {
    tldrSents.push(ranked[0]);
    if (sentences.length >= 5 && polish(ranked[0].raw).length < 110) {
      const second = ranked.slice(1).find((s) => s.score >= ranked[0].score * 0.55 && s.words >= 4 && similarity(s, ranked[0]) < 0.5);
      if (second) tldrSents.push(second);
    }
  } else {
    tldrSents.push(sentences[0]);
  }
  tldrSents.sort((a, b) => a.index - b.index);
  const tldr = truncate(tldrSents.map((s) => polish(s.raw)).join(' '), MAX_TLDR_CHARS);

  const target = clamp(Math.round(sentences.length / 5), 3, 5);
  const points = [];
  const tryAdd = (s, minWords, minContent, maxSim) => {
    if (points.length >= target || tldrSents.includes(s) || points.includes(s)) return;
    if (s.words < minWords || s.content.length < minContent) return;
    if ([...points, ...tldrSents].some((p) => similarity(p, s) >= maxSim)) return;
    points.push(s);
  };
  for (const s of ranked) tryAdd(s, 4, 2, 0.5);
  for (const s of ranked) tryAdd(s, 3, 1, 0.7); // relax for short transcripts
  const seen = new Set(tldrSents.map((s) => polish(s.raw, MAX_POINT_CHARS)));
  const key_points = points
    .sort((a, b) => a.index - b.index)
    .map((s) => polish(s.raw, MAX_POINT_CHARS))
    .filter((text) => !seen.has(text) && seen.add(text));

  return {
    title,
    tldr,
    key_points,
    action_items: actionItems(sentences),
    chapters: buildChapters(doc, duration),
    ...meta,
  };
}

/* ------------------------------------------------------------------ */
/* Async entry point                                                   */
/* ------------------------------------------------------------------ */

function abortError(signal) {
  const reason = signal?.reason;
  if (reason && reason.name === 'AbortError') return reason;
  try {
    return new DOMException('Summary generation was cancelled.', 'AbortError');
  } catch {
    const err = new Error('Summary generation was cancelled.');
    err.name = 'AbortError';
    return err;
  }
}

/**
 * Summarizes the project's transcript in the browser. Async so callers can treat it like
 * any background job; rejects only with an AbortError.
 * @param {object} project
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object>} Summary (source 'local')
 */
export async function generateSummary(project, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);
  // Yield once so a caller that starts this during a render doesn't block that frame.
  await Promise.resolve();
  if (signal?.aborted) throw abortError(signal);
  return localSummary(project);
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/**
 * Markdown for sharing. When the project is trimmed, chapter timestamps are re-timed to
 * match the exported (trimmed) video.
 */
export function summaryToMarkdown(summary, project) {
  if (!summary || typeof summary !== 'object') return '';
  const clean = (v) => normalizeSpace(typeof v === 'string' ? v : '');
  const list = (v) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
  const title = clean(summary.title) || clean(project?.title) || UNTITLED;
  const tldr = clean(summary.tldr);
  const points = list(summary.key_points);
  const actions = list(summary.action_items);

  const duration = Number(project?.duration);
  const trim = project?.edit?.trim;
  const tStart = Number.isFinite(Number(trim?.start)) ? Math.max(0, Number(trim.start)) : 0;
  const tEnd = Number.isFinite(Number(trim?.end)) && Number(trim.end) > tStart ? Number(trim.end) : (Number.isFinite(duration) && duration > 0 ? duration : Infinity);
  const chapters = [];
  const sourceChapters = (Array.isArray(summary.chapters) ? summary.chapters : []).slice().sort((a, b) => Number(a?.start) - Number(b?.start));
  for (const c of sourceChapters) {
    const start = Number(c?.start);
    const name = clean(c?.title);
    if (!name || !Number.isFinite(start)) continue;
    if (start >= tEnd - 0.5 && chapters.length) continue;
    const t = Math.max(0, start - tStart);
    // Several chapters before the trim point collapse to 0:00; keep the one playing at the cut.
    if (chapters.length && t === 0 && chapters[chapters.length - 1].t === 0) chapters[chapters.length - 1] = { t, name };
    else chapters.push({ t, name });
  }
  chapters.sort((a, b) => a.t - b.t);

  const lines = [`# ${title}`, ''];
  const length = Number.isFinite(tEnd) ? tEnd - tStart : NaN;
  if (Number.isFinite(length) && length > 0) lines.push(`*${formatTime(length)} video*`, '');
  if (tldr) lines.push('## TL;DR', '', tldr, '');
  if (points.length) lines.push('## Key points', '', ...points.map((p) => `- ${p}`), '');
  if (actions.length) lines.push('## Action items', '', ...actions.map((a) => `- [ ] ${a}`), '');
  if (chapters.length) lines.push('## Chapters', '', ...chapters.map((c) => `- **${formatTime(c.t)}** ${c.name}`), '');
  const model = clean(summary.model);
  lines.push('---', '', summary.source === 'ai' ? `_AI summary${model ? ` by ${model}` : ''} · made with Dolly_` : '_Summary made with Dolly_');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
