/**
 * A small shell command parser. Enough to split a command line into its
 * simple commands (across `&&`, `||`, `;`, `|`, newlines) and tokenize each
 * one honouring quotes, so policy can look at every program that would run.
 *
 * OpenCode uses tree-sitter for this; Codex has a full bash parser. Ours is
 * deliberately simple and fails closed: anything we cannot parse confidently
 * (subshells, backticks, process substitution, `eval`, `bash -c`) is reported
 * as `opaque`, and opaque commands are never auto-approved as read-only.
 */

export interface SimpleCommand {
  argv: string[];
  raw: string;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** true if the command contains constructs we do not parse (subshell, backticks, eval, redirections to files…) */
  opaque: boolean;
  reasons: string[];
}

export function parseShell(input: string): ParsedShell {
  const reasons: string[] = [];
  const src = input.trim();
  if (/\$\(|`|<\(|>\(/.test(src)) reasons.push("command substitution / process substitution");
  if (/(^|\s)(eval|exec|source|\.)\s/.test(src)) reasons.push("eval/exec/source");
  if (/(^|[\s;&|])(sh|bash|zsh|fish)\s+-[a-zA-Z]*c\b/.test(src)) reasons.push("nested shell -c");
  if (/(^|\s)>\s*[^&\s]/.test(src) || /\s>>\s*\S/.test(src) || /\d>\s*[^&\s]/.test(src))
    reasons.push("file redirection");

  // Split on operators outside quotes.
  const commands: SimpleCommand[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  const flush = () => {
    const raw = cur.trim();
    if (raw) commands.push({ raw, argv: tokenize(raw) });
    cur = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (q) {
      cur += ch;
      if (ch === q && src[i - 1] !== "\\") q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      cur += ch + next;
      i++;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      flush();
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      flush();
      continue;
    }
    if (ch === "&") {
      flush();
      reasons.push("background job");
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      reasons.push("grouping/subshell");
      cur += ch;
      continue;
    }
    cur += ch;
  }
  if (q) reasons.push("unterminated quote");
  flush();
  return { commands, opaque: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** Tokenize one simple command honouring quotes and backslashes; strips leading VAR=val assignments and `env`. */
export function tokenize(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (q) {
      if (ch === q) {
        q = null;
        continue;
      }
      if (ch === "\\" && q === '"' && i + 1 < raw.length) {
        cur += raw[++i];
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  // strip env assignments / env wrapper / sudo is NOT stripped (policy wants to see it)
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift();
  if (out[0] === "env") {
    out.shift();
    while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!)) out.shift();
  }
  return out;
}
