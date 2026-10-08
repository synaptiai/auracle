import { stat } from 'node:fs/promises';

/**
 * Why `dir` cannot be loaded as a directory of documents, or null when it can.
 *
 * A missing path and a file are both "not a directory". Any other failure
 * names its own code, so an unreadable parent is never reported as absent.
 */
export async function directoryFault(dir: string): Promise<string | null> {
  return stat(dir).then(
    (entry) => (entry.isDirectory() ? null : `${dir} is not a directory`),
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? `${dir} is not a directory`
      : `cannot read ${dir}: ${error.code ?? error.message}`),
  );
}
