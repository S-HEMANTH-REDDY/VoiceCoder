// Fuzzy file ranking for spoken file names ("open the authentication file").

/** Ranks workspace-relative paths against a spoken query; best first. */
export function rankFiles(files: string[], query: string): Array<{ path: string; score: number }> {
  const q = query.toLowerCase().replace(/\b(?:the|a|my|file|module|component)\b/g, ' ').trim();
  const dotted = q.replace(/\s+dot\s+/g, '.').replace(/\s+/g, '');
  const tokens = q.split(/[\s._-]+/).filter((t) => t.length > 1);
  const out: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    const originalBase = path.split('/').pop()!;
    const base = originalBase.toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    const stemWords = originalBase
      .replace(/\.[^.]+$/, '')
      .split(/(?=[A-Z])|[._-]/)
      .map((w) => w.toLowerCase())
      .filter(Boolean);
    let score = 0;
    if (base === dotted || stem === dotted) score += 100;
    else if (base.startsWith(dotted)) score += 60;
    for (const t of tokens) {
      if (stem === t) score += 40;
      else if (stem.includes(t)) score += 25;
      else if (t.length >= 4 && (t.startsWith(stem) || stemWords.some((w) => w.length >= 3 && t.startsWith(w)))) score += 18;
      else if (lower.includes(t)) score += 8;
    }
    if (score > 0) {
      // Prefer source over tests/config and shallower paths.
      if (/(^|\/)(test|tests|__tests__|spec)\//.test(lower) || /\.(test|spec)\./.test(lower)) score -= 5;
      score -= path.split('/').length * 0.5;
      out.push({ path, score: Math.round(score * 10) / 10 });
    }
  }
  return out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
}
