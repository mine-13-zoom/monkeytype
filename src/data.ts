// Language word lists and quotes, ported from monkeytype's static data.

export interface LanguageData {
  name: string;
  noLazyMode?: boolean;
  orderedByFrequency?: boolean;
  words: string[];
}

export interface Quote {
  text: string;
  source: string;
  length: number;
  id: number;
}

export interface QuoteFile {
  language: string;
  groups: number[][]; // e.g. [[0,100],[101,300],[301,600],[601,9999]]
  quotes: Quote[];
}

const langDir = new URL("../data/languages/", import.meta.url);
const quoteDir = new URL("../data/quotes/", import.meta.url);

const langCache = new Map<string, LanguageData>();
const quoteCache = new Map<string, QuoteFile>();

async function listJsonFiles(dir: URL): Promise<string[]> {
  const glob = new Bun.Glob("*.json");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: dir.pathname })) out.push(f.replace(/\.json$/, ""));
  return out.sort();
}

export const languageNames: string[] = await listJsonFiles(langDir);
export const quoteLanguages: string[] = await listJsonFiles(quoteDir);

/** Language names without size suffixes, e.g. english, english_1k, english_10k -> base entries. */
export function baseLanguageNames(): string[] {
  const bases = new Set<string>();
  for (const n of languageNames) bases.add(n.replace(/_(1k|5k|10k|25k|50k|100k|200k|450k)$/, ""));
  return [...bases].sort();
}

export async function loadLanguage(name: string): Promise<LanguageData> {
  const cached = langCache.get(name);
  if (cached) return cached;
  const data: LanguageData = await Bun.file(new URL(name + ".json", langDir)).json();
  langCache.set(name, data);
  return data;
}

/** Resolve a base language name to the best available list (plain preferred). */
export async function loadBestLanguage(base: string): Promise<LanguageData> {
  if (languageNames.includes(base)) return loadLanguage(base);
  const sized = languageNames.filter((n) => n.startsWith(base + "_"));
  if (sized.length > 0) return loadLanguage(sized[0]!);
  return loadLanguage("english");
}

export async function loadQuotes(language: string): Promise<QuoteFile | null> {
  const base = language.replace(/_(1k|5k|10k|25k|50k|100k|200k|450k)$/, "");
  const name = quoteLanguages.includes(base) ? base : quoteLanguages.includes(language) ? language : null;
  if (!name) return null;
  const cached = quoteCache.get(name);
  if (cached) return cached;
  try {
    const data: QuoteFile = await Bun.file(new URL(name + ".json", quoteDir)).json();
    quoteCache.set(name, data);
    return data;
  } catch {
    return null;
  }
}
