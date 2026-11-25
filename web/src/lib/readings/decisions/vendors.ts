import type { Config } from "@/config";
import type { DecisionCapabilities } from "@/lib/contracts/models";

/**
 * The vendors a deployment can name in `decisions.vendor` (DECISION_PROVIDER, ADR-0009 §9). Each answers a
 * closed-set question with a probability per option. All but OpenAI speak nearly the same wire
 * format, so they share one client (`choice.ts`) and differ by a row here.
 */

export type DecisionVendorName = "openai" | "typesafe" | "levanto" | "google" | "custom";

export interface DecisionVendor {
  name: DecisionVendorName;
  label: string;
  /** The vendor on a spend line. */
  provider: string;
  /** Its own key, out of the settings; a custom server has only `decisions.apiKey`. */
  key?: (config: Pick<Config, "openai" | "vendors">) => string | undefined;
  baseUrl?: string;
  /** The model when the deployment names none. */
  model?: string;
  /** List price per input token; none of them bills the output of a choice. */
  usdPerInputToken?: number;
}

/** A vendor that answers through `choice.ts`, and what it does its own way. */
export interface ChoiceWire {
  path: string;
  /** The field that carries the situation. */
  state: "state" | "input";
  key: (apiKey: string) => Record<string, string>;
  /** Where the answer reports the tokens it read. */
  usage: "input_tokens" | "total_input_tokens";
  capabilities: DecisionCapabilities;
}

const SYSTEM_ONE: ChoiceWire = {
  path: "/v1/systemone",
  state: "state",
  key: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  usage: "input_tokens",
  // A score until the judge benchmark has run on the engine here.
  capabilities: { refusals: false, confidence: "score", maxOptions: 150 },
};

export const CHOICE_WIRE: Readonly<Record<Exclude<DecisionVendorName, "openai">, ChoiceWire>> = {
  typesafe: SYSTEM_ONE,
  levanto: SYSTEM_ONE,
  custom: SYSTEM_ONE,
  google: {
    path: "/v1beta/decisions",
    state: "input",
    key: (apiKey) => ({ "x-goog-api-key": apiKey }),
    usage: "total_input_tokens",
    // It answers a blocked input with a safety error in place of an answer.
    capabilities: { refusals: true, confidence: "score", maxOptions: 150 },
  },
};

/** Models are pinned: a threshold measured on one release says nothing about the next. */
export const DECISION_VENDORS: Readonly<Record<DecisionVendorName, DecisionVendor>> = {
  openai: {
    name: "openai",
    label: "OpenAI",
    provider: "openai",
    key: (config) => config.openai.apiKey,
  },
  // https://docs.typesafe.ai/models (checked 2026-11-23).
  typesafe: {
    name: "typesafe",
    label: "TypeSafe (Jev)",
    provider: "typesafe",
    key: (config) => config.vendors.typesafeApiKey,
    baseUrl: "https://api.typesafe.ai",
    model: "jev-1.14.0",
    usdPerInputToken: 0.042 / 1_000_000,
  },
  // https://docs.levanto.ai/systemone (checked 2026-11-23). Sage 2 is the one model it accepts.
  // Its docs give no price per token; this is the highest one published elsewhere.
  levanto: {
    name: "levanto",
    label: "Levanto (Sage)",
    provider: "levanto",
    key: (config) => config.vendors.sageApiKey,
    baseUrl: "https://sage.levanto.ai",
    model: "levanto-sage-2",
    usdPerInputToken: 0.07 / 1_000_000,
  },
  // https://aistudio.google.com/docs/decisions-api (checked 2026-11-23): the Gemini Developer
  // API only, so it takes a Gemini key and not the Google Cloud login.
  google: {
    name: "google",
    label: "Google (Gemini Decision)",
    provider: "gcp.gemini",
    key: (config) => config.vendors.geminiApiKey,
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-decision-1",
    usdPerInputToken: 0.1 / 1_000_000,
  },
  // Any server that speaks the System One format.
  custom: { name: "custom", label: "The decision server", provider: "custom" },
};

/** The vendor a name means, or undefined: a name that is not in the table selects nothing. */
export function decisionVendorNamed(name: string): DecisionVendor | undefined {
  const lower = name.toLowerCase();
  return Object.hasOwn(DECISION_VENDORS, lower)
    ? DECISION_VENDORS[lower as DecisionVendorName]
    : undefined;
}
