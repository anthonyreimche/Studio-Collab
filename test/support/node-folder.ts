// A FolderLike over a real folder on disk, for the folder transport's tests,
// counting reads so a test can see what a poll touched.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FolderEntry, FolderLike } from "../../src/transport/folder-like";

export interface CountingFolder extends FolderLike {
  reads: string[];
}

export function nodeFolder(path: string, reads: string[] = []): CountingFolder {
  return {
    reads,
    async list(): Promise<FolderEntry[]> {
      try {
        return readdirSync(path, { withFileTypes: true }).map((e) => ({
          name: e.name,
          kind: e.isDirectory() ? "directory" : "file",
        }));
      } catch {
        return [];
      }
    },
    async folder(name, create) {
      const child = join(path, name);
      if (create) mkdirSync(child, { recursive: true });
      else if (!statSync(child, { throwIfNoEntry: false })?.isDirectory()) return null;
      return nodeFolder(child, reads);
    },
    async readText(name) {
      const file = join(path, name);
      reads.push(file);
      try {
        return readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    async writeText(name, text) {
      writeFileSync(join(path, name), text);
    },
  };
}
