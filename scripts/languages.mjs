import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { packagesOf, readLocales } from "./manifests.mjs";

// Two packages, one meaning. The Ukrainian package is the main one and the English package is kept beside it: these rules fail when
// the two stop saying the same thing in the same shape (the skills, their limits and identifiers, the headings, the links), and when a
// language leaks into the other one (an untranslated Ukrainian word in English text, an English label word in Ukrainian prose).

const descriptionLimit = 1024;

/** `{ meta, body }` of a SKILL.md: the front matter lines and the rest. */
function splitSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);

  return match ? { meta: match[1], body: match[2] } : { meta: "", body: text };
}

const metaValue = (meta, key) => new RegExp(`^${key}:\\s*(.*)$`, "mu").exec(meta)?.[1]?.trim();

/** The structure of a Markdown text: headings by level, numeric tokens, code spans, links, markers. Comparable across languages. */
export function shapeOf(text) {
  const withoutFences = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, "");
  const fences = [...text.matchAll(/^(```|~~~)[^\n]*\n([\s\S]*?)^\1/gmu)].map((m) => m[2].trim().replace(/\bwishlist-en@/gu, "wishlist@")); // the English package has its own name
  const spans = [...withoutFences.matchAll(/`([^`\n]+)`/gu)].map((m) => m[1]);
  const withoutCode = withoutFences.replace(/`[^`\n]*`/gu, " ");

  return {
    headings: [...text.matchAll(/^(#{1,6}) /gmu)].map((m) => m[1].length).join(""),
    numbers: [...new Set([...withoutCode.matchAll(/\d+(?:[.,:×x]\d+)*/gu)].map((m) => m[0].replace(",", ".")))].sort(),
    spans: [...new Set(spans)].sort(),
    fences,
    // The English files carry `.en` in their names and live in `plugin-en/`: the two languages link to their own file, so the names are compared without it.
    urls: [...new Set([...text.matchAll(/https?:\/\/[^\s)>\]"'`]+/gu)].map((m) => m[0].replace(/[.,;:]+$/u, "").replace(/\.en\.md/u, ".md")))].sort(),
    markers: (text.match(/<!--\s*\/?zip-omit\s*-->/gu) ?? []).length,
  };
}

function diff(label, a, b, problems) {
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} differs between the languages: ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
}

/** The Latin words left in Ukrainian prose once code, links, quotes and bold labels are taken out; product names are allowed. */
const allowedLatin = new Set(["wishlist", "telegram", "chatgpt", "claude", "codex", "code", "openai", "anthropic", "mcp", "oauth", "url", "github", "zip", "mit", "cookie", "png", "jpeg", "webp", "avif", "gif", "svg", "kb", "mb", "oidc", "cimd", "https", "http", "id", "ai", "api", "ok"]);

export function latinWords(text) {
  const prose = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gmu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/\*\*[^*\n]+\*\*/gu, " ")
    .replace(/«[^»\n]*»/gu, " ")
    .replace(/\[[^\]\n]*\]\([^)\n]*\)/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/<[^>\n]+>/gu, " ");

  return [...new Set([...prose.matchAll(/[A-Za-z]{3,}(?:'[A-Za-z]+)?/gu)].map((m) => m[0]).filter((word) => !allowedLatin.has(word.toLowerCase())))];
}

/** The Cyrillic lines of an English text that are neither a quoted screen of the bot nor say that they quote the Ukrainian bot. */
export function cyrillicLines(text) {
  return text.split("\n").filter((line) => /[Ѐ-ӿ]/u.test(line) && !/Ukrainian/u.test(line) && !/^\[Українською\]\(/u.test(line) && !/«[^»]*[Ѐ-ӿ][^»]*»/u.test(line));
}

function skillsOf(root, dir) {
  const folder = join(root, dir, "skills");

  if (!existsSync(folder)) return {};
  const skills = {};

  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name, "SKILL.md");

    if (entry.isDirectory() && existsSync(file)) skills[entry.name] = readFileSync(file, "utf8");
  }
  return skills;
}

const read = (root, file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null);

export function languageProblems(root, source) {
  const problems = [];
  const packs = packagesOf(source);
  const main = packs.find((pack) => pack.id === source.main);
  const others = packs.filter((pack) => pack.id !== source.main);
  let locales;

  try {
    locales = readLocales(root, source);
  } catch {
    return problems; // the missing locale is said by the manifest check
  }
  const isEnglish = (pack) => pack.id === "en";

  for (const other of others) {
    const label = `${main.id} and ${other.id}`;
    const left = skillsOf(root, main.dir);
    const right = skillsOf(root, other.dir);

    diff(`the skills of ${label}`, Object.keys(left).sort(), Object.keys(right).sort(), problems);
    for (const name of Object.keys(left).filter((n) => n in right)) {
      const a = splitSkill(left[name]);
      const b = splitSkill(right[name]);

      diff(`the YAML name of the skill ${name} (${label})`, metaValue(a.meta, "name"), metaValue(b.meta, "name"), problems);
      for (const [pack, part] of [[main, a], [other, b]]) {
        const description = metaValue(part.meta, "description") ?? "";
        if (description.length === 0 || description.length > descriptionLimit) problems.push(`${pack.dir}/skills/${name}: the description is ${description.length} characters, it must be 1 to ${descriptionLimit}`);
      }
      const shapeA = shapeOf(a.body);
      const shapeB = shapeOf(b.body);

      for (const key of ["headings", "numbers", "spans", "fences", "urls", "markers"]) diff(`${key} of the skill ${name} (${label})`, shapeA[key], shapeB[key], problems);
    }
    // The READMEs and the guide come in pairs with the same shape.
    for (const [mainFile, otherFile] of [["README.md", "README.en.md"], [`${main.dir}/README.md`, `${other.dir}/README.md`], ["docs/chatgpt.md", "docs/chatgpt.en.md"]]) {
      const a = read(root, mainFile);
      const b = read(root, otherFile);

      if (a === null || b === null) {
        problems.push(`${a === null ? mainFile : otherFile} is missing: every text has a ${main.id} and an ${other.id} version`);
        continue;
      }
      const shapeA = shapeOf(a);
      const shapeB = shapeOf(b);

      for (const key of ["headings", "fences", "urls"]) diff(`${key} of ${mainFile} and ${otherFile}`, shapeA[key], shapeB[key], problems);
    }
  }
  // The words of one language stay in that language.
  for (const pack of packs) {
    const english = isEnglish(pack);
    const files = [`${pack.dir}/README.md`, ...Object.keys(skillsOf(root, pack.dir)).map((name) => `${pack.dir}/skills/${name}/SKILL.md`)];

    if (english) files.push("README.en.md", "docs/chatgpt.en.md");
    else files.push("README.md", "docs/chatgpt.md");
    for (const file of files) {
      const text = read(root, file);

      if (text === null) continue;
      if (english) {
        const lines = cyrillicLines(text);
        if (lines.length > 0) problems.push(`${file}: Cyrillic in English text outside a quoted screen of the bot: ${lines[0].slice(0, 70)}`);
      } else {
        const body = file.endsWith("SKILL.md") ? splitSkill(text) : { meta: "", body: text };
        const description = metaValue(body.meta, "description") ?? "";
        const words = latinWords(`${body.body}\n${description}`);

        if (words.length > 0) problems.push(`${file}: English words in Ukrainian text (put a product name in the allowlist or translate): ${words.slice(0, 6).join(", ")}`);
      }
    }
    // The locale file of the language.
    const strings = JSON.stringify(locales[pack.id]);

    if (english && /[Ѐ-ӿ]/u.test(strings)) problems.push(`${pack.locale}: Cyrillic in the English locale`);
    if (!english) {
      const words = latinWords(Object.values(locales[pack.id]).flat().filter((value) => typeof value === "string").join("\n"));
      if (words.length > 0) problems.push(`${pack.locale}: English words in the Ukrainian locale: ${words.slice(0, 6).join(", ")}`);
    }
  }
  return problems;
}
