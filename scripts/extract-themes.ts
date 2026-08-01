// Extracts themes from monkeytype's frontend/src/ts/constants/themes.ts into data/themes.json
const src = await Bun.file(
  process.env.HOME + "/.btca/agent/sandbox/monkeytype/frontend/src/ts/constants/themes.ts",
).text();

const blockRe = /^\s{2}(?:"([^"]+)"|(\w+)):\s*\{([^}]*)\}/gm;
const themes: Record<string, Record<string, string>> = {};
let m: RegExpExecArray | null;
while ((m = blockRe.exec(src)) !== null) {
  const name = m[1] ?? m[2]!;
  const body = m[3]!;
  const t: Record<string, string> = {};
  const kvRe = /(\w+):\s*"([^"]+)"/g;
  let kv: RegExpExecArray | null;
  while ((kv = kvRe.exec(body)) !== null) {
    if (kv[1] !== "hasCss") t[kv[1]!] = kv[2]!;
  }
  themes[name] = t;
}

await Bun.write(
  new URL("../data/themes.json", import.meta.url),
  JSON.stringify(themes, null, 2),
);
console.log(`extracted ${Object.keys(themes).length} themes`);
