/**
 * One writer per workspace. Two harness processes racing meta.json / state.json
 * fail with "session in use" instead of interleaving appends.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const held = new Set<WorkspaceLock>();
let exitHooked = false;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceLock {
  private constructor(readonly path: string) {}

  static acquire(cwd: string): WorkspaceLock {
    const dir = join(cwd, ".harness");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "lock");
    if (existsSync(path)) {
      let pid = 0;
      try {
        pid = Number.parseInt(readFileSync(path, "utf8").trim().split(/\s+/)[0] ?? "", 10);
      } catch {
        pid = 0;
      }
      if (alive(pid)) throw new Error("session in use");
      try {
        unlinkSync(path);
      } catch {
        /* raced */
      }
    }
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
    } catch {
      throw new Error("session in use");
    }
    const lock = new WorkspaceLock(path);
    held.add(lock);
    if (!exitHooked) {
      exitHooked = true;
      process.once("exit", () => {
        for (const l of held) l.release();
      });
    }
    return lock;
  }

  release() {
    held.delete(this);
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone */
    }
  }
}
