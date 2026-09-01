import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const releaseDir = path.resolve('release');
const files = (await readdir(releaseDir)).filter((name) => name.endsWith('.exe')).sort();
if (!files.length) throw new Error('в release/ нет EXE-файлов');

const lines = [];
for (const name of files) {
  const hash = createHash('sha256').update(await readFile(path.join(releaseDir, name))).digest('hex');
  lines.push(`${hash}  ${name}`);
}

await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'ascii');
console.log(lines.join('\n'));
