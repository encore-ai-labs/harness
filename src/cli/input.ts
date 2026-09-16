/**
 * Line editor with image paste. Cmd+V of a screenshot is an empty paste on
 * most macOS terminals; we then read the clipboard. iTerm2 OSC 1337 file
 * transfers and PNG/JPEG bytes in a bracketed paste are also accepted.
 */
import { stdin as input, stdout as output } from "node:process";
import { clipboardImage, osc1337File } from "./clipboard.ts";
import { imageFromBytes, imagePathsIn, loadImages } from "./image.ts";
import { c, out } from "./render.ts";
import type { UserImage } from "../provider/types.ts";

export interface TurnInput {
  text: string;
  images: UserImage[];
}

export class LineEditor {
  private buf = "";
  private images: UserImage[] = [];
  private raw = false;
  private visible = false;
  private busy = false;
  private lastRows = 1;
  private waiters: Array<(v: TurnInput | { eof: true } | { interrupt: true }) => void> = [];
  private paste = false;
  private pasteBuf = Buffer.alloc(0);
  private osc = "";
  private inOsc = false;

  constructor(private prompt = c.cyan("› ")) {}

  setBusy(v: boolean) {
    this.busy = v;
    if (!v) this.redraw();
    else if (!this.buf && !this.images.length) this.hide();
  }

  hide() {
    if (!this.visible || !output.isTTY) return;
    // \r+2K only clears the cursor's row. A wrapped prompt occupies several
    // rows; leaving those in place makes the next redraw stack copies of the
    // buffer (the screenshot bug).
    out("\r\x1b[2K");
    for (let i = 1; i < this.lastRows; i++) out("\x1b[1A\x1b[2K");
    out("\x1b[J");
    this.visible = false;
    this.lastRows = 1;
  }

  redraw() {
    if (!input.isTTY) return;
    if (this.busy && !this.buf && !this.images.length) {
      this.hide();
      return;
    }
    this.hide();
    const hint = this.images.length
      ? c.dim(` [${this.images.map((i) => i.name ?? "image").join(", ")}]`)
      : "";
    const rendered = this.prompt + this.buf + hint;
    out(rendered);
    this.lastRows = displayRows(rendered, output.columns ?? 80);
    this.visible = true;
  }

  start() {
    if (!input.isTTY || this.raw) return;
    input.setRawMode?.(true);
    input.resume();
    input.on("data", this.onData);
    this.raw = true;
    // bracketed paste
    out("\x1b[?2004h");
  }

  stop() {
    if (!this.raw) return;
    out("\x1b[?2004l");
    input.off("data", this.onData);
    try {
      input.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    this.raw = false;
    this.hide();
  }

  line(): Promise<TurnInput | { eof: true } | { interrupt: true }> {
    this.redraw();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private finish(v: TurnInput | { eof: true } | { interrupt: true }) {
    const w = this.waiters.shift();
    if (w) w(v);
  }

  private onData = (chunk: Buffer) => {
    void this.handle(chunk);
  };

  private async handle(chunk: Buffer) {
    let i = 0;
    while (i < chunk.length) {
      if (this.paste) {
        const end = chunk.indexOf("\x1b[201~", i);
        if (end < 0) {
          this.pasteBuf = Buffer.concat([this.pasteBuf, chunk.subarray(i)]);
          return;
        }
        this.pasteBuf = Buffer.concat([this.pasteBuf, chunk.subarray(i, end)]);
        await this.endPaste();
        i = end + 6;
        this.paste = false;
        continue;
      }
      if (this.inOsc) {
        const rest = chunk.subarray(i);
        const text = rest.toString("utf8");
        const bel = text.indexOf("\x07");
        const st = text.indexOf("\x1b\\");
        const cut = bel >= 0 ? bel : st >= 0 ? st : -1;
        if (cut < 0) {
          this.osc += text;
          return;
        }
        this.osc += text.slice(0, cut);
        const img = osc1337File(this.osc);
        if (img) this.images.push(img);
        this.osc = "";
        this.inOsc = false;
        i += cut + (bel >= 0 ? 1 : 2);
        this.redraw();
        continue;
      }
      const b = chunk[i]!;
      // ESC
      if (b === 0x1b) {
        const rest = chunk.subarray(i).toString("utf8");
        if (rest.startsWith("\x1b[200~")) {
          this.paste = true;
          this.pasteBuf = Buffer.alloc(0);
          i += 6;
          continue;
        }
        if (rest.startsWith("\x1b]1337;")) {
          this.inOsc = true;
          this.osc = "";
          i += 2;
          continue;
        }
        // skip other CSI
        if (rest.startsWith("\x1b[")) {
          let j = 2;
          while (j < rest.length && "0123456789;?".includes(rest[j]!)) j++;
          i += j < rest.length ? j + 1 : 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (b === 3) {
        // ctrl-c
        this.buf = "";
        this.images = [];
        this.hide();
        this.finish({ interrupt: true });
        i++;
        continue;
      }
      if (b === 4) {
        if (!this.buf && !this.images.length) this.finish({ eof: true });
        i++;
        continue;
      }
      if (b === 13 || b === 10) {
        await this.submit();
        i++;
        continue;
      }
      if (b === 127 || b === 8) {
        this.buf = this.buf.slice(0, -1);
        this.redraw();
        i++;
        continue;
      }
      if (b === 21) {
        this.buf = "";
        this.redraw();
        i++;
        continue;
      }
      if (b < 32) {
        i++;
        continue;
      }
      // utf8 run
      const start = i;
      i++;
      while (i < chunk.length && (chunk[i]! & 0xc0) === 0x80) i++;
      this.buf += chunk.subarray(start, i).toString("utf8");
      this.redraw();
    }
  }

  private async endPaste() {
    const bytes = this.pasteBuf;
    this.pasteBuf = Buffer.alloc(0);
    const img = imageFromBytes(bytes);
    if (img) {
      this.images.push(img);
      this.redraw();
      return;
    }
    const text = bytes.toString("utf8");
    if (!text.trim()) {
      const clip = await clipboardImage();
      if (clip) this.images.push(clip);
      this.redraw();
      return;
    }
    this.buf += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.redraw();
  }

  private async submit() {
    const { rest, paths } = imagePathsIn(this.buf);
    const fromPaths = loadImages(paths);
    const images = [...this.images, ...fromPaths];
    const text = rest;
    this.buf = "";
    this.images = [];
    this.hide();
    this.finish({ text, images });
  }
}

/** Columns of `s` ignoring CSI color sequences. */
export function visibleWidth(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x1b) {
      i++;
      if (s[i] === "[") {
        i++;
        while (i < s.length && s[i] !== "m") i++;
      }
      continue;
    }
    if (s[i] === "\n") continue;
    n++;
  }
  return n;
}

/** Rows a string occupies in a `cols`-wide terminal, including wrap. */
export function displayRows(s: string, cols: number): number {
  const width = Math.max(1, cols);
  let rows = 0;
  const lines = s.split("\n");
  for (const line of lines) {
    const w = visibleWidth(line);
    rows += Math.max(1, Math.ceil(w / width));
  }
  return Math.max(1, rows);
}

/** Non-TTY fallback: one stdin line, plus image paths in the text. */
export async function readPlainLine(): Promise<TurnInput | { eof: true }> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input, output, terminal: false });
  const line = await new Promise<string | null>((resolve) => {
    rl.once("line", (l) => resolve(l));
    rl.once("close", () => resolve(null));
  });
  rl.close();
  if (line === null) return { eof: true };
  const { rest, paths } = imagePathsIn(line);
  return { text: rest, images: loadImages(paths) };
}
