import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPackage, formIconPath, isPlaceholder, mcpAuthProblems, secretsIn } from "./lib.mjs";
import { forOpenAi, instagramPattern } from "./openai-variant.mjs";
import { manifestText, readSource, zipMcpManifest } from "./manifests.mjs";
import { readZip, writeZip } from "./zip.mjs";

// `pnpm package:chatgpt` builds the ZIP for OpenAI's developer portal (the «With MCP» route of
// developers.openai.com/plugins/deploy/submission) and the small icon of ChatGPT's custom-server form, both from the same
// sources as everything else: the payload `plugin/`. Nothing is committed (`dist/` is ignored) and nothing secret goes in.
//
// The ZIP is the portable layout: `plugin.json`, `mcp.json`, `skills/`, `assets/`, the README and the LICENSE, at the archive root.
// The Claude files (`.claude-plugin/`, `.mcp.json`) and the Codex overlay (`.codex-plugin/`) are left out on purpose: OpenAI reads
// the root `plugin.json`, and «when extensions.com.openai is an object, it replaces the entire .codex-plugin/plugin.json overlay».
// The ZIP carries a shorter variant of the photo skill (`scripts/openai-variant.mjs`); the full skill stays in `plugin/skills/`.
// The ZIP's `mcp.json` also carries the server's `extensions["com.openai"].auth` (OAuth, CIMD, the scopes): OpenAI's portal reads
// the authentication from the `mcp.json` it is given, while the committed `plugin/mcp.json` stays clean against the closed Agent Plugins schema.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The limits of OpenAI's «Archive errors» table (developers.openai.com/plugins/reference/package-validation) and its listing rules.
export const limits = {
  compressedBytes: 100 * 1000 * 1000, // «Compressed ZIP must be 100 MB or less.»
  entries: 5000, // «Archive must not contain more than 5,000 entries.»
  memberBytes: 100 * 1024 * 1024, // «Archive entry must not exceed 100 MiB.»
  uncompressedBytes: 512 * 1024 * 1024, // «Extracted archive must not exceed 512 MiB.»
  pathSegments: 20, // «at most 20 segments, including the filename»
  imageBytes: 5 * 1024 * 1024, // «at most 5 MiB each»
  imageMinPixels: 48, // «square and at least 48 by 48 pixels»
  imageMaxPixels: 4096, // «at most 4096 pixels in either dimension»
};

const included = [/^plugin\.json$/u, /^mcp\.json$/u, /^README\.md$/u, /^LICENSE$/u, /^assets\/[^/]+$/u, /^skills\/.+$/u];

/** The files of the payload that go into the ZIP, as `[{ name, bytes }]`. The ZIP's `mcp.json` is the committed one plus the OpenAI `auth` block (`zipMcpManifest`). */
export function zipEntries(repository = root) {
  const folder = join(repository, "plugin");
  const entries = [];

  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = path.slice(folder.length + 1).split("\\").join("/");

    if (included.some((pattern) => pattern.test(name)) && !lstatSync(path).isSymbolicLink()) entries.push({ name, bytes: readFileSync(path) });
  }
  for (const entry of entries) {
    if (/^skills\/[^/]+\/SKILL\.md$/u.test(entry.name)) entry.bytes = Buffer.from(forOpenAi(entry.name, entry.bytes.toString("utf8")));
  }
  const mcp = entries.find((entry) => entry.name === "mcp.json");

  if (mcp) mcp.bytes = Buffer.from(manifestText(zipMcpManifest(readSource(repository))));
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** PNG, JPEG or WebP by the signature of the first bytes. */
export function isImage(bytes) {
  const head = Buffer.from(bytes.subarray?.(0, 12) ?? []);

  return (
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) ||
    (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP")
  );
}

function pngSize(bytes) {
  const isPng = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.toString("latin1", 12, 16) === "IHDR";

  return isPng ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

/** The rules of OpenAI's archive and manifest validation, applied to the entries before anything is written (empty = a ZIP the portal takes). */
export function archiveProblems(entries) {
  const problems = [];
  const names = new Map();
  let total = 0;

  if (entries.length === 0) problems.push("the archive is empty");
  if (entries.length > limits.entries) problems.push(`the archive has ${entries.length} entries: at most ${limits.entries}`);
  for (const { name, bytes } of entries) {
    const segments = name.split("/");

    total += bytes.length;
    if (name === "") problems.push("an entry has an empty path");
    if (name !== name.trim()) problems.push(`${JSON.stringify(name)}: the path begins or ends with whitespace`);
    if (name.includes("\\")) problems.push(`${name}: the path uses a backslash`);
    if (name.startsWith("/")) problems.push(`${name}: the path is absolute`);
    if (segments.some((segment) => segment === "")) problems.push(`${name}: the path has an empty segment`);
    if (segments.includes("..")) problems.push(`${name}: the path has a .. segment`);
    if (segments.length > limits.pathSegments) problems.push(`${name}: the path has ${segments.length} segments, at most ${limits.pathSegments}`);
    if (bytes.length > limits.memberBytes) problems.push(`${name}: the entry is over 100 MiB`);
    if (segments.some((segment) => segment === ".DS_Store" || segment === "__MACOSX" || segment.startsWith("._"))) problems.push(`${name}: a file the operating system added, not part of the plugin`);
    const key = name.normalize("NFC").toLowerCase();

    if (names.has(key)) problems.push(`${name}: the path is a duplicate of ${names.get(key)} after case and Unicode normalization`);
    names.set(key, name);
    // An image is told by its first bytes, never by its name: a text file called icon.png is scanned like any other.
    const image = isImage(bytes);

    if (instagramPattern.test(name) || (!image && instagramPattern.test(bytes.toString("utf8")))) {
      problems.push(`${name}: names Instagram, which the ZIP variant leaves out`);
    }
    if (!image && secretsIn(bytes.toString("utf8")).length > 0) {
      problems.push(`${name}: looks like it holds ${secretsIn(bytes.toString("utf8")).join(", ")} (a credential or secret)`);
    }
  }
  if (total > limits.uncompressedBytes) problems.push(`the extracted archive is ${total} bytes: at most 512 MiB`);

  const file = (name) => entries.find((entry) => entry.name === name);
  const manifest = file("plugin.json");

  if (!manifest) problems.push("plugin.json is missing at the archive root: the ZIP needs exactly one plugin root, and it is the root");
  if (entries.some((entry) => /^[^/]+\/plugin\.json$/u.test(entry.name))) problems.push("a plugin.json in a folder beside the root one makes the plugin root ambiguous");
  if (!entries.some((entry) => /^skills\/[^/]+\/SKILL\.md$/u.test(entry.name))) problems.push("the archive has no skill (skills/<name>/SKILL.md): a ZIP needs a manifest and at least one valid skill");

  const mcp = file("mcp.json");

  if (!mcp) problems.push("mcp.json is missing at the archive root");
  else {
    let parsed;

    try {
      parsed = JSON.parse(mcp.bytes.toString("utf8"));
    } catch {
      problems.push("mcp.json is not valid JSON");
    }
    const servers = Object.values(parsed?.mcpServers ?? {});

    if (parsed && servers.length !== 1) problems.push(`mcp.json must declare exactly one server, not ${servers.length}`);
    for (const server of servers) mcpAuthProblems(server, problems);
  }
  if (manifest) {
    let parsed;

    try {
      parsed = JSON.parse(manifest.bytes.toString("utf8"));
    } catch {
      problems.push("plugin.json is not valid JSON");
    }
    const openai = parsed?.extensions?.["com.openai"];
    const text = manifest.bytes.toString("utf8");

    if (/test_credentials|reviewer_instructions/u.test(text)) problems.push("plugin.json carries test_credentials or reviewer_instructions: the portal rejects them");
    for (const key of ["logo", "composerIcon"]) {
      const path = openai?.interface?.[key];
      const image = typeof path === "string" ? file(path.replace(/^\.\//u, "")) : undefined;
      const size = image ? pngSize(image.bytes) : null;

      if (!image) problems.push(`plugin.json interface.${key} names ${JSON.stringify(path)}, which is not in the archive`);
      else if (!size) problems.push(`${image.name} is not a PNG file`);
      else {
        if (size.width !== size.height || size.width < limits.imageMinPixels || size.width > limits.imageMaxPixels) problems.push(`${image.name} must be square, ${limits.imageMinPixels} to ${limits.imageMaxPixels} px (it is ${size.width}x${size.height})`);
        if (image.bytes.length > limits.imageBytes) problems.push(`${image.name} is over 5 MiB`);
      }
    }
  }
  return problems;
}

/** The size rule for the finished ZIP. */
export function compressedProblems(zip) {
  return zip.length > limits.compressedBytes ? [`the ZIP is ${zip.length} bytes: at most 100 MB`] : [];
}

/** Builds both outputs from the payload; `{ zip, icon, entries, warnings }`. Throws with the list when a rule is broken. */
export function build(repository = root) {
  const base = checkPackage(repository);

  if (base.length > 0) throw new Error(`the package check fails, so nothing is built:\n- ${base.join("\n- ")}`);
  const entries = zipEntries(repository);
  const problems = archiveProblems(entries);

  if (problems.length > 0) throw new Error(`the archive breaks OpenAI's rules:\n- ${problems.join("\n- ")}`);
  const zip = writeZip(entries);
  const sizeProblems = compressedProblems(zip);

  if (sizeProblems.length > 0) throw new Error(sizeProblems.join("\n"));
  const placeholders = [...new Set(entries.flatMap(({ name, bytes }) => (/\.(?:png|jpe?g|webp)$/iu.test(name) ? [] : (bytes.toString("utf8").match(/[^\s",`)(]+/gu) ?? []).filter(isPlaceholder))))];
  const icon = { size: 256, bytes: readFileSync(join(repository, formIconPath)) }; // the committed icon: the package check has judged its size and content

  return {
    zip,
    icon,
    entries,
    warnings: placeholders.length > 0 ? [`the ZIP still holds placeholders (${placeholders.join(", ")}): replace them with the real pages before the ZIP is uploaded`] : [],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { zip, icon, entries, warnings } = build();
  const version = readSource(root).version;
  const out = join(root, "dist");

  mkdirSync(out, { recursive: true });
  const zipPath = join(out, `wishlist-chatgpt-${version}.zip`);
  const iconPath = join(out, "wishlist-chatgpt-form-icon.png");

  readZip(zip); // a ZIP that cannot be read back is not written to be uploaded
  writeFileSync(zipPath, zip);
  writeFileSync(iconPath, icon.bytes);
  console.log(`wrote ${zipPath}: ${entries.length} entries, ${zip.length} bytes`);
  console.log(`wrote ${iconPath}: ${icon.size}x${icon.size} px, ${icon.bytes.length} bytes (ChatGPT's custom-server form takes a PNG of up to 10 KB)`);
  for (const warning of warnings) console.warn(`WARNING: ${warning}`);
}
