import { GoogleGenAI } from "@google/genai";

import type { ChatTurn, NpuStats } from "./types.js";

const MODEL = "gemini-2.0-flash";
const MAX_REPORT_WORDS = 200;

function client(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required to call Gemini");
  }
  return new GoogleGenAI({ apiKey });
}

async function generate(contents: string): Promise<string> {
  const response = await client().models.generateContent({ model: MODEL, contents });
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
