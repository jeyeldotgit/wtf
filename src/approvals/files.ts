import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSafeProjectRelativePath } from '../agents/schemas.js';

export const hashContent = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export type FileSnapshot = { path: string; hash: string | null };

/** Reject aliases, symlinks, special files and hard links before reading or writing. */
export function readTarget(root: string, path: string): { absolute: string; content: Buffer | null } {
  if (!isSafeProjectRelativePath(path) || /[:<>"|?*]/.test(path)
    || path.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('The proposal contains an unsafe target path.');
  }
  const canonicalRoot = realpathSync(root);
  const absolute = resolve(canonicalRoot, path.replaceAll('\\', '/'));
  const rel = relative(canonicalRoot, absolute);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Target is outside the project.');
  const parts = rel.split(sep);
  let current = canonicalRoot;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && i === parts.length - 1) return { absolute, content: null };
      throw new Error('The target parent directory is unavailable.');
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Symlinks, hard links and special files cannot be patched.');
    }
    if (i === parts.length - 1 && stat.size > 1_000_000) throw new Error('The target exceeds the patch size limit.');
  }
  const content = readFileSync(absolute);
  if (content.includes(0) || !Buffer.from(content.toString('utf8')).equals(content)) throw new Error('Only UTF-8 text files can be patched.');
  return { absolute, content };
}

export function snapshotFiles(root: string, files: { path: string }[]): FileSnapshot[] {
  const seen = new Set<string>();
  return files.map(file => {
    const target = readTarget(root, file.path);
    const key = process.platform === 'win32' ? target.absolute.toLowerCase() : target.absolute;
    if (seen.has(key)) throw new Error('A file appears more than once in the proposal.');
    seen.add(key);
    return { path: file.path, hash: target.content === null ? null : hashContent(target.content) };
  });
}
