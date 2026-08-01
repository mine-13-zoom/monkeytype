// Monkeytype API client: Ape Key auth + result submission.
// Reference: monkeytype repo packages/contracts/src/results.ts,
// packages/schemas/src/results.ts, backend/src/middlewares/auth.ts
import objectHash from "object-hash";
import type { Engine } from "./engine";

const BASE_URL = "https://api.monkeytype.com";
// Public Firebase web API key from monkeytype's official deployed
// firebase-config-live module. Firebase web API keys are identifiers, not secrets.
const FIREBASE_API_KEY = "AIzaSyB5m_AnO575kvWriahcF1SFIWp8Fj3gQno";

export interface SyncOutcome {
  ok: boolean;
  message: string;
  isPb?: boolean;
  xp?: number;
  refreshToken?: string;
}

export interface AuthOutcome {
  ok: boolean;
  message: string;
  email?: string;
  refreshToken?: string;
}

function clampPct(n: number): number {
  if (isNaN(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function stdDev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

function kogasa(cov: number): number {
  return Math.round(100 * (1 - cov) * 100) / 100;
}

/**
 * Build the CompletedEvent payload exactly as monkeytype's frontend does
 * (see frontend/src/ts/test/test-logic.ts buildCompletedEvent).
 */
export function buildCompletedEvent(engine: Engine): Record<string, unknown> {
  const r = engine.result();
  const cfg = engine.cfg;

  const chartData =
    r.wpmHistory.length > 122 || r.rawHistory.length > 122
      ? "toolong"
      : {
          wpm: r.wpmHistory,
          burst: r.rawHistory,
          err: r.errHistory,
        };

  const spacing = engine.keySpacing();
  const keySpacing = spacing.length > 122 ? "toolong" : spacing;
  // terminals cannot detect key release; send no duration data
  const keyDuration: number[] | "toolong" = [];

  const spacingForConsistency = spacing.slice(0, -1);
  const keyConsistency =
    spacingForConsistency.length > 0
      ? clampPct(
          kogasa(
            stdDev(spacingForConsistency) /
              (spacingForConsistency.reduce((a, b) => a + b, 0) /
                spacingForConsistency.length),
          ),
        )
      : 0;

  const event: Record<string, unknown> = {
    wpm: r.wpm,
    rawWpm: r.rawWpm,
    charStats: [
      r.charStats.correct,
      r.charStats.incorrect,
      r.charStats.extra,
      r.charStats.missed,
    ],
    charTotal: engine.keyLog.length,
    acc: r.acc,
    mode: r.mode,
    mode2: r.mode2,
    quoteLength: cfg.mode === "quote" ? engine.quoteGroup : undefined,
    timestamp: Math.round(Date.now()),
    testDuration: Math.max(1, r.testDuration),
    consistency: clampPct(r.consistency),
    keyConsistency,
    wpmConsistency: clampPct(r.wpmConsistency),
    chartData,
    uid: "cli", // overwritten server-side with the authenticated uid
    restartCount: 0,
    incompleteTestSeconds: 0,
    incompleteTests: [],
    afkDuration: 0,
    tags: [],
    bailedOut: false,
    blindMode: false,
    lazyMode: false,
    funbox: [],
    language: r.language,
    difficulty: "normal",
    numbers: r.numbers,
    punctuation: r.punctuation,
    keySpacing,
    keyDuration,
    keyOverlap: 0,
    lastKeyToEnd: engine.lastKeyToEnd(),
    startToFirstKey: engine.startToFirstKey(),
    stopOnLetter: false,
  };

  if (cfg.mode === "custom") {
    event.customText = {
      textLen: cfg.customText.length,
      mode: "repeat",
      pipeDelimiter: false,
      limit: {
        mode: cfg.customLimit === "time" ? "time" : "word",
        value:
          cfg.customLimit === "none"
            ? cfg.customText.split(/\s+/).filter((w) => w.length > 0).length
            : cfg.customLimitValue,
      },
    };
  }

  // strip undefined values (object-hash and the API prefer absent keys)
  for (const k of Object.keys(event)) {
    if (event[k] === undefined) delete event[k];
  }

  // anti-tamper hash: backend recomputes objectHash(event without hash)
  event.hash = objectHash(event);
  return event;
}

function friendlyFirebaseError(code: string): string {
  const map: Record<string, string> = {
    INVALID_LOGIN_CREDENTIALS: "invalid email or password",
    EMAIL_NOT_FOUND: "account not found",
    INVALID_PASSWORD: "invalid email or password",
    USER_DISABLED: "this account is disabled",
    TOO_MANY_ATTEMPTS_TRY_LATER: "too many attempts — try again later",
    INVALID_EMAIL: "invalid email address",
    TOKEN_EXPIRED: "session expired — sign in again",
    INVALID_REFRESH_TOKEN: "session expired — sign in again",
    USER_NOT_FOUND: "account no longer exists",
  };
  return map[code] ?? code.toLowerCase().replaceAll("_", " ");
}

/** Authenticate a Monkeytype email/password account via the official Firebase project. */
export async function signInWithEmailPassword(
  email: string,
  password: string,
): Promise<AuthOutcome> {
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://monkeytype.com",
          Referer: "https://monkeytype.com/",
        },
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { email?: string; refreshToken?: string; error?: { message?: string } }
      | null;
    if (res.ok && body?.refreshToken) {
      return {
        ok: true,
        message: "signed in",
        email: body.email ?? email.trim(),
        refreshToken: body.refreshToken,
      };
    }
    const code = body?.error?.message ?? `HTTP ${res.status}`;
    return { ok: false, message: friendlyFirebaseError(code) };
  } catch (e) {
    return { ok: false, message: "network error: " + String(e) };
  }
}

async function refreshIdToken(refreshToken: string): Promise<{
  ok: boolean;
  message: string;
  idToken?: string;
  refreshToken?: string;
}> {
  try {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://monkeytype.com",
          Referer: "https://monkeytype.com/",
        },
        body: form,
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { id_token?: string; refresh_token?: string; error?: { message?: string } }
      | null;
    if (res.ok && body?.id_token) {
      return {
        ok: true,
        message: "token refreshed",
        idToken: body.id_token,
        refreshToken: body.refresh_token ?? refreshToken,
      };
    }
    const code = body?.error?.message ?? `HTTP ${res.status}`;
    return { ok: false, message: friendlyFirebaseError(code) };
  } catch (e) {
    return { ok: false, message: "network error: " + String(e) };
  }
}

let cachedClientVersion: string | null = null;
async function getClientVersion(): Promise<string> {
  if (cachedClientVersion) return cachedClientVersion;
  try {
    const res = await fetch("https://monkeytype.com/version.json");
    const body = (await res.json()) as { version?: string };
    cachedClientVersion = body.version ?? "unknown";
  } catch {
    cachedClientVersion = "unknown";
  }
  return cachedClientVersion;
}

export async function submitResult(
  refreshToken: string,
  engine: Engine,
): Promise<SyncOutcome> {
  try {
    const auth = await refreshIdToken(refreshToken);
    if (!auth.ok || !auth.idToken) {
      return { ok: false, message: auth.message };
    }

    const result = buildCompletedEvent(engine);
    const clientVersion = await getClientVersion();
    const res = await fetch(`${BASE_URL}/results`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.idToken}`,
        "Content-Type": "application/json",
        "User-Agent": "monkeytypecli/0.1.0",
        "x-client-version": clientVersion,
      },
      body: JSON.stringify({ result }),
    });
    const body = (await res.json().catch(() => null)) as
      | { message?: string; data?: { isPb?: boolean; xp?: number } }
      | null;
    if (res.status === 200 && body?.data) {
      const parts = ["result saved"];
      if (body.data.isPb) parts.push("new pb!");
      if (body.data.xp) parts.push(`+${body.data.xp} xp`);
      return {
        ok: true,
        message: parts.join("  "),
        isPb: body.data.isPb,
        xp: body.data.xp,
        refreshToken: auth.refreshToken,
      };
    }
    return {
      ok: false,
      message: body?.message ?? `HTTP ${res.status}`,
      refreshToken: auth.refreshToken,
    };
  } catch (e) {
    return { ok: false, message: "network error: " + String(e) };
  }
}
