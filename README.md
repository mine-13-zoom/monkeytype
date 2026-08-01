# monkeytypecli

A [monkeytype](https://monkeytype.com) clone for the terminal, written in TypeScript for [Bun](https://bun.sh). Zero runtime dependencies — raw ANSI, truecolor themes.

Themes, languages, quotes and test logic are ported directly from the official
[monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype) repo.

## Features

- **All 187 official themes** (serika_dark, dracula, catppuccin, 8008, …) rendered in truecolor
- **All test modes**: `time` (15/30/60/120/custom), `words` (10/25/50/100/custom), `quote` (short/medium/long/thicc/all), `zen`, `custom` (with word/time limits)
- **446 language word lists** and **87 quote languages** from the official data
- **Punctuation & numbers** modes, following monkeytype's `words-generator.ts` rules
- **Monkeytype-accurate stats**: wpm, raw wpm, accuracy, consistency (kogasa formula), char stats (correct/incorrect/extra/missed)
- Results screen with a per-second wpm sparkline chart
- **Official account sync** using Monkeytype's Firebase Bearer auth and `POST /results`
- **Mouse support**: click test modes, values, toggles, languages, settings rows, picker items and result actions; scroll picker lists with the wheel
- Searchable pickers for themes/languages, persistent config at `~/.config/monkeytypecli/config.json` (mode `0600`)

## Run

```sh
bun run src/index.ts
# or
bun start
```

### CLI flags

```sh
bun run src/index.ts --mode time --time 60 --theme dracula --punctuation --numbers
bun run src/index.ts --list-themes
bun run src/index.ts --list-languages
```

Flags override your saved config (and become the new saved defaults).

## Keys

| key | action |
| --- | --- |
| type | take the test |
| `tab` | restart test |
| `esc` | settings menu (theme / language / mode / …) |
| `enter` | next test (on results) / finish (in zen) |
| `backspace` | correct mistakes (can return to an incorrect previous word) |
| `ctrl+backspace` | delete word |
| mouse click | choose modes/values, toggle punctuation/numbers, open settings, select picker entries, start next test |
| mouse wheel | scroll settings and picker lists |
| `ctrl+c` | quit |

In pickers: type to filter, `↑`/`↓` or the wheel to move, `enter` or click to select.

## Official account sync

1. Open settings with `esc` or by clicking a configurable item.
2. Select/click **account**.
3. Enter your Monkeytype account email and password.
4. The password is used once for Firebase sign-in and is **never stored**.
5. Only the Firebase refresh token is stored in the config file, which is forced to mode `0600`.
6. Finished valid tests are submitted to `https://api.monkeytype.com/results`; save/PB/XP status appears on the results screen.

Ape Keys cannot be used for saving: the official backend accepts them for reading results but explicitly does not enable them on `POST /results`. Email/password accounts are supported now; Google/GitHub-only accounts need an email/password login configured on the same Firebase account.

## Project layout

```
src/
  index.ts      entry, CLI flags
  term.ts       raw-mode input parsing + ANSI helpers
  theme.ts      187 themes (extracted from monkeytype's themes.ts)
  data.ts       language word lists + quotes loading
  config.ts     persistent user config
  generator.ts  word/quote generation (port of words-generator.ts)
  engine.ts     test state machine + stats (port of test-logic.ts math)
  ui.ts         screens: test, settings menu, pickers, results
data/           themes.json, languages/, quotes/ (from monkeytype frontend/static)
scripts/        extract-themes.ts (re-extract themes from a monkeytype checkout)
```

## Roadmap

- Google/GitHub browser OAuth login
- Kitty keyboard-protocol key-release timing for high-WPM anti-cheat key-duration data
- funbox modes, custom themes, tape mode
