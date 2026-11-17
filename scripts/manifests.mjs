import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ONE source of truth for two packages. `plugin-source.json` holds every fact the packages share (the version, the server address, the
// scopes, the author, the links, the icon, the names and folders of the packages); `locales/<language>.json` holds the words of one
// language (the description, the listing text, the starter prompts). The manifests of both packages are generated from them, committed
// (a client reads them from the repository) and checked against them by `pnpm check`. To rename a package or change the address, edit
// the source and run `pnpm manifests`; nothing else holds the value.

export const sourceFile = "plugin-source.json";

export function readSource(root) {
  return JSON.parse(readFileSync(join(root, sourceFile), "utf8"));
}

/** The packages in the order of the source: `[{ id, dir, name, locale }]`. The first one with `id === source.main` is the main language. */
export function packagesOf(source) {
  return Object.entries(source.packages).map(([id, value]) => ({ id, ...value }));
}

export function readLocale(root, pack) {
  return JSON.parse(readFileSync(join(root, pack.locale), "utf8"));
}

/** `{ id: locale }` for every package; throws when a locale file is missing. */
export function readLocales(root, source) {
  return Object.fromEntries(packagesOf(source).map((pack) => [pack.id, readLocale(root, pack)]));
}

/** The files generated from the sources, as paths from the repository root. */
export function generatedFiles(source) {
  const files = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"];

  for (const { dir } of packagesOf(source)) {
    files.push(...["plugin.json", "mcp.json", ".mcp.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"].map((file) => `${dir}/${file}`));
  }
  return files;
}

/** The OpenAI `auth` declaration of the server: OAuth only («OAuth or no authentication» makes ChatGPT stop after discovery), client registration by CIMD, the two scopes the server grants. */
export function openAiAuth(source) {
  return { type: "oauth", client: { mode: "cimd" }, defaultScopes: [...source.mcp.scopes] };
}

function serverFiles(source) {
  const server = source.mcp.serverName;

  return {
    mcp: {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [server]: { type: "streamable-http", url: source.mcp.url } },
    },
    claudeMcp: { mcpServers: { [server]: { type: "http", url: source.mcp.url } } },
  };
}

/**
 * The `mcp.json` of the ChatGPT ZIP only: the committed one stays valid against the closed Agent Plugins 1.0.0 schema (which rejects
 * `extensions` on a server), and OpenAI's portal reads the authentication from the `mcp.json` it is given, so the ZIP adds it.
 */
export function zipMcpManifest(source) {
  const manifest = serverFiles(source).mcp;
  const server = source.mcp.serverName;

  return { ...manifest, mcpServers: { [server]: { ...manifest.mcpServers[server], extensions: { "com.openai": { auth: openAiAuth(source) } } } } };
}

/** The manifests of one package, as `{ path: object }`. The key order is the order a person reads the file in. */
function packageManifests(source, locales, pack) {
  const text = locales[pack.id];
  const { listing } = source;
  const common = { name: pack.name, version: source.version, description: text.description, author: source.author, homepage: source.homepage, repository: source.repository, keywords: text.keywords };
  const presentation = {
    displayName: text.displayName,
    shortDescription: text.shortDescription,
    longDescription: text.longDescription,
    developerName: listing.developerName,
    category: listing.category,
    capabilities: text.capabilities,
    websiteURL: listing.websiteURL,
    supportURL: listing.supportURL,
    privacyPolicyURL: listing.privacyPolicyURL,
    termsOfServiceURL: listing.termsOfServiceURL,
    defaultPrompt: text.defaultPrompt,
  };
  const images = { composerIcon: source.icon, logo: source.icon };
  const { mcp, claudeMcp } = serverFiles(source);
  const openai = { interface: { ...presentation, ...images } };

  // The package that goes to OpenAI keeps English as its base text and carries the other languages as translations of the subtitle and the description.
  if (pack.id === source.zip) {
    const translations = {};

    for (const other of packagesOf(source).filter((p) => p.id !== pack.id)) {
      translations[other.openaiLocale] = { subtitle: locales[other.id].shortDescription, description: locales[other.id].longDescription };
    }
    openai.publication = { translations };
  }
  const dir = pack.dir;

  return {
    [`${dir}/plugin.json`]: { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...common, extensions: { "com.openai": openai }, license: source.license },
    [`${dir}/mcp.json`]: mcp,
    [`${dir}/.mcp.json`]: claudeMcp,
    [`${dir}/.claude-plugin/plugin.json`]: {
      name: pack.name,
      displayName: text.displayName,
      version: source.version,
      description: text.description,
      author: source.author,
      homepage: source.homepage,
      repository: source.repository,
      keywords: text.keywords,
      privacyPolicyUrl: listing.privacyPolicyURL,
      termsOfServiceUrl: listing.termsOfServiceURL,
      supportUrl: listing.supportURL,
      documentationUrl: `${source.repository}/blob/main/${dir}/README.md`,
      license: source.license,
      icon: source.icon,
    },
    [`${dir}/.codex-plugin/plugin.json`]: { ...common, interface: { ...presentation, ...images }, license: source.license },
  };
}

/** Every generated manifest as `{ path: object }`. */
export function buildManifests(source, locales) {
  const packages = packagesOf(source);
  const main = packages.find((pack) => pack.id === source.main);
  const manifests = {};

  for (const pack of packages) Object.assign(manifests, packageManifests(source, locales, pack));
  manifests[".claude-plugin/marketplace.json"] = {
    name: source.marketplace.name,
    description: locales[main.id].marketplaceDescription,
    owner: { name: source.author.name, url: source.author.url },
    plugins: packages.map((pack) => ({ name: pack.name, source: `./${pack.dir}`, description: locales[pack.id].description })),
  };
  manifests[".agents/plugins/marketplace.json"] = {
    name: source.marketplace.name,
    interface: { displayName: locales[main.id].displayName },
    plugins: packages.map((pack) => ({
      name: pack.name,
      source: { source: "local", path: `./${pack.dir}` },
      policy: { installation: source.marketplace.codexInstallation, authentication: source.marketplace.codexAuthentication },
      category: source.listing.category,
    })),
  };
  return manifests;
}

export const manifestText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** One problem per committed file that is not what the sources generate (empty = they agree). */
export function manifestSyncProblems(root) {
  if (!existsSync(join(root, sourceFile))) return [`${sourceFile} is missing: it is the one source of the manifests`];
  let source;
  let locales;

  try {
    source = readSource(root);
    locales = readLocales(root, source);
  } catch (error) {
    return [`${sourceFile} or a locale file it names is missing or not valid JSON: ${error.message}`];
  }
  const problems = [];

  for (const [file, expected] of Object.entries(buildManifests(source, locales))) {
    const path = join(root, file);

    if (!existsSync(path)) {
      problems.push(`${file} is missing: run pnpm manifests to generate it from ${sourceFile}`);
      continue;
    }
    // The bytes, not only the parsed value: a re-ordered key or a changed indent is a hand edit too.
    if (readFileSync(path, "utf8") !== manifestText(expected)) problems.push(`${file} differs from what ${sourceFile} and the locale files generate: edit them and run pnpm manifests, never the generated file`);
  }
  return problems;
}

export function writeManifests(root) {
  const source = readSource(root);
  const manifests = buildManifests(source, readLocales(root, source));

  for (const [file, value] of Object.entries(manifests)) writeFileSync(join(root, file), manifestText(value));
  return Object.keys(manifests);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  for (const file of writeManifests(root)) console.log(`wrote ${file}`);
}
