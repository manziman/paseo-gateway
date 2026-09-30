/** Executed inside the selected worker. Output is an HTTP status only, never credentials. */
export const installationTokenStatusScript = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const [method, path, revocableDigest, tokenFile] = process.argv.slice(1);
const token = fs.readFileSync(tokenFile);
// Bind destructive revocation to the exact newly minted token observed by the harness.
if (method === 'DELETE' && crypto.createHash('sha256').update(token).digest('hex') !== revocableDigest) process.exit(2);
fetch('https://api.github.com/' + path, {
  method,
  headers: {
    Authorization: 'Bearer ' + token.toString().trim(),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  },
  signal: AbortSignal.timeout(15000),
}).then(response => process.stdout.write(String(response.status))).catch(() => process.exit(1));
`;
