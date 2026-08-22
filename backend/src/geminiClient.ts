import { GoogleGenAI } from "@google/genai";

import { describeError } from "./redact.js";
import type { ChatTurn, NpuStats, Trend } from "./types.js";

/**
 * Default model. `gemini-2.0-flash` — the original choice — has since been
 * retired and is no longer in the models list this API key can reach, which is
 * what made every report fall back to the placeholder with a bare `ApiError`.
 * `gemini-2.5-flash` is its stable successor and the closest match to the
 * design intent (fast, cheap, long context).
 *
 * Overridable with GEMINI_MODEL so a future retirement is a config change
 * rather than a redeploy of this file.
 */
const DEFAULT_MODEL = "gemini-2.5-flash";

function model(): string {
  const configured = process.env.GEMINI_MODEL?.trim();
  return configured === undefined || configured === "" ? DEFAULT_MODEL : configured;
}
const MAX_REPORT_WORDS = 200;

function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to call Gemini");
  }
  return new GoogleGenAI({ apiKey });
}

async function generate(contents: string): Promise<string> {
  const response = await client().models.generateContent({ model: model(), contents });
  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }
  return text;
}

function capWords(text: string, maximum: number): string {
  return text.split(/\s+/).slice(0, maximum).join(" ");
}

export async function generateReport(
  npu: string,
  stats: NpuStats,
  cortexFindings: string,
): Promise<string> {
  const prompt = `You are a neutral Atlanta civic-data reporter.
Write a concise Markdown report card of no more than 200 words for NPU ${npu}.
Use these sections in order: Headline, Trend, Top issues (exactly 3 bullets), and Who to contact.
For contact guidance, direct residents to their NPU meeting or Atlanta 311 as appropriate; do not invent names, phone numbers, or meeting details.
Use only the supplied statistics and Cortex findings. Do not speculate, infer unsupported causes, or add facts from outside this prompt. Explicitly say when the supplied data cannot answer something.

Statistics JSON:
${JSON.stringify(stats)}

Cortex findings:
${cortexFindings}`;

  return capWords(await generate(prompt), MAX_REPORT_WORDS);
}

/**
 * The score and trend shown beside the [Ask] button. Passed separately from
 * `stats` because they are not part of the cached `stats_json` blob — the chat
 * was previously given only the aggregates, so the largest number on the panel
 * was the one thing it could not answer about (PUL-20).
 */
export interface PulseContext {
  pulse_score: number;
  trend: Trend;
}

/**
 * How `computePulse` actually derives the score, stated for the model so it can
 * relate the number to the aggregates it is given rather than inventing a
 * formula that sounds plausible. Kept in step with `backend/src/pulse.ts`: any
 * change to the weights or the mapping belongs here in the same commit.
 */
const PULSE_DERIVATION = `The pulse score is NOT produced by a language model. It is computed in TypeScript by a fixed, deterministic formula over all 25 NPUs:
- a risk composite is formed as 0.5 x z(incidents in the last 90 days) + 0.3 x z(change from the prior 90 days) + 0.2 x z(median days to resolve), where each z is that NPU's standard deviations from the 25-NPU mean;
- the score is then 50 - 10 x that composite, clamped to 0-100 and rounded to one decimal.
So 50 is the city average, higher is healthier, and roughly 10 points is one standard deviation. The trend label is separate: it compares the last 90 days with the prior 90 and reads "improving" below -10%, "worsening" above +10%, and "stable" between.`;

export async function chatAnswer(
  npu: string,
  question: string,
  history: ChatTurn[],
  stats: NpuStats,
  pulse: PulseContext,
): Promise<string> {
  const prompt = `You answer resident questions about Atlanta NPU ${npu}.
Answer only from the supplied statistics and pulse score. Do not speculate or use outside knowledge. If the data does not support an answer, refuse briefly and explain what information is missing. Never invent causes, locations, contacts, or recommendations.
Do not state any figure that is not supplied below, and never recompute or re-derive the pulse score yourself — quote the supplied value.

Pulse score for NPU ${npu}: ${pulse.pulse_score} out of 100. Trend: ${pulse.trend}.

How that score is derived:
${PULSE_DERIVATION}

Statistics JSON:
${JSON.stringify(stats)}

Conversation history JSON:
${JSON.stringify(history)}

Current question:
${question}`;

  return generate(prompt);
}

/**
 * Returned instead of a draft when Gemini fails, mirroring the
 * `[cortex-unavailable]` / `[report pending]` markers already in the repo. A
 * council letter is the one artifact here a resident may actually send, so a
 * plausible-looking placeholder would be worse than none.
 */
export const LETTER_FALLBACK_PREFIX = "[letter-unavailable]";

/** A letter that cannot cite this many real figures is not worth drafting. */
const MIN_CITED_FIGURES = 3;

/**
 * The only numbers the letter is allowed to contain, rendered as labelled
 * lines rather than raw JSON so the model cannot mistake a key it half-recalls
 * for a value it was given. A field that is absent (or null, as
 * `median_resolution_days` is for an NPU with no closed cases) produces no
 * line at all — the letter then omits the point instead of guessing it.
 */
export function verifiedFigures(stats: NpuStats): string[] {
  const lines: string[] = [];
  const push = (label: string, value: number | null | undefined): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      lines.push(`- ${label}: ${value}`);
    }
  };

  push("Incidents recorded in the last 90 days", stats.incident_count_90d);
  push("Incidents recorded in the prior 90 days", stats.incident_count_prior_90d);
  push("Cases still open", stats.open_case_count);
  push("Median days to resolve a case", stats.median_resolution_days);

  const categories = Object.entries(stats.counts_by_category ?? {}).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  for (const [category, count] of categories) {
    lines.push(`- Incidents in category "${category}" (last 90 days): ${count}`);
  }

  return lines;
}

/**
 * Draft an advocacy letter to a city council member about one NPU.
 *
 * Never throws: the route returns whatever comes back, so a Gemini outage
 * yields the `[letter-unavailable]` notice above rather than a 500 or, worse,
 * an invented draft. The failure reason is logged (redacted) and kept out of
 * the response, the same as `cortexFindings` does with driver errors.
 *
 * Deliberately uncapped, unlike `generateReport`: truncating a letter someone
 * is about to send mid-sentence is a worse failure than a slightly long one,
 * so the word budget is enforced in the prompt instead.
 */
export async function draftLetter(npu: string, stats: NpuStats, reportMd: string): Promise<string> {
  const figures = verifiedFigures(stats);
  // `isNpuStats` guarantees three numeric counts, so this only trips on values
  // that are numbers but not finite (a NaN that survived aggregation). Asking
  // for three citations that do not exist is exactly how a letter acquires an
  // invented statistic, so refuse to draft one at all.
  if (figures.length < MIN_CITED_FIGURES) {
    return `${LETTER_FALLBACK_PREFIX} NPU ${npu} has fewer than ${MIN_CITED_FIGURES} usable statistics cached, so no letter was drafted. This is a failure notice, not a draft — do not send it.`;
  }

  const prompt =`You draft a short, respectful advocacy letter that a resident of Atlanta NPU ${npu} will send to their city council representative.

Grounding rules — follow them exactly:
Use ONLY the verified figures listed below. Do not estimate, do not extrapolate, do not round, and do not introduce any statistic, percentage, ranking, or dollar amount that is not in that list.
If something is not in the list, leave it out of the letter entirely. Never guess a missing number, never write a placeholder number, and never describe a number as approximate to cover a gap.
Cite at least ${MIN_CITED_FIGURES} of the verified figures, each with the label it is given below.
The pulse score is NOT a verified figure and is not supplied to you: never state, quote, or characterise a pulse score, rank, or grade for this NPU, even if one appears in the report card below.
Do not invent names, titles, districts, addresses, phone numbers, dates, meetings, incidents, or events. Address the recipient as "Dear Council Member" and sign off as "A resident of NPU ${npu}".
If the verified figures do not support a point you want to make, say plainly that the available data does not show it rather than filling the gap.
Keep the letter under 300 words: plain text, no Markdown, one concrete ask at the end.

Verified figures for NPU ${npu} — the only numbers you may use:
${figures.join("\n")}

Cached report card for NPU ${npu}, for tone and context only. Do not take any number from it that is missing from the verified figures above:
${reportMd}`;

  try {
    return await generate(prompt);
  } catch (error) {
    console.error(`[gemini] NPU ${npu} letter unavailable — ${describeError(error)}`);
    return `${LETTER_FALLBACK_PREFIX} Gemini could not draft a council letter for NPU ${npu}; no letter text was generated. This is a failure notice, not a draft — do not send it. Try again later.`;
  }
}
