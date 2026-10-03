import { chmod } from "node:fs/promises";

/** Restrict an existing private file or directory to the current user. */
export async function securePrivatePath(path: string, directory: boolean): Promise<void> {
  await chmod(path, directory ? 0o700 : 0o600);
}
