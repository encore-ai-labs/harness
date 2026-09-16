/**
 * macOS seatbelt sandbox for bash, modelled on Codex's generated profile.
 *
 * Why: in `auto` mode the model runs commands without a human looking at each
 * one. The sandbox makes the blast radius structural: no network, writes only
 * inside the workspace and tmp, and the project's .git is read-only so a stray
 * command cannot rewrite history. If the command needs more, it fails with a
 * sandbox error, the model sees that, and can ask for escalation, which is a
 * human decision.
 *
 * `sandbox-exec` is deprecated by Apple but still present and still what Codex
 * and Chrome use. On non-macOS we run without a sandbox and say so in the trace.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface SandboxSpec {
  cwd: string;
  writableRoots: string[];
  network: boolean;
}

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
}

/** Build the SBPL profile + the argv prefix. */
export function seatbeltCommand(
  spec: SandboxSpec,
  argv: string[],
): { argv: string[]; profile: string } {
  const roots = [
    resolve(spec.cwd),
    "/tmp",
    "/private/tmp",
    resolve(tmpdir()),
    ...spec.writableRoots.map((r) => resolve(r)),
  ];
  const params: string[] = [];
  const writeClauses: string[] = [];
  roots.forEach((r, i) => {
    params.push(`-DWRITABLE_ROOT_${i}=${r}`);
    if (i === 0) {
      // Workspace: writable except its .git (history) and .harness (harness-owned state).
      writeClauses.push(
        `(require-all (subpath (param "WRITABLE_ROOT_0")) (require-not (subpath (string-append (param "WRITABLE_ROOT_0") "/.git"))) (require-not (subpath (string-append (param "WRITABLE_ROOT_0") "/.harness"))))`,
      );
    } else {
      writeClauses.push(`(subpath (param "WRITABLE_ROOT_${i}"))`);
    }
  });

  const profile = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix*)",
    "(allow pseudo-tty)",
    "(allow file-read*)",
    '(allow file-ioctl (literal "/dev/tty") (regex #"^/dev/ttys"))',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys") (literal "/dev/dtracehelper"))',
    `(allow file-write* ${writeClauses.join(" ")})`,
    '(allow file-write* (subpath "/private/var/folders"))', // per-user caches many tools need
    '(allow file-write* (regex #"^/dev/fd/"))',
    spec.network
      ? "(allow network*)\n(allow system-socket)"
      : "(deny network*)\n(allow network* (local unix-socket) (remote unix-socket))", // unix sockets for local tooling
  ].join("\n");

  return { argv: ["/usr/bin/sandbox-exec", "-p", profile, ...params, "--", ...argv], profile };
}

/** Does this stderr/stdout look like the sandbox blocked something? */
export function looksLikeSandboxDenial(output: string): boolean {
  return /operation not permitted|sandbox|EPERM|not permitted|could not resolve host|ENETUNREACH|network is unreachable|Could not connect|getaddrinfo/i.test(
    output,
  );
}

export function tmpPathFor(name: string): string {
  return join(tmpdir(), `harness-${name}`);
}
