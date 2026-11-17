import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ONE source of truth. `plugin-source.json` holds every fact the manifests share (the name, the version, the
// description, the server address, the listing text, the icon); the six manifest files are generated from it, committed
// (a client reads them from the repository) and checked against it by `pnpm check`. To rename the plugin or change the
// address, edit the source and run `pnpm manifests`; nothing else holds the value.

export const sourceFile = "plugin-source.json";

/** The files generated from the source, as paths from the repository root. */
export const generatedFiles = [
  "plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.mcp.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

export function readSource(root) {
  return JSON.parse(readFileSync(join(root, sourceFile), "utf8"));
}

/** The OpenAI `auth` declaration of the server: OAuth only («OAuth or no authentication» makes ChatGPT stop after discovery), client registration by CIMD, the two scopes the server grants. */
export function openAiAuth(source) {
  return { type: "oauth", client: { mode: "cimd" }, defaultScopes: [...source.mcp.scopes] };
}

/**
 * The `mcp.json` of the ChatGPT ZIP only: the committed one stays valid against the closed Agent Plugins 1.0.0 schema (which rejects
 * `extensions` on a server), and OpenAI's portal reads the authentication from the `mcp.json` it is given, so the ZIP adds it.
 */
export function zipMcpManifest(source) {
  const manifest = buildManifests(source)["plugin/mcp.json"];
  const server = source.mcp.serverName;

  return { ...manifest, mcpServers: { [server]: { ...manifest.mcpServers[server], extensions: { "com.openai": { auth: openAiAuth(source) } } } } };
}

/** Every generated manifest as `{ path: object }`. The key order is the order a person reads the file in. */
export function buildManifests(source) {
  const { listing } = source;
  const common = {
    name: source.name,
    version: source.version,
    description: source.description,
    author: source.author,
    homepage: source.homepage,
    repository: source.repository,
    keywords: source.keywords,
  };
  const presentation = {
    displayName: listing.displayName,
    shortDescription: listing.shortDescription,
    longDescription: listing.longDescription,
    developerName: listing.developerName,
    category: listing.category,
    capabilities: listing.capabilities,
    websiteURL: listing.websiteURL,
    supportURL: listing.supportURL,
    privacyPolicyURL: listing.privacyPolicyURL,
    termsOfServiceURL: listing.termsOfServiceURL,
    defaultPrompt: listing.defaultPrompt,
  };
  const images = { composerIcon: source.icon, logo: source.icon };
  const server = source.mcp.serverName;

  return {
    "plugin/plugin.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...common,
      extensions: {
        "com.openai": {
          interface: { ...presentation, ...images },
          publication: { translations: { "uk-UA": { subtitle: listing.shortDescriptionUk } } },
        },
      },
      license: source.license,
    },
    "plugin/mcp.json": {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        [server]: {
          type: "streamable-http",
          url: source.mcp.url,
        },
      },
    },
    "plugin/.mcp.json": { mcpServers: { [server]: { type: "http", url: source.mcp.url } } },
    "plugin/.claude-plugin/plugin.json": {
      name: source.name,
      displayName: listing.displayName,
      version: source.version,
      description: source.description,
      author: source.author,
      homepage: source.homepage,
      repository: source.repository,
      keywords: source.keywords,
      privacyPolicyUrl: listing.privacyPolicyURL,
      termsOfServiceUrl: listing.termsOfServiceURL,
      supportUrl: listing.supportURL,
      documentationUrl: source.claude.documentationUrl,
      license: source.license,
      icon: source.icon,
    },
    "plugin/.codex-plugin/plugin.json": {
      ...common,
      interface: { ...presentation, ...images },
      license: source.license,
    },
    ".claude-plugin/marketplace.json": {
      name: source.marketplace.name,
      description: source.marketplace.claudeDescription,
      owner: { name: source.author.name, url: source.author.url },
      plugins: [{ name: source.name, source: "./plugin", description: source.description }],
    },
    ".agents/plugins/marketplace.json": {
      name: source.marketplace.name,
      interface: { displayName: listing.displayName },
      plugins: [
        {
          name: source.name,
          source: { source: "local", path: "./plugin" },
          policy: { installation: source.marketplace.codexInstallation, authentication: source.marketplace.codexAuthentication },
          category: listing.category,
        },
      ],
    },
  };
}

export const manifestText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** One problem per committed file that is not what the source generates (empty = they agree). */
export function manifestSyncProblems(root) {
  if (!existsSync(join(root, sourceFile))) return [`${sourceFile} is missing: it is the one source of the manifests`];
  let source;

  try {
    source = readSource(root);
  } catch (error) {
    return [`${sourceFile} is not valid JSON: ${error.message}`];
  }
  const problems = [];

  for (const [file, expected] of Object.entries(buildManifests(source))) {
    const path = join(root, file);

    if (!existsSync(path)) {
      problems.push(`${file} is missing: run pnpm manifests to generate it from ${sourceFile}`);
      continue;
    }
    // The bytes, not only the parsed value: a re-ordered key or a changed indent is a hand edit too.
    if (readFileSync(path, "utf8") !== manifestText(expected)) problems.push(`${file} differs from what ${sourceFile} generates: edit the source and run pnpm manifests, never the generated file`);
  }
  return problems;
}

export function writeManifests(root) {
  const manifests = buildManifests(readSource(root));

  for (const [file, value] of Object.entries(manifests)) writeFileSync(join(root, file), manifestText(value));
  return Object.keys(manifests);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  for (const file of writeManifests(root)) console.log(`wrote ${file}`);
}
