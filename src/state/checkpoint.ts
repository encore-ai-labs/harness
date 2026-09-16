/**
 * Checkpoints via a shadow git repository.
 *
 * Why: for long-horizon work, "restart from a trustworthy checkpoint" beats
 * "replay the entire task". We keep a second git repo whose .git dir lives at
 * .harness/shadow.git and whose work tree is the project. It never touches the
 * user's own repo, index, or branches. After every turn that changed files we
 * commit a snapshot; `rewind` restores one.
 *
 * The shadow repo honours the project's .gitignore (git reads it from the work
 * tree) plus its own excludes for .harness/ and common junk.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXCLUDES = [
  ".harness/",
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".DS_Store",
  "*.log",
  ".venv/",
  "__pycache__/",
  "target/",
];

export class Checkpoints {
  readonly gitDir: string;
  private ready = false;

  constructor(readonly cwd: string) {
    this.gitDir = join(cwd, ".harness", "shadow.git");
  }

  private async git(
    args: string[],
    opts: { allowFail?: boolean } = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(
      ["git", `--git-dir=${this.gitDir}`, `--work-tree=${this.cwd}`, ...args],
      {
        cwd: this.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "harness",
          GIT_AUTHOR_EMAIL: "harness@local",
          GIT_COMMITTER_NAME: "harness",
          GIT_COMMITTER_EMAIL: "harness@local",
        },
      },
    );
    const [out, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    if (code !== 0 && !opts.allowFail)
      throw new Error(`git ${args[0]} failed (${code}): ${errText.trim() || out.trim()}`);
    return { code, out, err: errText };
  }

  async init(): Promise<void> {
    if (this.ready) return;
    if (!existsSync(this.gitDir)) {
      mkdirSync(join(this.cwd, ".harness"), { recursive: true });
      await this.git(["init", "-q"]);
    }
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), EXCLUDES.join("\n") + "\n");
    this.ready = true;
  }

  /** Are there changes since the last checkpoint? */
  async dirty(): Promise<boolean> {
    await this.init();
    const { out } = await this.git(["status", "--porcelain", "--untracked-files=all"]);
    return out.trim().length > 0;
  }

  /** Commit the current work tree. Returns null if nothing changed. */
  async snapshot(label: string): Promise<{ sha: string; files: number } | null> {
    await this.init();
    await this.git(["add", "-A"]);
    const status = await this.git(["status", "--porcelain"]);
    const files = status.out.split("\n").filter(Boolean).length;
    if (files === 0) {
      // Still create an initial commit so `rewind` to "start" is possible.
      const has = await this.git(["rev-parse", "--verify", "HEAD"], { allowFail: true });
      if (has.code === 0) return null;
    }
    await this.git(["commit", "-q", "--allow-empty", "-m", label]);
    const sha = (await this.git(["rev-parse", "--short", "HEAD"])).out.trim();
    return { sha, files };
  }

  /** List checkpoints newest first. */
  async list(): Promise<Array<{ sha: string; label: string; ts: string }>> {
    await this.init();
    const r = await this.git(["log", "--format=%h%x1f%s%x1f%cI"], { allowFail: true });
    if (r.code !== 0) return [];
    return r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha = "", label = "", ts = ""] = l.split("\x1f");
        return { sha, label, ts };
      });
  }

  /** Restore the work tree to a checkpoint. Files created after it are removed. */
  async rewind(sha: string): Promise<void> {
    await this.init();
    await this.git(["reset", "-q", "--hard", sha]);
    await this.git(["clean", "-qfd"]);
  }

  /** Diff between a checkpoint and now (or between two checkpoints). */
  async diff(from: string, to = ""): Promise<string> {
    await this.init();
    await this.git(["add", "-A", "--intent-to-add"], { allowFail: true });
    const args = to ? ["diff", from, to] : ["diff", from];
    return (await this.git(args, { allowFail: true })).out;
  }

  async changedFiles(from: string): Promise<string[]> {
    await this.init();
    await this.git(["add", "-A", "--intent-to-add"], { allowFail: true });
    const r = await this.git(["diff", "--name-status", from], { allowFail: true });
    return r.out.split("\n").filter(Boolean);
  }
}
