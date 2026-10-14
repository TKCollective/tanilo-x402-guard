// Installs @x402/core and @x402/fetch at each version below into test/compat/<version>/ and runs
// x402.compat.mjs against each. usage: npm run test:x402
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSIONS = process.argv.slice(2).length ? process.argv.slice(2) : ["2.19.0", "2.28.0"];
let failed = 0;
for (const v of VERSIONS) {
  const dir = path.join(HERE, v);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ private: true, dependencies: { "@x402/core": v, "@x402/fetch": v } }, null, 2) + "\n");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent"], { cwd: dir, stdio: "inherit" });
  console.log(`\n=== @x402/core ${v}`);
  try {
    execFileSync(process.execPath, ["--test", path.join(HERE, "x402.compat.mjs")], { stdio: "inherit", env: { ...process.env, X402_DIR: path.join(dir, "node_modules") } });
  } catch { failed++; }
}
process.exit(failed ? 1 : 0);
