// The ZIP carries a shorter variant of the photo skill. There is ONE source text: the parts that exist only for the full package are wrapped in markers inside `plugin/skills/**/SKILL.md`, and the
// ZIP build cuts them out; no second copy of any skill exists.
//
//   <!-- zip-omit -->  text for the full package only  <!-- /zip-omit -->
//
// A marker may stand on its own lines (a whole section) or inside a line (a clause). There is no replacement text inside a marker: a
// replacement would be read by Claude and Codex as ordinary text, so a sentence that must differ is written so that cutting a clause
// leaves a good sentence. The two things that exist only in the ZIP are fixed in this file: the sentence of the photo skill's
// `description` that names Instagram is cut by its exact text (a comment in the front matter would be read as text by the other
// clients), and one neutral sentence is added to the photo skill's step 1 (see `zipOnlyStepOne`). The build fails if either anchor moved.

export const instagramPattern = /instagram|cdninstagram|fbcdn|instagr\.am|ig\.me/iu;

const block = /<!--\s*zip-omit\s*-->([\s\S]*?)<!--\s*\/zip-omit\s*-->/gu;

/** The exact sentence of the photo skill's description that names Instagram (cut from the ZIP's copy). */
export const descriptionSentence = " Reads a public Instagram profile only as a logged-out visitor in a real browser, never logs in.";

/** Step 1 of «Where to look» in the photo skill, as it stands once the Instagram clause is cut, and what the ZIP says there instead. */
const stepOne = "1. The page the person gave you (a link in their message, or in the wish's own `links`).";
export const zipOnlyStepOne = `${stepOne} A link to a social-network profile or post is not opened: use the account's name as the name of the place and look for its official site (step 2).`;

const photoSkill = /wishlist-add-photos\/SKILL\.md$/u;

/** Whether the markers of a text are well formed: every open has its close, none nested or stray, and no comment that merely looks like a marker. */
export function markerProblems(label, text) {
  const problems = [];
  const opens = [...text.matchAll(/<!--\s*zip-omit\s*-->/gu)].length;
  const closes = [...text.matchAll(/<!--\s*\/zip-omit\s*-->/gu)].length;

  if (opens !== closes) problems.push(`${label}: ${opens} zip-omit markers open and ${closes} close`);
  if (/<!--\s*\/?zip-omit\s*-->/u.test(text.replace(block, ""))) problems.push(`${label}: a zip-omit marker is nested or out of order`);
  // A marker written in another case or spelling would pass through the build untouched, with its text: refuse any comment that mentions zip and is not exact.
  for (const [comment] of text.matchAll(/<!--[\s\S]*?-->/gu)) {
    if (/zip|omit/iu.test(comment) && !/^<!--\s*\/?zip-omit\s*-->$/u.test(comment)) problems.push(`${label}: ${JSON.stringify(comment)} looks like a build marker but is not one (the spelling is <!-- zip-omit --> and <!-- /zip-omit -->)`);
  }
  return problems;
}

/** One skill text as the OpenAI package carries it. Throws when a marker is malformed or an anchor of this file moved. */
export function forOpenAi(label, text) {
  const bad = markerProblems(label, text);

  if (bad.length > 0) throw new Error(bad.join("\n"));
  let out = text.replace(block, "");

  if (photoSkill.test(label)) {
    if (!text.includes(descriptionSentence)) throw new Error(`${label}: the description sentence that names Instagram is not where the OpenAI build cuts it`);
    out = out.replace(descriptionSentence, "");
    if (!out.includes(stepOne)) throw new Error(`${label}: step 1 of «Where to look» is not where the OpenAI build adds its neutral sentence`);
    out = out.replace(stepOne, zipOnlyStepOne);
  }
  // Blank lines left by a cut block are collapsed, and only in a text that was cut (another skill is carried byte for byte).
  return out === text ? out : out.replace(/\n{3,}/gu, "\n\n");
}
