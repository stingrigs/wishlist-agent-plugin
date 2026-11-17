import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractLinks, isOwnRepositoryUrl, isPlaceholder, manifestUrls, relativeLinkProblems } from "./lib.mjs";
import { packagesOf, readSource } from "./manifests.mjs";

// Every link of the README of each package and every policy or homepage URL of the manifests answers (the pages a reader of the plugin opens). Placeholders cannot answer and are listed, not fetched: the release check is what
// refuses them. Relative links must exist. A network failure of a real link fails the run (retried twice).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readSource(root);
const folders = packagesOf(source).map((pack) => join(root, pack.dir));
const found = folders.map((folder) => ({ folder, links: extractLinks(readFileSync(join(folder, "README.md"), "utf8")) }));
const links = { external: [...new Set(found.flatMap((entry) => entry.links.external))], relative: found.flatMap((entry) => entry.links.relative) };
const problems = found.flatMap((entry) => relativeLinkProblems(entry.folder, entry.links.relative));

async function answers(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "wishlist-agent-plugin-link-check" },
      });
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 429) return false;
    } catch {
      // try again
    }
  }
  return false;
}

// The repository's own addresses are listed, not fetched: they point at files of the default branch (`blob/main/...`) that a
// change not yet pushed may not have put there yet. The release check fetches nothing.
const repository = source.repository;

for (const url of new Set([...links.external, ...manifestUrls(root)])) {
  if (isOwnRepositoryUrl(url, repository)) {
    console.log(`skipped (own repository address; the file it names may not be on the default branch yet): ${url}`);
    continue;
  }
  if (isPlaceholder(url)) {
    console.log(`skipped placeholder: ${url}`);
  } else if (!(await answers(url))) {
    problems.push(`${url} does not answer`);
  }
}

if (problems.length) {
  console.error(`Link check failed:\n- ${problems.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Link check passed (${links.external.length} external in the README, ${manifestUrls(root).length} in the manifests, ${links.relative.length} relative).`);
}
