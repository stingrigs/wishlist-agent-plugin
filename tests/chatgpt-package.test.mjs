import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { checkPackage, formIconMaxBytes, formIconPath } from "../scripts/lib.mjs";
import { buildManifests, generatedFiles, manifestSyncProblems, readSource, writeManifests } from "../scripts/manifests.mjs";
import { descriptionSentence, forOpenAi, markerProblems, zipOnlyStepOne } from "../scripts/openai-variant.mjs";
import { archiveProblems, build, compressedProblems, isImage, limits, zipEntries } from "../scripts/package-chatgpt.mjs";
import { readPng } from "./png-pixels.mjs";
import { readZip, writeZip } from "../scripts/zip.mjs";

// the ZIP for OpenAI's developer portal, the small icon of ChatGPT's custom-server form, and the one source of the manifests.
// Every limit below is a line of OpenAI's own pages (developers.openai.com/plugins/reference/package-validation and
// .../deploy/submission), and each has a row that breaks it, so a rule cannot be deleted with the tests green.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyOfPackage() {
  const directory = mkdtempSync(join(tmpdir(), "wishlist-zip-"));
  for (const entry of ["plugin", ".claude-plugin", ".agents", "schemas", "scripts", ".github", "assets", "README.md", "LICENSE", "plugin-source.json"]) {
    cpSync(join(root, entry), join(directory, entry), { recursive: true });
  }
  return directory;
}

function withCopy(change, run) {
  const directory = copyOfPackage();
  try {
    change(directory);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const editJson = (file, change) => (directory) => {
  const path = join(directory, file);
  const value = JSON.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

// A square PNG with a valid header and nothing behind it: all the archive rules read is the signature and the header chunk.
function png(width, height = width, size = 64) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const entry = (name, text = "text\n") => ({ name, bytes: typeof text === "string" ? Buffer.from(text) : text });

const goodMcp = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: { wishlist: { type: "streamable-http", url: "https://mcp.example-app.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "cimd" }, defaultScopes: ["wishlist:read", "wishlist:write"] } } } } },
};
const withAuth = (change) => (entries) => entries.map((x) => {
  if (x.name !== "mcp.json") return x;
  const value = structuredClone(goodMcp);
  change(value.mcpServers.wishlist);
  return entry("mcp.json", `${JSON.stringify(value)}\n`);
});

/** A small archive that passes every rule; each row below changes one thing. */
function goodEntries(change = (entries) => entries) {
  const manifest = {
    name: "wishlist",
    extensions: { "com.openai": { interface: { logo: "./assets/icon.png", composerIcon: "./assets/icon.png" } } },
  };
  return change([
    entry("plugin.json", `${JSON.stringify(manifest)}\n`),
    entry("mcp.json", `${JSON.stringify(goodMcp)}\n`),
    entry("skills/wishlist/SKILL.md", "---\nname: wishlist\ndescription: d\n---\nText.\n"),
    entry("assets/icon.png", png(512)),
  ]);
}

test("the committed package builds a ZIP that real unzip accepts, with the portable layout only", () => {
  const { zip, entries, warnings } = build(root);
  const names = entries.map((e) => e.name);

  assert.deepEqual(names, ["LICENSE", "README.md", "assets/icon.png", "mcp.json", "plugin.json", "skills/wishlist-add-from-links/SKILL.md", "skills/wishlist-add-photos/SKILL.md", "skills/wishlist-price-check/SKILL.md", "skills/wishlist/SKILL.md"]);
  for (const left of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".mcp.json"]) assert.ok(!names.includes(left), `${left} must stay out of the ZIP`);
  assert.deepEqual(archiveProblems(entries), []);
  assert.deepEqual(compressedProblems(zip), []);
  // The authentication block is in the ZIP's mcp.json only; the committed one stays valid against the closed schema.
  const inZip = JSON.parse(entries.find((e) => e.name === "mcp.json").bytes.toString("utf8"));
  const committed = JSON.parse(readFileSync(join(root, "plugin/mcp.json"), "utf8"));
  assert.deepEqual(inZip.mcpServers.wishlist.extensions["com.openai"].auth, { type: "oauth", client: { mode: "cimd" }, defaultScopes: ["wishlist:read", "wishlist:write"] });
  assert.equal("extensions" in committed.mcpServers.wishlist, false);
  assert.deepEqual({ ...inZip.mcpServers.wishlist, extensions: undefined }, { ...committed.mcpServers.wishlist, extensions: undefined });
  assert.ok(!readFileSync(join(root, "plugin/README.md"), "utf8").includes("](../"), "no relative link leaves the folder: the README is read inside the ZIP");
  // The archive reads back to the same bytes, entry by entry, and the system's own tool accepts it.
  const back = readZip(zip).entries;
  assert.deepEqual(back.map((e) => e.name), names);
  for (const [index, original] of entries.entries()) assert.ok(back[index].bytes.equals(original.bytes), original.name);
  for (const e of back) assert.equal(e.mode & 0o777, 0o644, `${e.name} is a regular file, not executable`);
  const directory = mkdtempSync(join(tmpdir(), "wishlist-unzip-"));
  try {
    writeFileSync(join(directory, "a.zip"), zip);
    const run = spawnSync("unzip", ["-tq", join(directory, "a.zip")], { encoding: "utf8" });
    if (run.error?.code !== "ENOENT") assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Stand-in policy pages are reported, not hidden.
  assert.ok(warnings.some((w) => /domain-pending\.invalid/u.test(w) && /replace them with the real pages/u.test(w)), JSON.stringify(warnings));
});

test("the ZIP is reproducible and holds no secret and no operating-system file", () => {
  const first = build(root).zip;
  const second = build(root).zip;

  assert.ok(first.equals(second), "the same sources must give the same bytes");
  for (const { name, bytes } of zipEntries(root)) {
    assert.ok(!/(?:^|\/)(?:\.DS_Store|__MACOSX)(?:\/|$)/u.test(name), name);
    if (!name.endsWith(".png")) assert.doesNotMatch(bytes.toString("utf8"), /Bearer\s+[A-Za-z0-9._~+/=-]{16,}|client_secret|-----BEGIN/u, name);
  }
});

test("every archive limit of OpenAI's table has a row that breaks it", () => {
  assert.deepEqual(archiveProblems(goodEntries()), [], "the base archive of this test is clean");
  const big = (length) => ({ length, toString: () => "" });
  // An archive whose entries add up to exactly `target` bytes: the base entries, then fillers of at most 100 MiB (the member limit).
  const toTotal = (target) => (e) => {
    const out = [...e];
    let left = target - e.reduce((n, x) => n + x.bytes.length, 0);

    for (let i = 0; left > 0; i += 1) {
      const n = Math.min(left, 104857600);
      out.push({ name: `assets/f${i}.bin`, bytes: big(n) });
      left -= n;
    }
    return out;
  };
  const rows = [
    ["an empty archive", () => [], /the archive is empty/u],
    ["5001 entries", (e) => [...e, ...Array.from({ length: 4997 }, (_, i) => entry(`skills/wishlist/references/r${i}.md`))], /5001 entries: at most 5000/u],
    ["an entry of an empty path", (e) => [...e, entry("")], /an entry has an empty path/u],
    ["a path with outer whitespace", (e) => [...e, entry(" assets/a.md")], /begins or ends with whitespace/u],
    ["a path with a backslash", (e) => [...e, entry("assets\\a.md")], /uses a backslash/u],
    ["an absolute path", (e) => [...e, entry("/etc/passwd")], /the path is absolute/u],
    ["an empty segment", (e) => [...e, entry("assets//a.md")], /empty segment/u],
    ["a parent segment", (e) => [...e, entry("assets/../a.md")], /\.\. segment/u],
    ["21 segments", (e) => [...e, entry(`${Array.from({ length: 20 }, (_, i) => `d${i}`).join("/")}/a.md`)], /21 segments, at most 20/u],
    ["a member over 100 MiB", (e) => [...e, { name: "assets/big.bin", bytes: big(104857600 + 1) }], /over 100 MiB/u],
    ["an extracted size one byte over 512 MiB (536870912 bytes)", toTotal(536870913), /extracted archive is 536870913 bytes: at most 512 MiB/u],
    ["an extracted size of 599 MiB", toTotal(599 * 1048576), /extracted archive is 628097024 bytes: at most 512 MiB/u],
    ["a .DS_Store", (e) => [...e, entry(".DS_Store")], /operating system added/u],
    ["a __MACOSX folder", (e) => [...e, entry("__MACOSX/._a")], /operating system added/u],
    ["an AppleDouble file", (e) => [...e, entry("assets/._icon.png")], /operating system added/u],
    ["a duplicate after case normalization", (e) => [...e, entry("ASSETS/ICON.PNG", png(512))], /duplicate of assets\/icon\.png after case and Unicode normalization/u],
    ["a duplicate after Unicode normalization", (e) => [...e, entry("skills/wishlist/references/é.md"), entry("skills/wishlist/references/é.md")], /duplicate of .* after case and Unicode normalization/u],
    ["no plugin.json at the root", (e) => e.filter((x) => x.name !== "plugin.json"), /plugin\.json is missing at the archive root/u],
    ["a second plugin root in a folder", (e) => [...e, entry("other/plugin.json", "{}")], /plugin root ambiguous|makes the plugin root ambiguous/u],
    ["no skill", (e) => e.filter((x) => !x.name.startsWith("skills/")), /no skill/u],
    ["a manifest that is not JSON", (e) => e.map((x) => (x.name === "plugin.json" ? entry("plugin.json", "{ nope") : x)), /plugin\.json is not valid JSON/u],
    ["test credentials in the manifest", (e) => e.map((x) => (x.name === "plugin.json" ? entry("plugin.json", `${x.bytes.toString("utf8")}\n"test_credentials": "x"`) : x)), /test_credentials or reviewer_instructions/u],
    ["reviewer instructions in the manifest", (e) => e.map((x) => (x.name === "plugin.json" ? entry("plugin.json", `${x.bytes.toString("utf8")}\n"reviewer_instructions": "x"`) : x)), /test_credentials or reviewer_instructions/u],
    ["a logo that is not in the archive", (e) => e.filter((x) => x.name !== "assets/icon.png"), /interface\.logo names "\.\/assets\/icon\.png", which is not in the archive/u],
    ["a logo that is not a PNG", (e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", Buffer.from("x".repeat(64))) : x)), /is not a PNG file/u],
    ["a logo that is not square", (e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(512, 600)) : x)), /must be square, 48 to 4096 px \(it is 512x600\)/u],
    ["a logo of 47 px", (e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(47)) : x)), /48 to 4096 px \(it is 47x47\)/u],
    ["a logo of 4097 px", (e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(4097)) : x)), /48 to 4096 px \(it is 4097x4097\)/u],
    ["a logo over 5 MiB", (e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(512, 512, 5242880 + 1)) : x)), /over 5 MiB/u],
    ["a ZIP mcp.json without the auth block", withAuth((server) => { delete server.extensions; }), /needs extensions\.com\.openai\.auth/u],
    ["an empty OpenAI extension", withAuth((server) => { server.extensions["com.openai"] = {}; }), /extensions\.com\.openai\.auth is missing/u],
    ["mixed authentication", withAuth((server) => { server.extensions["com.openai"].auth.type = "mixed"; }), /auth\.type must be oauth/u],
    ["no authentication", withAuth((server) => { server.extensions["com.openai"].auth.type = "none"; }), /auth\.type must be oauth/u],
    ["an API key", withAuth((server) => { server.extensions["com.openai"].auth = { type: "api_key", headerScheme: "bearer" }; }), /auth\.type must be oauth/u],
    ["a registered client", withAuth((server) => { server.extensions["com.openai"].auth.client = { mode: "provided", clientId: "wishlist-client" }; }), /auth\.client must not set clientId/u],
    ["dynamic registration", withAuth((server) => { server.extensions["com.openai"].auth.client = { mode: "dcr" }; }), /auth\.client\.mode must be cimd/u],
    ["a client secret in the auth block", withAuth((server) => { server.extensions["com.openai"].auth.clientSecret = "abcdef"; }), /auth must not set clientSecret/u],
    ["an endpoint override", withAuth((server) => { server.extensions["com.openai"].auth.tokenUrl = "https://evil-app.com/token"; }), /auth must not set tokenUrl/u],
    ["no default scopes", withAuth((server) => { server.extensions["com.openai"].auth.defaultScopes = []; }), /defaultScopes must be a list of scope strings/u],
    ["a scope the server does not grant", withAuth((server) => { server.extensions["com.openai"].auth.defaultScopes = ["wishlist:read", "wishlist:admin"]; }), /defaultScopes must be exactly wishlist:read and wishlist:write/u],
    ["only the read scope", withAuth((server) => { server.extensions["com.openai"].auth.defaultScopes = ["wishlist:read"]; }), /defaultScopes must be exactly/u],
    ["another namespace under the server", withAuth((server) => { server.extensions["com.other"] = {}; }), /server extensions must not set com\.other/u],
    ["another key beside auth", withAuth((server) => { server.extensions["com.openai"].test_cases = {}; }), /server extensions\.com\.openai must not set test_cases/u],
    ["a second server", (e) => e.map((x) => (x.name === "mcp.json" ? entry("mcp.json", JSON.stringify({ ...goodMcp, mcpServers: { ...goodMcp.mcpServers, other: goodMcp.mcpServers.wishlist } })) : x)), /exactly one server, not 2/u],
    ["no mcp.json", (e) => e.filter((x) => x.name !== "mcp.json"), /mcp\.json is missing at the archive root/u],
    ["an mcp.json that is not JSON", (e) => e.map((x) => (x.name === "mcp.json" ? entry("mcp.json", "{ nope") : x)), /mcp\.json is not valid JSON/u],
    ["a secret in a text entry", (e) => [...e, entry("skills/wishlist/references/a.md", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n")], /credential or secret/u],
  ];

  for (const [label, change, expected] of rows) {
    const problems = archiveProblems(goodEntries(change));
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
  // The edges that are allowed: exactly 5000 entries, 20 segments, 48 px, 4096 px, 5 MiB, a member of exactly 100 MiB.
  const edges = [
    goodEntries((e) => [...e, ...Array.from({ length: 4996 }, (_, i) => entry(`skills/wishlist/references/r${i}.md`))]),
    goodEntries((e) => [...e, entry(`${Array.from({ length: 19 }, (_, i) => `d${i}`).join("/")}/a.md`)]),
    goodEntries((e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(48)) : x))),
    goodEntries((e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(4096)) : x))),
    goodEntries((e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", png(512, 512, 5242880)) : x))),
    goodEntries((e) => [...e, { name: "assets/exact.bin", bytes: big(104857600) }]),
    goodEntries(toTotal(536870912)), // exactly 512 MiB extracted: 5 x 100 MiB and 12 MiB, with the base entries counted
    goodEntries(toTotal(536870911)),
  ];
  for (const [index, entries] of edges.entries()) assert.deepEqual(archiveProblems(entries), [], `edge ${index} must pass`);
  assert.equal(edges[0].length, limits.entries);
  assert.deepEqual(compressedProblems({ length: 100 * 1000 * 1000 }), []);
  assert.match(compressedProblems({ length: 100 * 1000 * 1000 + 1 })[0], /at most 100 MB/u);
});

test("the ZIP writer and reader agree, and a damaged archive is refused", () => {
  const entries = [entry("b/é-ключ.md", "Ключ\n".repeat(50)), entry("a.txt", "one\n"), entry("c.bin", Buffer.from([0, 1, 2, 3, 250, 251]))];
  const zip = writeZip(entries);
  const back = readZip(zip).entries;

  assert.deepEqual(back.map((e) => e.name), ["a.txt", "b/é-ключ.md", "c.bin"], "sorted, UTF-8 names kept");
  assert.equal(back[1].bytes.toString("utf8"), "Ключ\n".repeat(50));
  assert.equal(back[1].method, 8, "text is deflated");
  assert.equal(back[2].method, 0, "a body that does not shrink is stored");
  const flipped = Buffer.from(zip);
  flipped[flipped.indexOf(Buffer.from("one\n"))] ^= 1; // a stored byte changes, the CRC does not
  assert.throws(() => readZip(flipped), /CRC does not match|size does not match/u);
  assert.throws(() => readZip(Buffer.from("not a zip at all")), /not a ZIP/u);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 5)), /not a ZIP/u);
  const unknownMethod = Buffer.from(zip);
  unknownMethod.writeUInt16LE(99, unknownMethod.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  assert.throws(() => readZip(unknownMethod), /unsupported compression method 99/u);
  const encrypted = Buffer.from(zip);
  encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  assert.throws(() => readZip(encrypted), /encrypted entries are not supported/u);
});

test("the package icon is 512x512 and the form icon 256x256 and at most 10 KB, both a solid square without transparency or metadata", () => {
  const files = [["plugin/assets/icon.png", 512], [formIconPath, 256]];

  for (const [file, size] of files) {
    const bytes = readFileSync(join(root, file));
    const png = readPng(bytes);

    assert.equal(png.width, size, `${file} width`);
    assert.equal(png.height, size, `${file} height`);
    assert.ok(!png.chunks.includes("tRNS") && png.colorType !== 4 && png.colorType !== 6, `${file} has no transparency`);
    for (const chunk of ["tIME", "tEXt", "iTXt", "zTXt", "eXIf"]) assert.ok(!png.chunks.includes(chunk), `${file} carries no ${chunk} chunk`);
    // A square, not a circle: the four corners and the middle of every edge are the same opaque colour, and the middle of the picture is another.
    const last = size - 1;
    const middle = size >> 1;
    const background = png.pixel(0, 0);
    assert.equal(background[3], 255);
    for (const [x, y] of [[last, 0], [0, last], [last, last], [middle, 0], [middle, last], [0, middle], [last, middle]]) assert.deepEqual(png.pixel(x, y), background, `${file}: pixel ${x},${y} is the background`);
    // The white heart is in the middle: some pixel of the inner half is white or nearly white (the edge of a shape is smoothed).
    let white = false;
    for (let y = size >> 2; y < (size * 3) >> 2 && !white; y += 1) for (let x = size >> 2; x < (size * 3) >> 2; x += 1) if (Math.min(...png.pixel(x, y).slice(0, 3)) >= 250) { white = true; break; }
    assert.ok(white, `${file}: a white heart in the middle`);
  }
  assert.ok(readFileSync(join(root, formIconPath)).length <= formIconMaxBytes, "the form takes up to 10 KB");
  assert.equal(formIconMaxBytes, 10_000);
});

test("the ZIP carries the package icon only, and the build copies the committed form icon byte for byte", () => {
  const { entries, icon } = build(root);

  assert.deepEqual(entries.filter((e) => e.name.startsWith("assets/")).map((e) => e.name), ["assets/icon.png"]);
  assert.ok(entries.find((e) => e.name === "assets/icon.png").bytes.equals(readFileSync(join(root, "plugin/assets/icon.png"))));
  assert.ok(icon.bytes.equals(readFileSync(join(root, formIconPath))), "the form icon is the committed file, not a generated one");
});

test("the form icon has its own rules: present, a PNG, 256 px, at most 10,000 bytes, no transparency, no metadata", () => {
  const png256 = readFileSync(join(root, formIconPath));
  const withChunk = (name, body = Buffer.alloc(1)) => {
    const chunk = Buffer.alloc(12 + body.length);
    chunk.writeUInt32BE(body.length, 0);
    chunk.write(name, 4, "latin1");
    body.copy(chunk, 8);
    return Buffer.concat([png256.subarray(0, 33), chunk, png256.subarray(33)]);
  };
  const rows = [
    ["missing", (d) => rmSync(join(d, formIconPath)), /is missing/u],
    ["not a PNG", (d) => writeFileSync(join(d, formIconPath), Buffer.from("x".repeat(64))), /is not a PNG file/u],
    ["257 px", (d) => writeFileSync(join(d, formIconPath), png(257)), /must be 256x256 px \(it is 257x257\)/u],
    ["255 px", (d) => writeFileSync(join(d, formIconPath), png(255)), /must be 256x256 px/u],
    ["10,001 bytes", (d) => writeFileSync(join(d, formIconPath), Buffer.concat([png256, Buffer.alloc(10_001 - png256.length)])), /at most 10000 bytes \(the form takes up to 10 KB; it is 10001\)/u],
    ["a time chunk", (d) => writeFileSync(join(d, formIconPath), withChunk("tIME", Buffer.alloc(7))), /carries a metadata chunk \(tIME\)/u],
    ["a text chunk", (d) => writeFileSync(join(d, formIconPath), withChunk("tEXt", Buffer.from("path\0/Users/x"))), /carries a metadata chunk \(tEXt\)/u],
    ["a transparency chunk", (d) => writeFileSync(join(d, formIconPath), withChunk("tRNS")), /must not be transparent/u],
    ["a package icon with a time chunk", (d) => writeFileSync(join(d, "plugin/assets/icon.png"), (() => { const b = readFileSync(join(d, "plugin/assets/icon.png")); const c = Buffer.alloc(19); c.writeUInt32BE(7, 0); c.write("tIME", 4, "latin1"); return Buffer.concat([b.subarray(0, 33), c, b.subarray(33)]); })()), /carries a metadata chunk \(tIME\)/u],
  ];

  assert.deepEqual(withCopy(() => {}, (d) => checkPackage(d)), []);
  for (const [label, change, expected] of rows) {
    const problems = withCopy(change, (d) => checkPackage(d));
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected ${expected}, got ${JSON.stringify(problems)}`);
  }
  // Exactly 10,000 bytes and exactly 256 px pass: the edge is inclusive.
  const edge = withCopy((d) => writeFileSync(join(d, formIconPath), Buffer.concat([png256, Buffer.alloc(Math.max(0, 10_000 - png256.length))])), (d) => checkPackage(d));
  assert.deepEqual(edge.filter((p) => /form icon|chatgpt-form-icon/u.test(p)), []);
});

test("a package that fails its own rules builds nothing", () => {
  const problems = withCopy(editJson("plugin/plugin.json", (m) => { m.extensions["com.openai"].interface.shortDescription = "x".repeat(31); }), (directory) => {
    try {
      build(directory);
      return [];
    } catch (error) {
      return [error.message];
    }
  });

  assert.ok(problems.some((p) => /the package check fails, so nothing is built/u.test(p) && /shortDescription is 31 characters/u.test(p)), JSON.stringify(problems));
});

test("the manifests come from one source, writing them again changes nothing, and a rename is one edit", () => {
  const source = readSource(root);

  assert.deepEqual(manifestSyncProblems(root), []);
  assert.deepEqual(Object.keys(buildManifests(source)).sort(), [...generatedFiles].sort());
  const unchanged = withCopy(() => {}, (directory) => {
    writeManifests(directory);
    return generatedFiles.every((file) => readFileSync(join(directory, file), "utf8") === readFileSync(join(root, file), "utf8"));
  });
  assert.equal(unchanged, true, "pnpm manifests is idempotent on the committed files");

  // One edit renames the plugin everywhere: the source, then the generator, and the package rules are satisfied again.
  const renamed = withCopy(editJson("plugin-source.json", (m) => { m.name = "wishlist-gifts"; m.marketplace.name = "wishlist-gifts-plugins"; }), (directory) => {
    assert.ok(manifestSyncProblems(directory).length >= 5, "before the generator runs every manifest is out of date");
    writeManifests(directory);
    // The two server files hold the server's own name (`mcp.serverName`), not the plugin's; every other manifest names the plugin.
    return { problems: checkPackage(directory), names: generatedFiles.filter((file) => !/mcp\.json$/u.test(file)).map((file) => JSON.stringify(JSON.parse(readFileSync(join(directory, file), "utf8")))) };
  });

  assert.deepEqual(renamed.problems, []);
  for (const text of renamed.names) assert.match(text, /wishlist-gifts/u);
  assert.ok(!renamed.names.some((text) => /"name":"wishlist"[,}]/u.test(text)), "no manifest keeps the old name");

  const missing = withCopy((directory) => rmSync(join(directory, "plugin-source.json")), (directory) => checkPackage(directory));
  assert.ok(missing.some((p) => /plugin-source\.json is missing/u.test(p)), JSON.stringify(missing));
  const broken = withCopy((directory) => writeFileSync(join(directory, "plugin-source.json"), "{ nope"), (directory) => checkPackage(directory));
  assert.ok(broken.some((p) => /plugin-source\.json is not valid JSON/u.test(p)), JSON.stringify(broken));
  const absent = withCopy((directory) => rmSync(join(directory, "plugin", ".mcp.json")), (directory) => checkPackage(directory));
  assert.ok(absent.some((p) => /plugin\/\.mcp\.json is missing/u.test(p)), JSON.stringify(absent));
});

test("the listing fields of the committed manifests are inside OpenAI's final-submission limits, at the edge too", () => {
  const listing = JSON.parse(readFileSync(join(root, "plugin/plugin.json"), "utf8")).extensions["com.openai"].interface;

  assert.ok(listing.shortDescription.length <= 30, `${listing.shortDescription.length}`);
  assert.ok(listing.displayName.length <= 30);
  assert.ok(listing.longDescription.length <= 4000);
  assert.ok(listing.developerName.length <= 80);
  assert.ok(listing.capabilities.length <= 20 && listing.capabilities.every((c) => c.length <= 120));
  assert.ok(listing.defaultPrompt.length <= 3 && listing.defaultPrompt.every((p) => p.length <= 128 && !p.includes("@")));
  // The limits themselves are inclusive: exactly 30, 30, 4000, 80, 20, 120, 3 and 128 pass.
  const atTheEdge = withCopy(editJson("plugin/plugin.json", (m) => {
    const l = m.extensions["com.openai"].interface;
    l.shortDescription = "s".repeat(30);
    l.displayName = "d".repeat(30);
    l.longDescription = "l".repeat(4000);
    l.developerName = "v".repeat(80);
    l.capabilities = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(120, "c"));
    l.defaultPrompt = ["a", "b", "c"].map((c) => c.repeat(128));
    m.extensions["com.openai"].publication.translations["uk-UA"].subtitle = "я".repeat(30);
    l.privacyPolicyURL = `https://domain-pending.invalid/${"x".repeat(993)}`; // 1024 characters: the edge passes, 1025 fails (tests/package.test.mjs)
  }), (directory) => checkPackage(directory).filter((p) => !/differs/u.test(p) && !/generates/u.test(p)));

  assert.deepEqual(atTheEdge, []);
});

// The ZIP carries a shorter variant of the photo skill. There is one source text; the ZIP build cuts the marked parts.
const instagram = /instagram|cdninstagram|fbcdn|instagr\.am|ig\.me/iu;

test("no file of the ZIP names Instagram, and the full skill still does", () => {
  const { zip, entries } = build(root);

  for (const { name, bytes } of readZip(zip).entries) {
    if (name.endsWith(".png")) continue;
    const text = bytes.toString("utf8");
    assert.doesNotMatch(text, instagram, `${name} in the ZIP must not name Instagram, cdninstagram or fbcdn`);
    assert.doesNotMatch(text, /zip-omit|zip-instead|<!--/iu, `${name} in the ZIP must carry no build marker`);
  }
  assert.ok(entries.some((e) => e.name === "skills/wishlist-add-photos/SKILL.md"), "the photo skill stays in the ZIP, without its Instagram part");
  // The README of the ZIP is the user's README, unchanged.
  assert.equal(entries.find((e) => e.name === "README.md").bytes.toString("utf8"), readFileSync(join(root, "plugin/README.md"), "utf8"));
  const full = readFileSync(join(root, "plugin/skills/wishlist-add-photos/SKILL.md"), "utf8");
  for (const word of ["Instagram", "cdninstagram", "fbcdn"]) assert.ok(full.includes(word), `plugin/skills must keep ${word} for Claude and Codex`);
  // The other skills are carried as they are, and the cut skill keeps its rules about pictures.
  for (const name of ["wishlist", "wishlist-add-from-links", "wishlist-price-check"]) {
    const inZip = entries.find((e) => e.name === `skills/${name}/SKILL.md`).bytes.toString("utf8");
    assert.equal(inZip, readFileSync(join(root, "plugin/skills", name, "SKILL.md"), "utf8"), `${name} must not change in the ZIP`);
  }
  const cut = entries.find((e) => e.name === "skills/wishlist-add-photos/SKILL.md").bytes.toString("utf8");
  for (const kept of ["## Which addresses count", "## How far you go", "add_wish_photos", "Never uses Facebook, Pinterest or any page behind a login."]) assert.ok(cut.includes(kept), `the ZIP's photo skill must keep: ${kept}`);
  // The small loop with hard limits and the stop rule are the same words as in the full skill.
  for (const pattern of [/at most 8 (?:distinct )?candidates/iu, /at most 2 rounds/iu, /no address (?:is )?looked at twice/iu, /stop after the second round/iu, /never a third round/iu]) assert.match(cut, pattern);
  assert.ok(!cut.includes("## Instagram"));
  // A link to a social network is neither opened nor left to the model: the ZIP's step 1 says so without naming any network.
  assert.ok(cut.includes(zipOnlyStepOne), "the ZIP's photo skill must carry the neutral social-network sentence");
  assert.ok(!full.includes("A link to a social-network profile or post is not opened"), "the neutral sentence exists only in the ZIP");
  for (const { name } of readZip(zip).entries) assert.doesNotMatch(name, instagram, name);
  // What Claude and Codex read is the full text: with the markers removed it holds every Instagram rule and no ZIP-only wording.
  const seen = full.replace(/<!--\s*\/?zip-omit\s*-->\n?/gu, "");
  assert.ok(seen.includes(descriptionSentence), "the description of the full skill keeps its Instagram sentence");
  assert.ok(seen.includes("## Instagram"));
  assert.ok(seen.includes('say "the picture from the listing" or "from the shop\'s page" or "from the Instagram profile of the account", and name'), "the clause reads as one list in the full text");
  assert.ok(seen.includes("If it is a public Instagram profile or post, follow **Instagram** below."));
  assert.doesNotMatch(seen, /\bor "from the shop's page"\s+or "from the shop's page"/u, "no duplicated clause");
});

test("there is one copy of each skill, and the claude and codex packages are not built from the ZIP variant", () => {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "SKILL.md") found.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), ["plugin/skills/wishlist-add-from-links/SKILL.md", "plugin/skills/wishlist-add-photos/SKILL.md", "plugin/skills/wishlist-price-check/SKILL.md", "plugin/skills/wishlist/SKILL.md"]);
  // The committed payload (what Claude Code and Codex install) is untouched by the ZIP build.
  const before = readFileSync(join(root, "plugin/skills/wishlist-add-photos/SKILL.md"), "utf8");
  build(root);
  assert.equal(readFileSync(join(root, "plugin/skills/wishlist-add-photos/SKILL.md"), "utf8"), before);
});

test("the cutter handles a block, an inline clause and a replacement, and refuses malformed markers and a moved description sentence", () => {
  const photos = (body, description = "d.") => `---\nname: wishlist-add-photos\ndescription: ${description}\n---\n${body}`;

  assert.equal(forOpenAi("skills/x/SKILL.md", "a<!-- zip-omit --> Instagram<!-- /zip-omit --> b"), "a b");
  assert.equal(forOpenAi("skills/x/SKILL.md", "one\n\n<!-- zip-omit -->\n## Instagram\ntext\n<!-- /zip-omit -->\n\n## Next\n"), "one\n\n\n## Next\n".replace("\n\n\n", "\n\n"));
  // The photo skill's description sentence is cut by its exact text, and the build fails when that text moves.
  const sentence = " Reads a public Instagram profile only as a logged-out visitor in a real browser, never logs in.";
  const step = "1. The page the person gave you (a link in their message, or in the wish's own `links`).";
  assert.equal(forOpenAi("skills/wishlist-add-photos/SKILL.md", photos(`${step}\n`, `Finds pictures.${sentence} Never uses Facebook.`)), photos(`${zipOnlyStepOne}\n`, "Finds pictures. Never uses Facebook."));
  assert.throws(() => forOpenAi("skills/wishlist-add-photos/SKILL.md", photos("1. Another first step.\n", `Finds pictures.${sentence}`)), /step 1 of «Where to look» is not where/u);
  // A text that is not cut is carried byte for byte, three blank lines included (another skill is never reflowed).
  assert.equal(forOpenAi("skills/y/SKILL.md", "a\n\n\n\nb\n"), "a\n\n\n\nb\n");
  assert.throws(() => forOpenAi("skills/wishlist-add-photos/SKILL.md", photos("1. x\n", "Finds pictures. Reads Instagram differently.")), /description sentence that names Instagram/u);
  for (const [label, text, expected] of [
    ["an open without a close", "a <!-- zip-omit --> b", /1 zip-omit markers open and 0 close/u],
    ["a close without an open", "a <!-- /zip-omit --> b", /0 zip-omit markers open and 1 close/u],
    ["nested pairs", "<!-- zip-omit --> a <!-- zip-omit --> b <!-- /zip-omit --> c <!-- /zip-omit -->", /nested or out of order/u],
    ["a close before its open", "<!-- /zip-omit --> a <!-- zip-omit -->", /nested or out of order/u],
    ["a marker in capitals", "a <!-- ZIP-OMIT --> b <!-- /ZIP-OMIT --> c", /looks like a build marker but is not one/u],
    ["a marker with an underscore", "a <!-- zip_omit --> b <!-- /zip_omit --> c", /looks like a build marker but is not one/u],
    ["a replacement marker (not supported: it would be read as text by Claude)", "a <!-- zip-omit --> b <!-- zip-instead --> c <!-- /zip-omit -->", /looks like a build marker but is not one/u],
    ["an omit-looking comment", "a <!-- omit this --> b", /looks like a build marker but is not one/u],
  ]) {
    assert.ok(markerProblems("x", text).some((p) => expected.test(p)), `${label}: ${JSON.stringify(markerProblems("x", text))}`);
    assert.throws(() => forOpenAi("skills/x/SKILL.md", text), expected, label);
  }
  // The package rules refuse a malformed marker in the payload, and the archive rules refuse Instagram in any text of the ZIP.
  const broken = withCopy(editSkill("a <!-- zip-omit --> b"), (directory) => checkPackage(directory));
  assert.ok(broken.some((p) => /1 zip-omit markers open and 0 close/u.test(p)), JSON.stringify(broken));
  for (const text of ["See Instagram.", "https://scontent.cdninstagram.com/x.jpg", "https://scontent.xx.fbcdn.net/y.jpg", "INSTAGRAM", "https://instagr.am/p/x", "https://ig.me/m/x"]) {
    const problems = archiveProblems(goodEntries((e) => [...e, entry("skills/wishlist/references/a.md", text)]));
    assert.ok(problems.some((p) => /names Instagram, which the ZIP variant leaves out/u.test(p)), `${text}: ${JSON.stringify(problems)}`);
  }
});

test("an Instagram word hides neither in a file name nor in a text file called .png, and an image is told by its bytes", () => {
  const named = archiveProblems(goodEntries((e) => [...e, entry("skills/instagram/SKILL.md", "---\nname: x\n---\n")]));
  assert.ok(named.some((p) => /skills\/instagram\/SKILL\.md: names Instagram/u.test(p)), JSON.stringify(named));
  const disguised = archiveProblems(goodEntries((e) => [...e, entry("assets/notes.png", "See Instagram for the pictures.")]));
  assert.ok(disguised.some((p) => /assets\/notes\.png: names Instagram/u.test(p)), JSON.stringify(disguised));
  const secret = archiveProblems(goodEntries((e) => [...e, entry("assets/notes.webp", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789")]));
  assert.ok(secret.some((p) => /credential or secret/u.test(p)), JSON.stringify(secret));
  // A real image is not read as text: its bytes may hold anything.
  assert.equal(isImage(readFileSync(join(root, "plugin/assets/icon.png"))), true);
  assert.equal(isImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), true);
  assert.equal(isImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), true);
  assert.equal(isImage(Buffer.from("plain text, not an image")), false);
  const realImage = archiveProblems(goodEntries((e) => e.map((x) => (x.name === "assets/icon.png" ? entry("assets/icon.png", Buffer.concat([png(512), Buffer.from("instagram")])) : x))));
  assert.ok(!realImage.some((p) => /names Instagram/u.test(p)), "bytes behind a real image header are not read as text");
});

function editSkill(extra) {
  return (directory) => {
    const path = join(directory, "plugin/skills/wishlist-price-check/SKILL.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n${extra}\n`);
  };
}
