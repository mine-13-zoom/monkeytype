// Persistent user configuration, stored at $XDG_CONFIG_HOME/monkeytype/config.json

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Mode = "time" | "words" | "quote" | "zen" | "custom";
export type QuoteLength = "short" | "medium" | "long" | "thicc" | "all";
export type CustomLimit = "none" | "words" | "time";

export interface Config {
  theme: string;
  language: string;
  mode: Mode;
  time: number; // seconds for time mode
  words: number; // count for words mode
  quoteLength: QuoteLength;
  punctuation: boolean;
  numbers: boolean;
  customText: string;
  customLimit: CustomLimit;
  customLimitValue: number;
  liveWpm: boolean;
  authEmail: string;
  authRefreshToken: string;
}

export const defaultConfig: Config = {
  theme: "serika_dark",
  language: "english",
  mode: "time",
  time: 30,
  words: 25,
  quoteLength: "all",
  punctuation: false,
  numbers: false,
  customText: "the quick brown fox jumps over the lazy dog",
  customLimit: "none",
  customLimitValue: 50,
  liveWpm: true,
  authEmail: "",
  authRefreshToken: "",
};

function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? process.env.HOME + "/.config";
  return xdg + "/monkeytype/config.json";
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8"));
    // Drop the legacy Ape Key field. Ape Keys are accepted for result reads,
    // but the official POST /results route requires Firebase Bearer auth.
    delete raw.apeKey;
    return { ...defaultConfig, ...raw };
  } catch {
    return { ...defaultConfig };
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  try {
    const path = configPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(cfg, null, 2));
    // Refresh tokens are credentials; never leave the config world-readable.
    await chmod(path, 0o600);
  } catch {
    // non-fatal
  }
}
