import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseReadiness } from "./lib.mjs";

// `node scripts/check-release.mjs v0.1.0`: the tag workflow runs it with the pushed tag. With no placeholder left the
// package is releasable; until then this fails on purpose.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2];

if (!tag) {
  console.error("Usage: node scripts/check-release.mjs v<version>");
  process.exitCode = 2;
} else {
  const problems = checkReleaseReadiness(root, tag);

  if (problems.length) {
    console.error(`Not ready to release ${tag} (${problems.length}):\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`${tag} is ready to release.`);
  }
}
