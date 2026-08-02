import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function readJson<T>(file: URL | string): Promise<T> {
  const path = typeof file === "string" ? file : fileURLToPath(file);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function listJsonBasenames(dir: URL): Promise<string[]> {
  const entries = await readdir(fileURLToPath(dir));
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}
