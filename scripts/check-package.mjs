import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage } from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = checkPackage(root);

if (problems.length) {
  console.error(`Package check failed (${problems.length}):\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Package check passed.");
}
