// Word/quote generation following monkeytype's words-generator.ts logic.
import type { Config } from "./config";
import { loadBestLanguage, loadQuotes, type Quote } from "./data";

function random(): number {
  return Math.random();
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

const SENTENCE_ENDERS = new Set([".", "?", "!", "।", "。", "？", "！", "؟"]);

function lastChar(s: string | undefined): string | undefined {
  if (!s || s.length === 0) return undefined;
  return [...s].pop();
}

function randomNumberWord(): string {
  const r = random();
  if (r < 0.6) return String(Math.floor(random() * 100)); // 0-99
  if (r < 0.85) return String(Math.floor(random() * 1000)); // 0-999
  if (r < 0.95) return String(Math.floor(random() * 10000)); // big
  return String(1950 + Math.floor(random() * 100)); // year-ish
}

/**
 * Punctuate a word, following monkeytype's punctuateWord():
 * capitalize at sentence starts, ~10% sentence enders, small chances of
 * quotes/parens, and commas/semicolons/colons.
 */
export function punctuateWord(
  previousWord: string | undefined,
  currentWord: string,
  index: number,
  maxIndex: number,
  language: string,
): string {
  let word = currentWord;
  const lang = language.split("_")[0] ?? "english";
  const prev = lastChar(previousWord);

  const isSentenceEnder = prev !== undefined && SENTENCE_ENDERS.has(prev);

  if (lang !== "code" && lang !== "georgian" && (index === 0 || isSentenceEnder)) {
    word = capitalize(word);
    if (lang === "turkish") word = word.replace(/I/g, "İ");
  } else if (
    (random() < 0.1 && prev !== "." && prev !== "," && index !== maxIndex - 2) ||
    index === maxIndex - 1
  ) {
    const rand = random();
    if (rand <= 0.8) {
      if (lang === "nepali" || lang === "bangla" || lang === "hindi") word += "।";
      else if (lang === "japanese" || lang === "chinese") word += "。";
      else word += ".";
    } else if (rand < 0.9) {
      if (lang === "arabic" || lang === "persian" || lang === "urdu" || lang === "kurdish")
        word += "؟";
      else if (lang === "greek") word += ";";
      else if (lang === "japanese" || lang === "chinese") word += "？";
      else word += "?";
    } else {
      if (lang === "japanese" || lang === "chinese") word += "！";
      else word += "!";
    }
  } else if (random() < 0.01 && prev !== "," && prev !== "." && lang !== "russian") {
    word = `"${word}"`;
  } else if (
    random() < 0.011 &&
    prev !== "," &&
    prev !== "." &&
    !["russian", "ukrainian", "slovak"].includes(lang)
  ) {
    word = `'${word}'`;
  } else if (random() < 0.012 && prev !== "," && prev !== ".") {
    if (lang === "japanese" || lang === "chinese") word = `（${word}）`;
    else if (lang.startsWith("code")) {
      const brackets = ["()", "{}", "[]", "<>"];
      if (language.startsWith("code_javascript")) brackets.push("``");
      const b = brackets[Math.floor(random() * brackets.length)]!;
      word = `${b[0]}${word}${b[1]}`;
    } else word = `(${word})`;
  } else if (random() < 0.013 && prev !== "," && prev !== "." && index < maxIndex - 3) {
    const rand = random();
    if (rand <= 0.8) word += ",";
    else if (rand < 0.9) {
      if (lang === "greek") word += "·";
      else word += ";";
    } else word += ":";
  }
  return word;
}

/** Generate `count` raw words from a language, applying numbers mode. */
export async function generateWords(cfg: Config, count: number): Promise<string[]> {
  const lang = await loadBestLanguage(cfg.language);
  const pool = lang.words;
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    // avoid repeating the previous word (monkeytype behavior)
    let w = pool[Math.floor(random() * pool.length)]!;
    let guard = 0;
    while (words.length > 0 && w === words[words.length - 1] && guard++ < 10) {
      w = pool[Math.floor(random() * pool.length)]!;
    }
    if (cfg.numbers && random() < 0.08) w = randomNumberWord();
    words.push(w);
  }
  return words;
}

/** Apply punctuation to a word list. */
export function applyPunctuation(words: string[], language: string): string[] {
  return words.map((w, i) =>
    punctuateWord(words[i - 1], w, i, words.length + 1, language),
  );
}

export interface BuiltTest {
  words: string[];
  quoteSource?: string;
  quoteId?: number;
  quoteGroup?: number;
}

/** Build the full word list for a test. */
export async function buildTest(cfg: Config): Promise<BuiltTest> {
  if (cfg.mode === "quote") {
    const q = await pickQuote(cfg);
    const text = q ? q.text : "no quotes found for this language";
    return {
      words: text.split(/\s+/).filter((w) => w.length > 0),
      quoteSource: q?.source,
      quoteId: q?.id,
      quoteGroup: q?.group,
    };
  }
  if (cfg.mode === "custom") {
    return { words: buildCustomWords(cfg) };
  }
  const count = cfg.mode === "words" ? cfg.words : 120; // time/zen: rolling buffer
  let words = await generateWords(cfg, count);
  if (cfg.punctuation) words = applyPunctuation(words, cfg.language);
  return { words };
}

function buildCustomWords(cfg: Config): string[] {
  const base = cfg.customText.split(/\s+/).filter((w) => w.length > 0);
  if (base.length === 0) return ["no", "custom", "text", "set"];
  if (cfg.customLimit === "none") return base;
  if (cfg.customLimit === "words") {
    const out: string[] = [];
    for (let i = 0; i < cfg.customLimitValue; i++) {
      out.push(base[Math.floor(random() * base.length)]!);
    }
    return out;
  }
  // time limit: rolling random draw
  const out: string[] = [];
  for (let i = 0; i < 120; i++) out.push(base[Math.floor(random() * base.length)]!);
  return out;
}

type QuoteWithGroup = Quote & { group: number };

/** Pick a quote respecting the quoteLength setting. */
export async function pickQuote(cfg: Config): Promise<QuoteWithGroup | null> {
  const file = await loadQuotes(cfg.language);
  if (!file || file.quotes.length === 0) return null;

  const groupIndex =
    cfg.quoteLength === "all"
      ? -1
      : { short: 0, medium: 1, long: 2, thicc: 3 }[cfg.quoteLength];

  const groupOf = (q: Quote): number => {
    const idx = file.groups.findIndex(([min, max]) => q.length >= min! && q.length <= max!);
    return idx === -1 ? file.groups.length - 1 : idx;
  };

  let pool = file.quotes;
  if (groupIndex >= 0) {
    const g = file.groups[groupIndex];
    if (g) {
      const [min, max] = g;
      const filtered = file.quotes.filter((q) => q.length >= min! && q.length <= max!);
      if (filtered.length > 0) pool = filtered;
    }
  }
  const q = pool[Math.floor(random() * pool.length)]!;
  return { ...q, group: groupOf(q) };
}

/** Get a fresh batch of words to append during time/zen/custom-time tests. */
export async function getMoreWords(cfg: Config, count: number, previous?: string): Promise<string[]> {
  let words = await generateWords(cfg, count);
  if (cfg.punctuation) {
    words = words.map((w, i) =>
      punctuateWord(i === 0 ? previous : words[i - 1], w, i, words.length + 2, cfg.language),
    );
  }
  return words;
}
