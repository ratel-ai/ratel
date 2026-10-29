import { SITE_COPILOT_SEED, SITE_COPILOT_TURNS } from "@/lib/console/seed/site-copilot-plan";

/** The command line of `scripts/seed.mts`; its header documents the flags. */
export interface SeedArgs {
  org?: string;
  slug: string;
  anchorMs: number;
  turns: number;
  seed: number;
}

const DEFAULT_SLUG = "site-copilot";
const MINUTE_MS = 60_000;

export function parseSeedArgs(argv: readonly string[], nowMs = Date.now()): SeedArgs {
  const valued = new Set(["--slug", "--anchor", "--turns", "--seed"]);
  const flagValue = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const unknown = argv.filter((arg) => arg.startsWith("--") && !valued.has(arg));
  if (unknown.length > 0)
    throw new Error(`unknown flag ${unknown[0]}; see the header of scripts/seed.mts`);
  const anchorArg = flagValue("--anchor");
  const anchorMs = anchorArg
    ? new Date(anchorArg).getTime()
    : Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  if (!Number.isFinite(anchorMs)) throw new Error(`--anchor is not a date: ${anchorArg}`);
  const turns = Number(flagValue("--turns") ?? SITE_COPILOT_TURNS);
  const seed = Number(flagValue("--seed") ?? SITE_COPILOT_SEED);
  if (!Number.isInteger(turns) || turns < 1) throw new Error("--turns takes a positive integer");
  if (!Number.isInteger(seed)) throw new Error("--seed takes an integer");
  return {
    org: argv.find((arg, i) => !arg.startsWith("--") && !valued.has(argv[i - 1] ?? "")),
    slug: flagValue("--slug") ?? DEFAULT_SLUG,
    anchorMs,
    turns,
    seed,
  };
}
