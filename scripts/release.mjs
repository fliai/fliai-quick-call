// Bump the app version everywhere, commit, tag and push. CI then builds and publishes the release.
// Usage: npm run release -- patch | minor | major | 1.2.3
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const read = (f) => readFileSync(f, "utf8");

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: npm run release -- patch | minor | major | 1.2.3");
  process.exit(1);
}
if (execSync("git status --porcelain").toString().trim()) {
  console.error("Commit or stash your changes first.");
  process.exit(1);
}

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const [major, minor, patch] = conf.version.split(".").map(Number);
const next = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
}[arg] ?? arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Not a version: ${next}`);
  process.exit(1);
}

const replace = (file, from, to) => {
  const before = read(file);
  const after = before.replace(from, to);
  if (after === before) throw new Error(`Version not found in ${file}`);
  writeFileSync(file, after);
};
replace("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${next}"`);
replace("package.json", /"version": "[^"]+"/, `"version": "${next}"`);
replace("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${next}"`);
replace("src-tauri/Cargo.lock", /(name = "fliai-quick-call"\nversion = )"[^"]+"/, `$1"${next}"`);
execSync("npm install --package-lock-only --silent");

run("git add src-tauri/tauri.conf.json package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
run(`git commit -m "Release v${next}"`);
run(`git tag v${next}`);
run("git push origin HEAD");
run(`git push origin v${next}`);
console.log(`\nv${next} pushed. Track the build under the repo's Actions tab; it publishes to https://cdn-quickcall.fliai.lk`);
