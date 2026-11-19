// Shell command policy. VoiceCoder never runs a model-proposed command blindly:
//   1. Every command is parsed into segments and checked against hard blocks
//      (privilege escalation, disk wiping, remote-code piping, fork bombs, …).
//   2. Anything not blocked is labelled with the risks it carries (deletes files,
//      network access, installs dependencies, rewrites git history, …).
//   3. The host shows the command + labels and runs it only after explicit approval.
// There is no "auto-run" path for model-generated commands.

export type RiskLabel =
  | 'deletes-files'
  | 'network'
  | 'installs-dependencies'
  | 'git-history'
  | 'git-remote'
  | 'publishes'
  | 'writes-outside-workspace'
  | 'shell-substitution'
  | 'long-running'
  | 'environment';

export interface CommandAssessment {
  command: string;
  allowed: boolean;
  /** Approval is always required for execution; this marks commands needing extra care. */
  severity: 'low' | 'medium' | 'high';
  labels: RiskLabel[];
  reasons: string[];
  segments: string[];
}

const MAX_LENGTH = 600;

const BLOCKS: Array<[RegExp, string]> = [
  [/(^|\s)(sudo|su|doas|pkexec)(\s|$)/, 'Privilege escalation is never allowed.'],
  [/\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r|--recursive)[a-z-]*\s+(--no-preserve-root\s+)?(\/|~|\$home|\.\.|\*)(\s|\/?$|\/\*)/i, 'Recursive deletion of root, home, parent or wildcard paths is blocked.'],
  [/\b(mkfs(\.\w+)?|fdisk|diskutil\s+erase\w*|format\s+[a-z]:)\b/i, 'Disk formatting is blocked.'],
  [/\bdd\s+.*\bof=\/dev\//i, 'Writing to raw devices is blocked.'],
  [/>\s*\/dev\/(sd|disk|nvme|hd)/i, 'Writing to raw devices is blocked.'],
  [/:\s*\(\s*\)\s*\{.*\|.*&\s*\}\s*;?\s*:/, 'Fork bombs are blocked.'],
  [/\b(curl|wget|fetch|iwr|invoke-webrequest)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python\d?|node|perl|ruby|iex)\b/i, 'Piping downloaded content into an interpreter is blocked.'],
  [/\bbase64\s+(-d|--decode)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node)\b/i, 'Executing decoded payloads is blocked.'],
  [/\b(shutdown|reboot|halt|poweroff|launchctl\s+unload|systemctl\s+(stop|disable|mask))\b/i, 'System power and service control is blocked.'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+(\/|~)/i, 'Making system or home directories world-writable is blocked.'],
  [/\bchown\s+-R\s+\S+\s+(\/|~)(\s|$)/i, 'Recursive ownership changes outside the project are blocked.'],
  [/\b(printenv|env|set)\b\s*\|\s*(curl|wget|nc|ncat|netcat)\b/i, 'Sending environment variables over the network is blocked.'],
  [/\b(cat|less|head|tail)\s+[^|]*(\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|keychain)/i, 'Reading credential files is blocked.'],
  [/\b(nc|ncat|netcat)\s+(-[a-z]*e|-[a-z]*c)\b/i, 'Reverse shells are blocked.'],
  [/\bhistory\s+-c\b|\bshred\b/i, 'Destroying history or shredding files is blocked.'],
  [/\bcrontab\s+-r\b/i, 'Removing crontabs is blocked.'],
];

const LABELS: Array<[RegExp, RiskLabel, string]> = [
  [/\b(rm|rmdir|unlink|del|rd)\b|\bgit\s+clean\b|\bfind\b.*\s-delete\b/i, 'deletes-files', 'Deletes files'],
  [/\b(curl|wget|ssh|scp|rsync|ftp|nc|telnet|http|https):?/i, 'network', 'Accesses the network'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bpoetry\s+add\b|\bcargo\s+(add|install)\b|\bgo\s+(get|install)\b|\bbrew\s+install\b|\bgem\s+install\b|\bnpx\s+/i, 'installs-dependencies', 'Installs or downloads packages'],
  [/\bgit\s+(reset\s+--hard|rebase|commit\s+--amend|push\s+(-f|--force)|checkout\s+--\s|restore\s|stash\s+(drop|clear)|branch\s+-D|filter-branch)\b/i, 'git-history', 'Rewrites or discards git history/changes'],
  [/\bgit\s+(push|pull|fetch|clone|remote\s+add)\b/i, 'git-remote', 'Talks to a git remote'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgh\s+(release|pr|issue)\s+create\b/i, 'publishes', 'Publishes to an external service'],
  [/\$\(|`/, 'shell-substitution', 'Uses command substitution'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b|\b(uvicorn|flask\s+run|rails\s+s|python\d?\s+-m\s+http\.server|nodemon|vite)\b/i, 'long-running', 'Starts a long-running process'],
  [/\bexport\s+\w+=|\bsetx?\s+\w+=/i, 'environment', 'Changes environment variables'],
];

/**
 * Assesses a shell command. `allowed: false` means it must not be offered for execution
 * at all; `allowed: true` still requires explicit user approval before running.
 */
export function assessCommand(raw: string, opts: { workspaceRoot?: string } = {}): CommandAssessment {
  const command = raw.trim();
  const reasons: string[] = [];
  const labels = new Set<RiskLabel>();

  if (!command) return { command, allowed: false, severity: 'high', labels: [], reasons: ['Empty command.'], segments: [] };
  if (command.length > MAX_LENGTH) {
    return { command, allowed: false, severity: 'high', labels: [], reasons: [`Command is longer than ${MAX_LENGTH} characters.`], segments: [] };
  }
  if (/[\r\n]/.test(command)) {
    return { command, allowed: false, severity: 'high', labels: [], reasons: ['Multi-line commands are not allowed; run one command at a time.'], segments: [] };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
    return { command, allowed: false, severity: 'high', labels: [], reasons: ['Command contains control characters.'], segments: [] };
  }

  const segments = splitSegments(command);
  const scan = [command, ...segments];
  for (const [re, why] of BLOCKS) {
    if (scan.some((s) => re.test(s))) reasons.push(why);
  }
  if (reasons.length) return { command, allowed: false, severity: 'high', labels: [], reasons, segments };

  for (const [re, label, why] of LABELS) {
    if (re.test(command)) {
      labels.add(label);
      reasons.push(why);
    }
  }

  // Absolute paths outside the workspace in redirects or as rm/mv/cp targets.
  const root = opts.workspaceRoot?.replace(/\/+$/, '');
  const pathTargets = [...command.matchAll(/(?:>>?|\b(?:rm|mv|cp|tee|touch|mkdir)\b(?:\s+-\w+)*)\s+("?)(\/[^\s"]+|~[^\s"]*)\1/g)].map((m) => m[2]!);
  for (const p of pathTargets) {
    if (p === '/dev/null') continue;
    if (!root || !(p === root || p.startsWith(`${root}/`))) {
      labels.add('writes-outside-workspace');
      reasons.push(`Writes outside the workspace (${p})`);
    }
  }

  const high: RiskLabel[] = ['deletes-files', 'git-history', 'publishes', 'writes-outside-workspace', 'shell-substitution'];
  const medium: RiskLabel[] = ['network', 'installs-dependencies', 'git-remote', 'environment'];
  const severity = [...labels].some((l) => high.includes(l)) ? 'high' : [...labels].some((l) => medium.includes(l)) ? 'medium' : 'low';
  return { command, allowed: true, severity, labels: [...labels], reasons, segments };
}

/** Splits on ; && || | outside quotes. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') {
        cur += ch + (command[++i] ?? '');
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Workspace-relative path guard for file-writing tools. */
export function isInsideWorkspace(root: string, target: string): boolean {
  const normRoot = normalizePath(root);
  const normTarget = normalizePath(target.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(target) ? target : `${root}/${target}`);
  return normTarget === normRoot || normTarget.startsWith(`${normRoot}/`);
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  const isAbs = p.startsWith('/');
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return (isAbs ? '/' : '') + parts.join('/');
}

/** Paths an agent must never write, even inside the workspace. */
export function isProtectedPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return /(^|\/)\.git(\/|$)|(^|\/)\.env(\.|$)|(^|\/)node_modules\/|\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519)/.test(p);
}
