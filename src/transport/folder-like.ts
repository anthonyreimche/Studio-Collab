// The little of a folder the shared-folder transport needs, so it runs on a
// desktop folder handle in the app and on a real temp folder in the tests.

export interface FolderEntry {
  name: string;
  kind: "file" | "directory";
}

export interface FolderLike {
  list(): Promise<FolderEntry[]>;
  /** The subfolder `name`; null when it isn't there and `create` is false. */
  folder(name: string, create: boolean): Promise<FolderLike | null>;
  /** The file's text, or null when there is no such file. */
  readText(name: string): Promise<string | null>;
  writeText(name: string, text: string): Promise<void>;
}

const isMissing = (e: unknown): boolean =>
  e instanceof Error && (e.name === "NotFoundError" || /ENOENT|not found|no such file/i.test(e.message));

/** A FolderLike over a folder handle (`api.project.openKeptDirectory`). */
export function handleFolder(handle: FileSystemDirectoryHandle): FolderLike {
  return {
    async list() {
      const out: FolderEntry[] = [];
      for await (const entry of handle.values()) out.push({ name: entry.name, kind: entry.kind });
      return out;
    },
    async folder(name, create) {
      if (!create) {
        const found = (await this.list()).some((e) => e.name === name && e.kind === "directory");
        if (!found) return null;
      }
      return handleFolder(await handle.getDirectoryHandle(name, { create }));
    },
    async readText(name) {
      try {
        const file = await (await handle.getFileHandle(name)).getFile();
        return await file.text();
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async writeText(name, text) {
      const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
  };
}
