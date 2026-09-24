import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: node inventory-npm-licenses.mjs <node_modules directory> [...]");
  process.exit(2);
}

const packages = [];
function visit(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const manifest = entries.find((entry) => entry.name === "package.json" && entry.isFile());
  if (manifest) {
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (metadata.name && metadata.version) {
      packages.push({
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? null,
        path: directory,
        licenseFiles: entries
          .filter(
            (entry) =>
              entry.isFile() && /^(license|licence|notice|copying)(\.|$)/i.test(entry.name),
          )
          .map((entry) => entry.name)
          .sort(),
      });
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory()) visit(join(directory, entry.name));
  }
}

for (const root of roots) visit(root);
packages.sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify(packages, null, 2));
