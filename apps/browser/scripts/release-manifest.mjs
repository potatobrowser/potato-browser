// Writes release/latest.json, release/SHA256SUMS and release/notes.md for the DMGs in release/.
// The release workflow attaches all three to the GitHub Release; potatobrowser.com reads latest.json.
// Usage: node scripts/release-manifest.mjs [--commit <sha>]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(root, '../..');
const out = path.join(root, 'release');
const args = process.argv.slice(2);
const commitIdx = args.indexOf('--commit');
const commit = commitIdx >= 0 ? args[commitIdx + 1] : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = process.env.GITHUB_REPOSITORY || 'potatobrowser/potato-browser';
const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
const run = process.env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : `${server}/${repo}/actions/workflows/release.yml`;

/** The CHANGELOG.md section for this version, without its heading. */
function changelogSection() {
  const text = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(l));
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

const files = {};
const sizes = {};
const sha256 = {};
for (const arch of ['arm64', 'x64']) {
  const name = `Potato-Browser-${version}-${arch}.dmg`;
  const file = path.join(out, name);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const buf = fs.readFileSync(file);
  files[arch] = name;
  sizes[arch] = buf.length;
  sha256[arch] = crypto.createHash('sha256').update(buf).digest('hex');
}

const section = changelogSection();
const notes = section
  .split('\n')
  .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
  .filter(Boolean)
  .join(' ');
const manifest = { version, date: new Date().toISOString().slice(0, 10), notes, commit, files, sizes, sha256 };

fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'SHA256SUMS'), ['arm64', 'x64'].map((a) => `${sha256[a]}  ${files[a]}`).join('\n') + '\n');
fs.writeFileSync(
  path.join(out, 'notes.md'),
  `${section}

### Verify this download

Built in public by [this workflow run](${run}) from commit ${commit}.

\`\`\`sh
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify Potato-Browser-${version}-arm64.dmg --repo ${repo}
\`\`\`
`,
);
console.log(JSON.stringify(manifest, null, 2));
