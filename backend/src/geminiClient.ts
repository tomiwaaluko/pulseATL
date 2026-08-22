import { GoogleGenAI } from "@google/genai";

import { describeError } from "./redact.js";
import type { ChatTurn, NpuStats } from "./types.js";

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

export async function chatAnswer(
  npu: string,
  question: string,
  history: ChatTurn[],
  stats: NpuStats,
): Promise<string> {
  const prompt = `You answer resident questions about Atlanta NPU ${npu}.
Answer only from the supplied statistics. Do not speculate or use outside knowledge. If the data does not support an answer, refuse briefly and explain what information is missing. Never invent causes, locations, contacts, or recommendations.

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
  const prompt = `You draft a short, respectful advocacy letter that a resident of Atlanta NPU ${npu} will send to their city council representative.

Grounding rules — follow them exactly:
Use ONLY the verified figures listed below. Do not estimate, do not extrapolate, do not round, and do not introduce any statistic, percentage, ranking, or dollar amount that is not in that list.
If something is not in the list, leave it out of the letter entirely. Never guess a missing number, never write a placeholder number, and never describe a number as approximate to cover a gap.
Cite at least three of the verified figures, each with the label it is given below.
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
