import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { languageProblems } from "./languages.mjs";
import { manifestSyncProblems, packagesOf, readSource } from "./manifests.mjs";
import { markerProblems } from "./openai-variant.mjs";

// Every rule of the package. What a client installs is the folder `plugin/` and nothing else, and it is
// manifests and a README: no code to test, so these rules are the tests of the product. `checkPackage` returns
// problems as strings (empty = fine); it reads files and does not throw on a bad package, so a test can break a copy
// of the package and read what was said.

// The folder of the package being checked. `checkPackage` runs the per-package rules once for each package of the source and sets it.
export let payload = "plugin";

const require = createRequire(import.meta.url);

// A placeholder is a stand-in for a value that is not known yet, such as the policy pages. `.invalid` (RFC 2606) can never resolve, so one cannot pass for a real host; the example domains and the
// `-pending` marker are the other ways a stand-in is written.
const placeholderPattern = /\.invalid\b|\.example\b|\bexample\.(?:com|org|net)\b|-pending\b/iu;

/** A URL is the repository itself, or a path inside it: never a sibling repository that shares the prefix. */
export function isOwnRepositoryUrl(url, repository) {
  return typeof repository === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(repository) && (url === repository || url.startsWith(`${repository}/`));
}

export function isPlaceholder(text) {
  return placeholderPattern.test(text);
}

const reservedPrefixes = ["claude-", "anthropic-", "anthropics-", "cc-plugin-"];
const reservedNames = new Set(["claude", "anthropic", "anthropics", "claude-code", "claude-mods"]);

/**
 * Claude Code's rule for names that pass as Anthropic's own (code.claude.com/docs/en/plugins-reference, «name»): ignoring
 * case, any run of separators counts as one. Returns the reason, or null. A whole-word `claude`/`anthropic` elsewhere is
 * only a warning there; `--strict` makes it a failure and so it is one here too.
 */
export function reservedClaudeName(name) {
  const normal = name.toLowerCase().replace(/[-_.\s]+/gu, "-");
  const words = normal.split("-");

  if (reservedNames.has(normal)) return `"${name}" is reserved for Anthropic`;
  if (reservedPrefixes.some((prefix) => normal.startsWith(prefix))) {
    return `"${name}" starts with a prefix reserved for Anthropic`;
  }
  if (words.includes("official") && (words.includes("claude") || words.includes("anthropic"))) {
    return `"${name}" puts official beside claude or anthropic`;
  }
  if (words.some((word) => ["claude", "anthropic", "anthropics"].includes(word))) {
    return `"${name}" reads as one of Anthropic's own`;
  }
  return null;
}

function readJson(root, file, problems) {
  const path = join(root, file);

  if (!existsSync(path)) {
    problems.push(`${file} is missing`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`${file} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

function schemaProblems(root, file, schemaFile, value, problems) {
  const Ajv2020 = require("ajv/dist/2020");
  const schema = JSON.parse(readFileSync(join(root, "schemas", schemaFile), "utf8"));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

  if (!validate(value)) {
    for (const error of validate.errors ?? []) {
      problems.push(`${file} breaks the Agent Plugins 1.0 schema at ${error.instancePath || "/"}: ${error.message}`);
    }
  }
}

function onlyKeys(label, object, allowed, problems) {
  for (const key of Object.keys(object ?? {})) {
    if (!allowed.includes(key)) {
      problems.push(`${label} must not set ${key}: only ${allowed.join(", ")} are allowed (the package has no hooks, commands, servers or credentials of its own to declare there)`);
    }
  }
}

function httpsUrl(label, text, problems, { endsWith } = {}) {
  let url;

  try {
    url = new URL(text);
  } catch {
    problems.push(`${label} is not an absolute URL: ${JSON.stringify(text)}`);
    return;
  }
  if (url.protocol !== "https:") problems.push(`${label} must use https: ${text}`);
  if (url.username || url.password) problems.push(`${label} must carry no user information: ${text}`);
  if (url.hash) problems.push(`${label} must carry no fragment: ${text}`);
  if (url.search) problems.push(`${label} must carry no query string (a key or token could ride in it): ${text}`);
  if (endsWith && !url.pathname.endsWith(endsWith)) problems.push(`${label} must end with ${endsWith}: ${text}`);
}

const listingKeys = [
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "privacyPolicyURL",
  "termsOfServiceURL",
  "websiteURL",
  "supportURL",
  "defaultPrompt",
];
const imageKeys = ["logo", "composerIcon"];
// OpenAI's listing metadata (developers.openai.com/plugins/deploy/submission, «Listing metadata»): the same names in the portable
// `extensions.com.openai.interface` and in the Codex overlay's `interface`.
const interfaceKeys = [...listingKeys, ...imageKeys];
const codexInterfaceKeys = interfaceKeys;
const claudeKeys = [
  "name",
  "displayName",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "keywords",
  "license",
  "icon",
  "privacyPolicyUrl",
  "termsOfServiceUrl",
  "supportUrl",
  "documentationUrl",
];
const codexKeys = ["name", "version", "description", "author", "homepage", "repository", "keywords", "license", "interface"];

// ---- the payload: what a client installs -------------------------------------------------------------------------

const payloadFiles = [
  /^plugin\.json$/u,
  /^mcp\.json$/u,
  /^\.mcp\.json$/u,
  /^README\.md$/u,
  /^LICENSE$/u,
  /^\.claude-plugin\/plugin\.json$/u,
  /^\.codex-plugin\/plugin\.json$/u,
  /^assets\/[A-Za-z0-9._-]+\.(?:png|jpe?g)$/u,
  /^skills\/[a-z0-9-]+\/SKILL\.md$/u,
  /^skills\/[a-z0-9-]+\/references\/[A-Za-z0-9._-]+\.md$/u,
];

// `.git` and `node_modules` are skipped only at the top of a whole-repository walk. Inside the payload nothing is
// skipped (`topSkips = []`): a `node_modules` folder in `plugin/` would be installed by a client, so it is a file to refuse.
function walk(root, directory = root, topSkips = [".git", "node_modules"]) {
  const entries = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && topSkips.includes(entry.name)) continue;
    const path = join(directory, entry.name);
    const name = relative(root, path).split(sep).join("/");

    if (entry.isSymbolicLink()) entries.push({ name, symlink: true });
    else if (entry.isDirectory()) entries.push(...walk(root, path, topSkips));
    else entries.push({ name, symlink: false });
  }
  return entries;
}

function payloadProblems(root, problems) {
  const folder = join(root, payload);

  if (!existsSync(folder)) return;
  for (const { name, symlink } of walk(folder, folder, [])) {
    if (symlink) problems.push(`${payload}/${name} is a symbolic link: the payload holds regular files only`);
    else if (!payloadFiles.some((pattern) => pattern.test(name))) {
      problems.push(`${payload}/${name} is not on the allowlist of the payload (manifests, README, LICENSE, images, skills as Markdown): a script, hook, server, command or a file of another kind is refused`);
    } else if (/^skills\//u.test(name)) skillProblems(join(folder, name), `${payload}/${name}`, problems);
  }
}

// A skill is Markdown, and in a plugin it can also carry behaviour: `hooks` or `allowed-tools` in its front matter, and
// a body line of the form !`command` (or a fenced block that opens with ```!) that a client runs when the skill loads
// (code.claude.com/docs/en/skills). The package promises no code and no hooks, so a skill may set only the keys below
// and may not hold that syntax anywhere.
const skillKeys = ["name", "description", "license", "metadata"];

function skillProblems(path, label, problems) {
  const text = readFileSync(path, "utf8");

  problems.push(...markerProblems(label, text));
  if (/!`/u.test(text) || /^\s*(?:```|~~~)!/mu.test(text)) {
    problems.push(`${label} holds a shell-command injection (!\`...\` or a fenced block opening with !): a skill runs no command`);
  }
  if (label.endsWith("/SKILL.md")) {
    const front = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);

    if (!front) problems.push(`${label} has no front matter`);
    else {
      for (const [, key] of front[1].matchAll(/^([A-Za-z0-9_-]+)\s*:/gmu)) {
        if (!skillKeys.includes(key)) problems.push(`${label} front matter must not set ${key}: only ${skillKeys.join(", ")} are allowed (no hooks and no tool permissions of its own)`);
      }
    }
  }
}

// ---- secrets ------------------------------------------------------------------------------------------------------

const secretPatterns = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/u, "a bearer token"],
  [/Authorization["']?\s*:\s*["']?Basic\s+[A-Za-z0-9+/=]{8,}/iu, "a basic-auth credential"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/u, "a JSON web token"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/u, "a GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/u, "an API key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/u, "a Slack token"],
  [/AKIA[0-9A-Z]{16}/u, "an AWS key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "a private key"],
  [/github_pat_[A-Za-z0-9_]{20,}/u, "a GitHub token"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/u, "a Telegram bot token"],
  [/\bAIza[0-9A-Za-z_-]{35}/u, "a Google API key"],
  [/\b[A-Z][A-Z0-9_]*(?:PEPPER|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[A-Za-z0-9/+_-]{8,}/u, "a secret assigned to a variable"],
  [/(?:client_secret|api[_-]?key|access[_-]?token|password|passwd|secret)["']?\s*[:=]\s*["']?[A-Za-z0-9/+_-]{12,}/iu, "a secret value"],
];
// The tests and the schemas hold fake secrets and long strings on purpose; the lock file is a hash list.
// `dist/` holds the build outputs of `pnpm package:chatgpt` (a ZIP and a PNG, both made from the payload scanned here; the script scans the ZIP's text entries again).
const secretScanSkips = ["tests", "schemas", "pnpm-lock.yaml", "dist"];

function secretProblems(root, problems) {
  for (const { name, symlink } of walk(root)) {
    if (secretScanSkips.includes(name.split("/")[0])) continue;
    if (symlink) {
      if (!/^plugin(?:-en)?\//u.test(name)) problems.push(`${name} is a symbolic link: it is not read for secrets, and the repository holds none`);
      continue;
    }

    const bytes = readFileSync(join(root, name));

    if (bytes.includes(0)) {
      if (!/^plugin(?:-en)?\/assets\/[^/]+\.(?:png|jpe?g)$/u.test(name) && name !== formIconPath) {
        problems.push(`${name} is a binary file outside the package assets: it cannot be read for secrets`);
      }
      continue;
    }
    for (const what of secretsIn(bytes.toString("utf8"))) problems.push(`${name}: looks like it holds ${what} (a credential or secret)`);
  }
}

/** What kinds of secret a text looks like it holds (empty = none). The ZIP script scans every text entry with the same patterns. */
export function secretsIn(text) {
  return secretPatterns.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

function same(label, values, problems) {
  const distinct = new Set(values.map(([, value]) => value));

  if (distinct.size > 1) {
    problems.push(`${label} differs between manifests: ${values.map(([file, value]) => `${file}=${JSON.stringify(value)}`).join(", ")}`);
  }
}

// ---- the manifests ------------------------------------------------------------------------------------------------

function portableProblems(root, portable, problems) {
  if (!portable) return;
  const openai = portable.extensions?.["com.openai"];
  const listing = openai?.interface;

  onlyKeys("plugin.json extensions", portable.extensions, ["com.openai"], problems);
  onlyKeys("plugin.json extensions.com.openai", openai, ["interface", "publication"], problems);
  onlyKeys("plugin.json extensions.com.openai.interface", listing, interfaceKeys, problems);
  if (!listing?.privacyPolicyURL || !listing?.termsOfServiceURL) {
    problems.push("plugin.json needs extensions.com.openai.interface.privacyPolicyURL and termsOfServiceURL (OpenAI reads them there)");
  }
  for (const key of ["privacyPolicyURL", "termsOfServiceURL", "websiteURL", "supportURL"]) {
    if (listing?.[key]) httpsUrl(`plugin.json interface.${key}`, listing[key], problems);
  }
  if (/\binvit/iu.test(listing?.longDescription ?? "")) {
    problems.push("plugin.json longDescription promises or denies invitations: the listing text must not make a claim that a later release can falsify");
  }
  for (const key of ["supportURL", "logo", "composerIcon", "capabilities", "defaultPrompt"]) {
    if (listing && listing[key] === undefined) problems.push(`plugin.json interface needs ${key} (OpenAI requires it for a public MCP plugin and for Codex)`);
  }
  listingProblems("plugin.json interface", listing, problems);
  iconProblems(root, "plugin.json interface.logo", listing?.logo, problems);
  iconProblems(root, "plugin.json interface.composerIcon", listing?.composerIcon, problems);
  publicationProblems(openai?.publication, problems);
}

const oneLine = (value) => typeof value === "string" && value.trim() !== "" && !/[\r\n\u2028\u2029\p{Cc}]/u.test(value);

// The limits OpenAI enforces at the final directory submission (developers.openai.com/plugins/reference/package-validation,
// «Final directory submission»). A package upload accepts longer text, so the ZIP stays inside these limits.
function listingProblems(label, listing, problems) {
  if (!listing) return;
  const limit = (key, max, { line = true } = {}) => {
    const value = listing[key];

    if (value === undefined) return;
    if (typeof value !== "string" || value.trim() === "") problems.push(`${label}.${key} must be a non-empty string`);
    else {
      if (value.length > max) problems.push(`${label}.${key} is ${value.length} characters: the final submission allows at most ${max}`);
      if (line && !oneLine(value)) problems.push(`${label}.${key} must be one line of supported text`);
    }
  };

  limit("displayName", 30);
  limit("shortDescription", 30);
  limit("longDescription", 4000, { line: false });
  limit("developerName", 80);
  if (listing.capabilities !== undefined) {
    if (!Array.isArray(listing.capabilities)) problems.push(`${label}.capabilities must be a list of strings`);
    else {
      if (listing.capabilities.length > 20) problems.push(`${label}.capabilities has ${listing.capabilities.length} entries: at most 20`);
      for (const entry of listing.capabilities) {
        if (!oneLine(entry) || entry.length > 120) problems.push(`${label}.capabilities entries must be non-empty one lines of at most 120 characters: ${JSON.stringify(entry)}`);
      }
    }
  }
  if (listing.defaultPrompt !== undefined) {
    const prompts = Array.isArray(listing.defaultPrompt) ? listing.defaultPrompt : [listing.defaultPrompt];

    if (prompts.length > 3) problems.push(`${label}.defaultPrompt has ${prompts.length} prompts: at most 3`);
    if (new Set(prompts.map((prompt) => String(prompt).normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase())).size !== prompts.length) {
      problems.push(`${label}.defaultPrompt prompts must be unique`);
    }
    for (const prompt of prompts) {
      if (!oneLine(prompt) || prompt.length > 128) problems.push(`${label}.defaultPrompt entries must be non-empty one lines of at most 128 characters: ${JSON.stringify(prompt)}`);
      if (typeof prompt === "string" && prompt.includes("@")) problems.push(`${label}.defaultPrompt must carry no @mention: ${JSON.stringify(prompt)}`);
    }
  }
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    if (typeof listing[key] === "string" && listing[key].length > 1024) problems.push(`${label}.${key} is longer than 1024 characters`);
  }
}

// `publication.translations.<locale>.subtitle`: one line, at most 30 characters (the same page, «Translate listing text»). Nothing else is declared.
function publicationProblems(publication, problems) {
  if (publication === undefined) return;
  onlyKeys("plugin.json extensions.com.openai.publication", publication, ["translations"], problems);
  for (const [locale, entry] of Object.entries(publication.translations ?? {})) {
    onlyKeys(`plugin.json publication.translations.${locale}`, entry, ["subtitle", "description"], problems);
    if (entry?.description !== undefined && (typeof entry.description !== "string" || entry.description.trim() === "" || entry.description.length > 4000)) {
      problems.push(`plugin.json publication.translations.${locale}.description must be a non-empty text of at most 4000 characters`);
    }
    if (entry?.subtitle !== undefined && (!oneLine(entry.subtitle) || entry.subtitle.length > 30)) {
      problems.push(`plugin.json publication.translations.${locale}.subtitle must be one line of at most 30 characters: ${JSON.stringify(entry.subtitle)}`);
    }
  }
}

const maxImageBytes = 2 * 1024 * 1024;

// A PNG is the 8-byte signature, then a 13-byte IHDR chunk that holds the width and the height.
function pngProblems(label, bytes, problems) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = bytes.length >= 33 && bytes.subarray(0, 8).equals(signature) && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).toString("latin1") === "IHDR";

  if (!isPng) problems.push(`${label} is not a PNG file`);
  else {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);

    if (width !== height || width < 512 || width > 2048) problems.push(`${label} must be square, 512 to 2048 px on each side (it is ${width}x${height})`);
    pngContentProblems(label, bytes, problems);
  }
  if (bytes.length >= maxImageBytes) problems.push(`${label} must be under 2 MB`);
}

const pngMetadataChunks = ["tIME", "tEXt", "iTXt", "zTXt", "eXIf"];

// An icon carries no transparency (a palette without a tRNS chunk, or colour without an alpha channel) and no metadata chunk
// (a time, a text or EXIF data could carry a path or a name).
function pngContentProblems(label, bytes, problems) {
  const chunks = [];
  let at = 8;

  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    chunks.push(bytes.toString("latin1", at + 4, at + 8));
    at += 12 + length;
  }
  const colorType = bytes[25];

  if (colorType === 4 || colorType === 6 || chunks.includes("tRNS")) problems.push(`${label} must not be transparent`);
  for (const chunk of chunks.filter((name) => pngMetadataChunks.includes(name))) problems.push(`${label} carries a metadata chunk (${chunk})`);
}

/** The icon of ChatGPT's custom-server form: a committed 256 px PNG of at most 10,000 bytes, outside the payload (it is not installed). */
export const formIconPath = "assets/chatgpt-form-icon.png";
export const formIconMaxBytes = 10_000;

function formIconProblems(root, problems) {
  const path = join(root, formIconPath);

  if (!existsSync(path) || !statSync(path).isFile()) {
    problems.push(`${formIconPath} is missing: ChatGPT's custom-server form takes this icon`);
    return;
  }
  const bytes = readFileSync(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    problems.push(`${formIconPath} is not a PNG file`);
    return;
  }
  if (bytes.readUInt32BE(16) !== 256 || bytes.readUInt32BE(20) !== 256) problems.push(`${formIconPath} must be 256x256 px (it is ${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)})`);
  if (bytes.length > formIconMaxBytes) problems.push(`${formIconPath} must be at most ${formIconMaxBytes} bytes (the form takes up to 10 KB; it is ${bytes.length})`);
  pngContentProblems(formIconPath, bytes, problems);
}

// An icon is a file of the payload: a path `./assets/<name>.png` (an SVG can carry script, so the payload takes PNG and
// JPEG only) that exists, is a regular file and passes `pngProblems`. The size rules are this package's own, copied from the
// text of `claude plugin validate --profile directory` (ICON_MISSING: «a square PNG or JPEG ... 512 to 2048 px on each side,
// under 2 MB; SVG and WebP are not accepted»); that validator itself only checks that the file exists.
function iconProblems(root, label, value, problems) {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\.\/assets\/[A-Za-z0-9._-]+\.png$/u.test(value)) {
    problems.push(`${label} must be a path ./assets/<name>.png inside the payload: ${JSON.stringify(value)}`);
    return;
  }
  const path = join(root, payload, value.slice(2));

  if (!existsSync(path)) problems.push(`${label} names ${value}, which does not exist in ${payload}/`);
  else if (!statSync(path).isFile()) problems.push(`${label} names ${value}, which is not a regular file`);
  else pngProblems(`${label} ${value}`, readFileSync(path), problems);
}

// Every image of the payload is checked, referenced or not: a file in assets/ is installed with the plugin.
function assetProblems(root, problems) {
  const folder = join(root, payload);

  if (!existsSync(folder)) return;
  for (const { name, symlink } of walk(folder, folder, [])) {
    if (symlink || !/^assets\/[^/]+\.(?:png|jpe?g)$/u.test(name)) continue;
    const path = join(folder, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);

    if (name.endsWith(".png")) pngProblems(`${payload}/${name}`, bytes, problems);
    else {
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) problems.push(`${payload}/${name} is not a JPEG file`);
      if (bytes.length >= maxImageBytes) problems.push(`${payload}/${name} must be under 2 MB`);
    }
  }
}

// The license is MIT: every manifest names it, `plugin/LICENSE` holds its text with
// the copyright line, and the LICENSE at the repository root is the same file.
const licenseId = "MIT";

function licenseProblems(root, manifests, problems) {
  for (const [file, manifest] of manifests) {
    if (manifest && manifest.license !== licenseId) problems.push(`${file} must name the license ${licenseId}, not ${JSON.stringify(manifest.license)}`);
  }
  const file = join(root, payload, "LICENSE");
  const rootFile = join(root, "LICENSE");

  if (!existsSync(file) || !statSync(file).isFile()) {
    problems.push(`${payload}/LICENSE is missing`);
    return;
  }
  const text = readFileSync(file, "utf8");

  if (!/^MIT License\r?\n/u.test(text) || !text.includes("Permission is hereby granted, free of charge") || !/^Copyright \(c\) \d{4} stingrigs$/mu.test(text)) {
    problems.push(`${payload}/LICENSE does not read as the MIT License with the copyright line of stingrigs`);
  }
  if (!existsSync(rootFile) || !statSync(rootFile).isFile() || !readFileSync(rootFile).equals(readFileSync(file))) {
    problems.push("LICENSE at the repository root is missing or differs from plugin/LICENSE");
  }
}

function claudeProblems(claude, problems) {
  if (!claude) return;
  const reason = reservedClaudeName(claude.name ?? "");
  if (reason) problems.push(`.claude-plugin/plugin.json name: ${reason}; reserved names are refused`);
  onlyKeys(".claude-plugin/plugin.json", claude, claudeKeys, problems);
  for (const key of ["name", "version", "description", "homepage", "privacyPolicyUrl", "termsOfServiceUrl", "supportUrl"]) {
    if (!claude[key]) problems.push(`.claude-plugin/plugin.json needs ${key}`);
  }
  if (!claude.author?.name) problems.push(".claude-plugin/plugin.json needs author.name");
  if (!claude.icon) problems.push(".claude-plugin/plugin.json needs icon (the plugin has one)");
  if (typeof claude.repository !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(claude.repository)) {
    problems.push(`.claude-plugin/plugin.json repository must be an https://github.com/<owner>/<name> URL: ${JSON.stringify(claude.repository)}`);
  }
  for (const key of ["homepage", "privacyPolicyUrl", "termsOfServiceUrl", "supportUrl", "documentationUrl"]) {
    if (claude[key]) httpsUrl(`.claude-plugin/plugin.json ${key}`, claude[key], problems);
  }
}

function codexProblems(codex, problems) {
  if (!codex) return;
  onlyKeys(".codex-plugin/plugin.json", codex, codexKeys, problems);
  onlyKeys(".codex-plugin/plugin.json interface", codex.interface, codexInterfaceKeys, problems);
  for (const key of ["logo", "composerIcon", "capabilities", "supportURL"]) {
    if (codex.interface?.[key] === undefined) problems.push(`.codex-plugin/plugin.json needs interface.${key} (the Codex format requires it)`);
  }
  listingProblems(".codex-plugin/plugin.json interface", codex.interface, problems);
}

function mcpProblems(mcp, claudeMcp, problems) {
  const server = mcp?.mcpServers?.wishlist;

  if (mcp) {
    if (Object.keys(mcp.mcpServers ?? {}).join() !== "wishlist") problems.push('mcp.json must declare exactly one server, "wishlist"');
    if (server?.type !== "streamable-http") problems.push("mcp.json: the server type must be streamable-http");
    if (server && "headers" in server) {
      problems.push("mcp.json: no headers (a fixed header would be a shared secret; sign-in is OAuth, discovered by the client)");
    }
    if (typeof server?.url === "string") httpsUrl("mcp.json url", server.url, problems, { endsWith: "/mcp" });
  }
  if (claudeMcp) {
    const claudeServer = claudeMcp.mcpServers?.wishlist;

    onlyKeys(".mcp.json", claudeMcp, ["mcpServers"], problems);
    if (Object.keys(claudeMcp.mcpServers ?? {}).join() !== "wishlist") problems.push('.mcp.json must declare exactly one server, "wishlist"');
    if (claudeServer?.type !== "http") problems.push(".mcp.json: the Claude server type must be http");
    for (const key of Object.keys(claudeServer ?? {})) {
      if (!["type", "url"].includes(key)) problems.push(`.mcp.json: no ${key} (no secrets, no headers, no oauth overrides: the client discovers sign-in)`);
    }
    if (server?.url && claudeServer?.url !== server.url) {
      problems.push(`.mcp.json URL (${claudeServer?.url}) differs from mcp.json URL (${server.url})`);
    }
  }
}

// `extensions["com.openai"].auth` of the server (developers.openai.com/plugins/build/plugins, «Configure MCP authentication»), put in
// the `mcp.json` of the ChatGPT ZIP only (`scripts/package-chatgpt.mjs` judges it with this function). The ZIP declares OAuth with client registration by CIMD and the scopes the server grants, and nothing secret: no client id, no
// client secret, no key. `mixed` is refused because ChatGPT stops with «The MCP server denied access» when the form
// is left on «OAuth or no authentication».
const authKeys = ["type", "client", "defaultScopes"];

export function mcpAuthProblems(server, problems) {
  if (!server || typeof server !== "object") return;
  const extensions = server.extensions;

  if (extensions === undefined) {
    problems.push("mcp.json: the server needs extensions.com.openai.auth (OpenAI's portal reads the authentication settings from mcp.json)");
    return;
  }
  onlyKeys("mcp.json server extensions", extensions, ["com.openai"], problems);
  onlyKeys("mcp.json server extensions.com.openai", extensions["com.openai"], ["auth"], problems);
  const auth = extensions["com.openai"]?.auth;

  if (!auth || typeof auth !== "object") {
    problems.push("mcp.json: extensions.com.openai.auth is missing");
    return;
  }
  onlyKeys("mcp.json auth", auth, authKeys, problems);
  if (auth.type !== "oauth") problems.push(`mcp.json auth.type must be oauth, not ${JSON.stringify(auth.type)} (the server refuses unauthenticated calls, and the mixed choice makes ChatGPT stop after discovery)`);
  onlyKeys("mcp.json auth.client", auth.client, ["mode"], problems);
  if (auth.client?.mode !== "cimd") problems.push(`mcp.json auth.client.mode must be cimd, the registration this package uses: ${JSON.stringify(auth.client?.mode)}`);
  if (!Array.isArray(auth.defaultScopes) || auth.defaultScopes.length === 0 || auth.defaultScopes.some((scope) => typeof scope !== "string" || scope.trim() === "" || /\s/u.test(scope))) {
    problems.push("mcp.json auth.defaultScopes must be a list of scope strings");
  } else if (!isDeepStrictEqual([...auth.defaultScopes].sort(), ["wishlist:read", "wishlist:write"])) {
    problems.push(`mcp.json auth.defaultScopes must be exactly wishlist:read and wishlist:write, the scopes of the server: ${JSON.stringify(auth.defaultScopes)}`);
  }
}

const codexAuthentication = ["ON_INSTALL"];

function marketplaceProblems(root, packs, problems) {
  const claude = readJson(root, ".claude-plugin/marketplace.json", problems);
  const codex = readJson(root, ".agents/plugins/marketplace.json", problems);
  const listed = packs.map((pack) => `"${pack.name}"`).join(" and ");
  const sameList = (plugins, pick) => Array.isArray(plugins) && plugins.length === packs.length && packs.every((pack, index) => pick(plugins[index]) === pack.name);

  if (claude) {
    const reason = reservedClaudeName(claude.name ?? "");
    if (reason) problems.push(`.claude-plugin/marketplace.json name: ${reason}; reserved names are refused`);
    onlyKeys(".claude-plugin/marketplace.json", claude, ["name", "description", "owner", "plugins"], problems);
    onlyKeys(".claude-plugin/marketplace.json owner", claude.owner, ["name", "url"], problems);
    if (!claude.owner?.name) problems.push(".claude-plugin/marketplace.json needs owner.name");
    if (!sameList(claude.plugins, (entry) => entry?.name)) {
      problems.push(`.claude-plugin/marketplace.json must list exactly the plugins ${listed}: the marketplace entry name is the install id`);
    }
    for (const [index, pack] of packs.entries()) {
      const entry = claude.plugins?.[index];
      onlyKeys(".claude-plugin/marketplace.json plugin entry", entry, ["name", "source", "description"], problems);
      if (entry?.source !== `./${pack.dir}`) {
        problems.push(`.claude-plugin/marketplace.json source must be "./${pack.dir}": a client installs that folder, not the repository`);
      }
    }
  }
  if (codex) {
    onlyKeys(".agents/plugins/marketplace.json", codex, ["name", "interface", "plugins"], problems);
    if (!sameList(codex.plugins, (entry) => entry?.name)) problems.push(`.agents/plugins/marketplace.json must list exactly the plugins ${listed}`);
    for (const [index, pack] of packs.entries()) {
      const entry = codex.plugins?.[index];
      onlyKeys(".agents/plugins/marketplace.json plugin entry", entry, ["name", "source", "policy", "category"], problems);
      onlyKeys(".agents/plugins/marketplace.json policy", entry?.policy, ["installation", "authentication"], problems);
      const source = entry?.source;
      const path = typeof source === "string" ? source : source?.path;
      if (typeof source === "object") onlyKeys(".agents/plugins/marketplace.json source", source, ["source", "path"], problems);
      if (typeof source === "object" && source.source !== "local") {
        problems.push('.agents/plugins/marketplace.json source must be local: the plugin comes from this repository, not from a URL or a package');
      }
      if (path !== `./${pack.dir}`) problems.push(`.agents/plugins/marketplace.json source path must be "./${pack.dir}"`);
      if (!["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry?.policy?.installation)) {
        problems.push("installation in .agents/plugins/marketplace.json policy must be AVAILABLE, INSTALLED_BY_DEFAULT or NOT_AVAILABLE");
      }
      if (!codexAuthentication.includes(entry?.policy?.authentication)) {
        problems.push(`.agents/plugins/marketplace.json policy.authentication must be ${codexAuthentication.join(" or ")} (the only value OpenAI's documentation names)`);
      }
      if (!entry?.category) problems.push(".agents/plugins/marketplace.json needs a category");
    }
  }
  if (claude && codex && claude.name !== codex.name) {
    problems.push(`the marketplace name differs: ${claude.name} (Claude) and ${codex.name} (Codex)`);
  }
  return claude;
}

function consistencyProblems({ portable, claude, codex, claudeMarketplace }, problems) {
  const portableInterface = portable?.extensions?.["com.openai"]?.interface;
  const surfaces = [
    ["plugin.json", portable],
    [".claude-plugin/plugin.json", claude],
    [".codex-plugin/plugin.json", codex],
  ].filter(([, value]) => value);
  const of = (label, pick) => same(label, surfaces.map(([file, value]) => [file, pick(file, value)]), problems);

  of("name", (file, v) => v.name);
  of("version", (file, v) => v.version);
  of("description", (file, v) => v.description);
  of("homepage", (file, v) => v.homepage);
  of("repository", (file, v) => v.repository);
  of("author", (file, v) => JSON.stringify(v.author));
  of("privacy policy URL", (file, v) => (file === ".claude-plugin/plugin.json" ? v.privacyPolicyUrl : file === "plugin.json" ? portableInterface?.privacyPolicyURL : v.interface?.privacyPolicyURL));
  of("terms of service URL", (file, v) => (file === ".claude-plugin/plugin.json" ? v.termsOfServiceUrl : file === "plugin.json" ? portableInterface?.termsOfServiceURL : v.interface?.termsOfServiceURL));
  for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "supportURL", "capabilities", "defaultPrompt", "logo", "composerIcon"]) {
    same(`the listing field ${key}`, [["plugin.json", JSON.stringify(portableInterface?.[key])], [".codex-plugin/plugin.json", JSON.stringify(codex?.interface?.[key])]].filter(([file]) => (file === "plugin.json" ? portable : codex)), problems);
  }
  if (claude?.supportUrl && portableInterface?.supportURL && claude.supportUrl !== portableInterface.supportURL) {
    problems.push(`the support URL differs: ${claude.supportUrl} (Claude) and ${portableInterface.supportURL} (listing)`);
  }
  if (claude?.icon && portableInterface?.logo && claude.icon !== portableInterface.logo) {
    problems.push(`the icon differs: ${claude.icon} (Claude) and ${portableInterface.logo} (listing logo)`);
  }
  if (claude?.displayName && portableInterface?.displayName && claude.displayName !== portableInterface.displayName) {
    problems.push(`displayName differs: ${claude.displayName} (Claude) and ${portableInterface.displayName} (listing)`);
  }
  const entry = claudeMarketplace?.plugins?.find((candidate) => candidate?.name === portable?.name);
  if (entry && portable && entry.description !== portable.description) {
    problems.push("the description of the Claude marketplace entry differs from plugin.json (the entry's description overrides it in a listing)");
  }
}

// ---- the README ---------------------------------------------------------------------------------------------------

function fencedBlocks(markdown) {
  return [...markdown.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1/gmu)].map((m) => m[2]);
}

function readmeProblems(root, mcpUrl, problems) {
  const path = join(root, payload, "README.md");

  if (!existsSync(path)) {
    problems.push(`${payload}/README.md is missing`);
    return;
  }
  const text = readFileSync(path, "utf8");
  let host;

  try {
    host = new URL(mcpUrl).host;
  } catch {
    return; // not an absolute URL: mcp.json already says so, and there is no address to compare the README with
  }
  const urls = [...new Set(text.match(/https?:\/\/[^\s)`"'<>\]]+/gu) ?? [])].map((url) => url.replace(/[.,;:]+$/u, ""));

  if (!text.includes(mcpUrl)) problems.push(`README: the MCP URL ${mcpUrl} does not appear`);
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:") problems.push(`README: ${url} is not https`);
    else if (url !== mcpUrl && (parsed.host.startsWith("mcp.") || parsed.pathname === "/mcp" || parsed.host === host)) {
      problems.push(`README: the MCP-looking URL ${url} is not the one in mcp.json (${mcpUrl})`);
    }
  }
  for (const block of fencedBlocks(text)) {
    for (const url of block.match(/https?:\/\/\S+/gu) ?? []) {
      if (url !== mcpUrl) problems.push(`README: a command block names ${url}, not the MCP URL (${mcpUrl})`);
    }
  }
}

// ---- the whole package --------------------------------------------------------------------------------------------

/** The rules of one package folder (`payload`): its manifests, icons, license, README, files. Returns the problems, paths relative to the repository. */
function checkOnePackage(root, claudeMarketplace) {
  const problems = [];
  const at = (file) => `${payload}/${file}`;
  const read = (file) => readJson(root, at(file), problems);
  const portable = read("plugin.json");
  const mcp = read("mcp.json");
  const claudeMcp = read(".mcp.json");
  const claude = read(".claude-plugin/plugin.json");
  const codex = read(".codex-plugin/plugin.json");

  if (portable) schemaProblems(root, "plugin.json", "plugin.schema.json", portable, problems);
  if (mcp) schemaProblems(root, "mcp.json", "mcp.schema.json", mcp, problems);
  portableProblems(root, portable, problems);
  claudeProblems(claude, problems);
  codexProblems(codex, problems);
  iconProblems(root, ".claude-plugin/plugin.json icon", claude?.icon, problems);
  iconProblems(root, ".codex-plugin/plugin.json interface.logo", codex?.interface?.logo, problems);
  iconProblems(root, ".codex-plugin/plugin.json interface.composerIcon", codex?.interface?.composerIcon, problems);
  iconProblems(root, "plugin.json interface.logo", portable?.extensions?.["com.openai"]?.interface?.logo, problems);
  licenseProblems(root, [["plugin.json", portable], [".claude-plugin/plugin.json", claude], [".codex-plugin/plugin.json", codex]], problems);
  assetProblems(root, problems);
  mcpProblems(mcp, claudeMcp, problems);
  consistencyProblems({ portable, claude, codex, claudeMarketplace }, problems);
  payloadProblems(root, problems);
  const mcpUrl = mcp?.mcpServers?.wishlist?.url;
  if (typeof mcpUrl === "string") readmeProblems(root, mcpUrl, problems);
  return problems.map((problem) => problem.replace(/^(plugin\.json|mcp\.json|\.mcp\.json|\.claude-plugin\/plugin\.json|\.codex-plugin\/plugin\.json)/u, `${payload}/$1`));
}

/** All the rules, on the package at `root`: each package folder, the marketplace files, the sources, the secrets, the icon of the form, the two languages. */
export function checkPackage(root) {
  const problems = [];
  let source;

  try {
    source = readSource(root);
  } catch {
    return manifestSyncProblems(root);
  }
  const packs = packagesOf(source);
  const marketplaceProblemsList = [];
  const claudeMarketplace = marketplaceProblems(root, packs, marketplaceProblemsList);

  for (const pack of packs) {
    const previous = payload;
    payload = pack.dir;
    try {
      problems.push(...checkOnePackage(root, claudeMarketplace));
    } finally {
      payload = previous;
    }
  }
  problems.push(...marketplaceProblemsList);
  problems.push(...manifestSyncProblems(root));
  formIconProblems(root, problems);
  secretProblems(root, problems);
  problems.push(...languageProblems(root, source));
  return problems;
}

/** Markdown links outside code: `external` (http/https) and `relative` (path without #fragment). */
export function extractLinks(markdown) {
  const text = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "")
    .replace(/`[^`\n]*`/gu, "");
  const targets = [
    ...[...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/gu)].map((m) => m[1]),
    ...[...text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/gmu)].map((m) => m[1]),
    ...[...text.matchAll(/<(https?:\/\/[^>\s]+)>/gu)].map((m) => m[1]),
    ...[...text.matchAll(/(?<![(<\w])https?:\/\/[^\s<>)\]"'`]+/gu)].map((m) => m[0].replace(/[.,;:!?]+$/u, "")),
  ];
  const external = [];
  const relativeLinks = [];

  for (const target of targets) {
    if (/^https?:\/\//u.test(target)) external.push(target);
    else if (!/^(?:#|mailto:)/u.test(target)) relativeLinks.push(target.split("#")[0]);
  }
  return { external: [...new Set(external)], relative: [...new Set(relativeLinks)] };
}

export function relativeLinkProblems(root, links) {
  return links.filter((link) => !(existsSync(join(root, link)) && statSync(join(root, link)))).map((link) => `${link} does not exist`);
}

/** Every https URL a manifest or a marketplace file holds (the policy pages, the homepage, the listing links). */
export function manifestUrls(root) {
  const urls = new Set();
  const visit = (value) => {
    if (typeof value === "string" && /^https?:\/\//u.test(value)) urls.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };

  const dirs = packagesOf(readSource(root)).map((pack) => pack.dir);

  for (const file of dirs.flatMap((dir) => ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].map((f) => join(root, dir, f))).concat([join(root, ".claude-plugin/marketplace.json"), join(root, ".agents/plugins/marketplace.json")])) {
    if (existsSync(file)) visit(JSON.parse(readFileSync(file, "utf8")));
  }
  return [...urls].filter((url) => !url.endsWith("/mcp"));
}

/**
 * What a release by tag needs on top of a clean package: the tag is `v<version>`, and no placeholder is left in what a client reads. A tag
 * alone does not publish anything: `claude plugin marketplace add` follows the default branch (the repository is public, so
 * `main` is what an install gets), and this passes on the default branch before a release.
 */
export function checkReleaseReadiness(root, tag) {
  const problems = checkPackage(root);
  const source = readSource(root);
  const version = source.version;
  const dirs = packagesOf(source).map((pack) => pack.dir);

  if (tag !== `v${version}`) problems.push(`the tag ${tag} must be v${version}, the version in the manifests`);

  const readers = [
    ...dirs.flatMap((dir) => walk(join(root, dir), join(root, dir), []).map(({ name }) => `${dir}/${name}`)),
    "locales/uk.json",
    "locales/en.json",
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    "plugin-source.json",
  ];
  for (const file of readers) {
    const path = join(root, file);
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    const found = text.match(/[^\s",`)(]*(?:\.invalid\b|\.example\b|\bexample\.(?:com|org|net)\b|-pending\b)[^\s",`)(]*/giu);
    if (found) problems.push(`${file} still holds a placeholder: ${[...new Set(found)].join(", ")}`);
  }
  return problems;
}
