/** Exact unified-diff application: no shell, offsets, fuzz, renames or implicit paths. */
export function applyUnifiedDiff(original: string | null, diff: string, path: string): string | null {
  const normalizedPath = path.replaceAll('\\', '/');
  const lines = diff.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0]?.startsWith('diff --git ')) {
    if (lines.shift() !== `diff --git a/${normalizedPath} b/${normalizedPath}`) throw new Error('Diff path does not match its target.');
    if (lines[0]?.startsWith('index ')) lines.shift();
  }
  const before = lines.shift();
  const after = lines.shift();
  const creating = before === '--- /dev/null';
  const deleting = after === '+++ /dev/null';
  if ((!creating && before !== `--- a/${normalizedPath}` && before !== `--- ${normalizedPath}`)
    || (!deleting && after !== `+++ b/${normalizedPath}` && after !== `+++ ${normalizedPath}`)
    || (creating && deleting) || creating !== (original === null)) throw new Error('Diff headers do not match the reviewed file.');
  const eol = original?.includes('\r\n') ? '\r\n' : '\n';
  const source = original === null || original === '' ? [] : original.replaceAll('\r\n', '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output: string[] = [];
  let cursor = 0;
  let index = 0;
  let hunks = 0;
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[index++]);
    if (!header) throw new Error('A valid unified-diff hunk header is required.');
    hunks++;
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    const start = Number(header[1]) - (oldCount === 0 ? 0 : 1);
    const newStart = Number(header[3]) - (newCount === 0 ? 0 : 1);
    if (start < cursor || start > source.length) throw new Error('Diff hunk is outside the target file.');
    output.push(...source.slice(cursor, start));
    cursor = start;
    if (newStart !== output.length) throw new Error('Diff hunk positions are inconsistent.');
    let removed = 0;
    let added = 0;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index++];
      const prefix = line[0];
      if (![' ', '+', '-'].includes(prefix)) throw new Error('Unexpected content in patch.');
      let text = line.slice(1) + '\n';
      if (lines[index] === '\\ No newline at end of file') { text = text.slice(0, -1); index++; }
      if (prefix !== '+') {
        if (source[cursor++] !== text) throw new Error('Patch context no longer matches the file.');
        removed++;
      }
      if (prefix !== '-') { output.push(text); added++; }
    }
    if (removed !== oldCount || added !== newCount) throw new Error('Diff hunk line counts do not match.');
  }
  if (!hunks) throw new Error('The patch contains no hunks.');
  output.push(...source.slice(cursor));
  if (deleting && output.length) throw new Error('A deletion must remove the complete file.');
  return deleting ? null : output.join('').replaceAll('\n', eol);
}
