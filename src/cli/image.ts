/**
 * Detect PNG/JPEG in paste bytes or on disk. Grok only accepts jpeg/png.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { UserImage } from "../provider/types.ts";

const MAX = 8 * 1024 * 1024;

export function sniffImage(bytes: Uint8Array): UserImage["mime"] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  return null;
}

export function imageFromBytes(bytes: Uint8Array, name?: string): UserImage | null {
  if (bytes.length > MAX) return null;
  const mime = sniffImage(bytes);
  if (!mime) return null;
  const ext = mime === "image/png" ? ".png" : ".jpg";
  return { mime, bytes, name: name ?? `paste${ext}` };
}

export function imageFromFile(path: string): UserImage | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const bytes = new Uint8Array(readFileSync(path));
    return imageFromBytes(bytes, basename(path));
  } catch {
    return null;
  }
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

/** Paths the user dropped or pasted as text. */
export function imagePathsIn(text: string): { rest: string; paths: string[] } {
  const paths: string[] = [];
  const rest = text
    .split(/\s+/)
    .filter((tok) => {
      const t = tok.replace(/^['"]|['"]$/g, "");
      if (IMAGE_EXT.has(extname(t).toLowerCase()) && existsSync(t)) {
        paths.push(t);
        return false;
      }
      return true;
    })
    .join(" ")
    .trim();
  return { rest, paths };
}

export function loadImages(paths: string[]): UserImage[] {
  const out: UserImage[] = [];
  for (const p of paths) {
    const img = imageFromFile(p);
    if (img) out.push(img);
  }
  return out;
}
