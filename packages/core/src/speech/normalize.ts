// Transcript normalization: speech engines are trained on everyday speech, not on
// "JWT", "PostgreSQL" or "useEffect". This pass repairs the systematic errors we see
// in developer dictation before anything downstream (intent parsing, prompts) runs.
//
// It is deliberately deterministic and cheap (<0.1 ms for typical utterances) so it
// can run on every interim result.

/** Ordered list of [pattern, replacement]. Patterns are case-insensitive, word-bounded. */
const TECH_VOCABULARY: Array<[RegExp, string]> = [
  // Languages & runtimes
  [/\btype ?script\b/gi, 'TypeScript'],
  [/\bjava ?script\b/gi, 'JavaScript'],
  [/\bnode ?(?:dot )?js\b/gi, 'Node.js'],
  [/\bnext ?(?:dot )?js\b/gi, 'Next.js'],
  [/\bc plus plus\b/gi, 'C++'],
  [/\bc sharp\b/gi, 'C#'],
  [/\bgo ?lang\b/gi, 'Go'],
  [/\bpie ?test\b|\bpy ?test\b|\bpi test\b/gi, 'pytest'],
  [/\bjest\b/gi, 'Jest'],
  [/\bfast ?api\b/gi, 'FastAPI'],
  [/\bjango\b/gi, 'Django'],
  [/\bexpress ?js\b/gi, 'Express'],
  // Data & protocols
  [/\bjason\b|\bj son\b|\bj s o n\b/gi, 'JSON'],
  [/\bpost ?gres(?:s|q l| ?sql| ?ql)?\b|\bpost ?gre ?sql\b|\bpostgre\b/gi, 'PostgreSQL'],
  [/\bmy ?sequel\b|\bmy s q l\b/gi, 'MySQL'],
  [/\bsequel ?lite\b|\bsq ?lite\b/gi, 'SQLite'],
  [/\bmongo ?d ?b\b/gi, 'MongoDB'],
  [/\bre ?dis\b/gi, 'Redis'],
  [/\bgraph ?q ?l\b/gi, 'GraphQL'],
  [/\bs q l\b/gi, 'SQL'],
  [/\by a m l\b|\byamel\b|\byammel\b/gi, 'YAML'],
  [/\bx m l\b/gi, 'XML'],
  [/\bh t m l\b/gi, 'HTML'],
  [/\bc s s\b/gi, 'CSS'],
  [/\bh t t p s\b/gi, 'HTTPS'],
  [/\bh t t p\b/gi, 'HTTP'],
  [/\bu r l\b/gi, 'URL'],
  [/\bu u i d\b/gi, 'UUID'],
  [/\brest ?full?\b/gi, 'RESTful'],
  [/\ba p i\b/gi, 'API'],
  [/\bc r u d\b/gi, 'CRUD'],
  [/\bjay w t\b|\bj w t\b|\bjay double ?you tee\b|\bjwt\b/gi, 'JWT'],
  [/\bo ?auth\b/gi, 'OAuth'],
  [/\bcors\b|\bc o r s\b/gi, 'CORS'],
  [/\bweb ?socket\b/gi, 'WebSocket'],
  // Tooling
  [/\bget ?hub\b|\bgit ?hub\b/gi, 'GitHub'],
  // "get status" → "git status", but only in command position ("show get diff",
  // "run get log") so instructions like "get status of the order" are untouched.
  [/(^|\b(?:show|run|do|the|a|my)\s)get (status|commit|push|pull|diff|log|branch|stash|checkout)(?=$|[\s.,!?]+(?:changes|origin|main|master|-))/gi, '$1git $2'],
  [/\bn p m\b/gi, 'npm'],
  [/\bes ?lint\b|\be s lint\b/gi, 'ESLint'],
  [/\bdocker ?file\b/gi, 'Dockerfile'],
  [/\bread ?me\b/gi, 'README'],
  [/\bdot env\b/gi, '.env'],
  [/\bvs ?code\b|\bv s code\b/gi, 'VS Code'],
  [/\bregex\b|\breg ex\b/gi, 'regex'],
  // React & JS idioms
  [/\buse state\b/gi, 'useState'],
  [/\buse effect\b/gi, 'useEffect'],
  [/\buse memo\b/gi, 'useMemo'],
  [/\buse callback\b/gi, 'useCallback'],
  [/\buse ref\b/gi, 'useRef'],
  [/\bconsole dot log\b/gi, 'console.log'],
  [/\ba sink (function|method|def)\b/gi, 'async $1'],
  [/\bmake it a sink\b/gi, 'make it async'],
  [/\bi d e\b/gi, 'IDE'],
  [/\bu i\b/gi, 'UI'],
];

const FILLERS = /\b(?:um+|uh+|erm+|er|hmm+|uhm+)\b[,.]?\s*/gi;

/** Normalizes a raw speech transcript into a cleaner developer instruction. */
export function normalizeTranscript(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(FILLERS, '');
  for (const [pattern, replacement] of TECH_VOCABULARY) {
    text = text.replace(pattern, replacement);
  }
  // Collapse stutters: "the the", "add add"
  text = text.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');
  // Remove trailing sentence punctuation that engines add; keeps commands clean.
  text = text.replace(/[.!?]+$/, '').trim();
  return text;
}

// ── Number words ──────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Parses a number spoken as digits ("45"), words ("forty five", "one hundred and two")
 * or Devanagari/Telugu digits. Returns null when the phrase is not a number.
 */
export function parseSpokenNumber(phrase: string): number | null {
  const cleaned = toAsciiDigits(phrase).trim().toLowerCase().replace(/-/g, ' ').replace(/,/g, '');
  if (!cleaned) return null;
  if (/^\d+$/.test(cleaned)) return Number(cleaned);

  const words = cleaned.split(/\s+/).filter((w) => w !== 'and');
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  let sawNumber = false;
  for (const w of words) {
    if (/^\d+$/.test(w)) {
      current += Number(w);
      sawNumber = true;
    } else if (w in UNITS) {
      // Homophones ("to", "for", "oh") only count when they are not the first word,
      // to avoid "go to" or "for loop" parsing as numbers.
      if ((w === 'to' || w === 'too' || w === 'for' || w === 'oh') && !sawNumber) return null;
      current += UNITS[w]!;
      sawNumber = true;
    } else if (w in TENS) {
      current += TENS[w]!;
      sawNumber = true;
    } else if (w === 'hundred') {
      current = (current || 1) * 100;
      sawNumber = true;
    } else if (w === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      sawNumber = true;
    } else {
      return null;
    }
  }
  return sawNumber ? total + current : null;
}

const NUMBER_WORD = '(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and|[०-९]+|[౦-౯]+)';
/** Regex source matching a run of number words, e.g. "one hundred and twenty three". */
export const SPOKEN_NUMBER_PATTERN = `${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*`;

function toAsciiDigits(s: string): string {
  return s
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[౦-౯]/g, (d) => String(d.charCodeAt(0) - 0x0c66));
}
