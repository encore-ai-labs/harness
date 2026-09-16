/**
 * Decode iTerm2 OSC 1337 file transfers and (on macOS) an empty paste of a clipboard image.
 */
import { imageFromBytes, imageFromFile } from "./image.ts";
import type { UserImage } from "../provider/types.ts";

export async function clipboardImage(): Promise<UserImage | null> {
  if (process.platform !== "darwin") return null;
  const script = `
    try
      set pngData to the clipboard as «class PNGf»
      set tmp to (POSIX path of (path to temporary items from user domain)) & "harness-clip.png"
      set f to open for access (POSIX file tmp) with write permission
      set eof f to 0
      write pngData to f
      close access f
      return tmp
    on error
      return ""
    end try
  `;
  try {
    const r = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(r.stdout).text()).trim();
    const code = await r.exited;
    if (code !== 0 || !out) return null;
    return imageFromFile(out);
  } catch {
    return null;
  }
}

/** iTerm2 OSC 1337 File=name=...;size=N:BASE64 */
export function osc1337File(seq: string): UserImage | null {
  const m = /File=([^:]*):([A-Za-z0-9+/=\r\n]+)/.exec(seq);
  if (!m) return null;
  const meta = m[1] ?? "";
  const b64 = (m[2] ?? "").replace(/\s+/g, "");
  const nameRaw = /(?:^|;)name=([^;]*)/.exec(meta)?.[1];
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
  const filename = nameRaw ? decodeURIComponent(nameRaw.replace(/^["']|["']$/g, "")) : undefined;
  return imageFromBytes(bytes, filename);
}
