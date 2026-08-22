import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(() => ({ models: { generateContent } })),
}));

import {
  LETTER_FALLBACK_PREFIX,
  chatAnswer,
  draftLetter,
  generateReport,
} from "../src/geminiClient.js";
import type { NpuStats } from "../src/types.js";

const stats: NpuStats = {
  npu: "V",
  incident_count_90d: 42,
  incident_count_prior_90d: 30,
  open_case_count: 8,
  median_resolution_days: 12,
  counts_by_category: { crime: 20, blight: 22 },
};

describe("Gemini client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("generates a grounded, structured report with the locked model", async () => {
    generateContent.mockResolvedValue({ text: "# Headline\n\nA grounded report." });

    const result = await generateReport("V", stats, "Blight increased.");

    expect(result).toContain("# Headline");
    const request = generateContent.mock.calls[0][0];
    expect(request.model).toBe("gemini-2.5-flash");
    expect(request.contents).toContain(JSON.stringify(stats));
    expect(request.contents).toContain("Blight increased.");
    expect(request.contents).toMatch(/do not speculate/i);
    expect(request.contents).toMatch(/headline.*trend.*top issues.*contact/is);
  });

  it("caps report output at 200 words", async () => {
    generateContent.mockResolvedValue({ text: Array(205).fill("word").join(" ") });

    const result = await generateReport("V", stats, "No anomalies.");

    expect(result.split(/\s+/)).toHaveLength(200);
  });

  it("answers chat using supplied history and stats without speculation", async () => {
    generateContent.mockResolvedValue({ text: "The supplied data shows 42 incidents." });

    const result = await chatAnswer(
      "V",
      "What changed?",
      [{ role: "user", content: "Tell me about this NPU." }],
      stats,
    );

    expect(result).toContain("42 incidents");
    const request = generateContent.mock.calls[0][0];
    expect(request.model).toBe("gemini-2.5-flash");
    expect(request.contents).toContain(JSON.stringify(stats));
    expect(request.contents).toContain("Tell me about this NPU.");
    expect(request.contents).toContain("What changed?");
    expect(request.contents).toMatch(/refuse/i);
  });

  it("fails clearly when Gemini returns no text", async () => {
    generateContent.mockResolvedValue({ text: undefined });

    await expect(generateReport("V", stats, "None.")).rejects.toThrow(
      "Gemini returned an empty response",
    );
  });
});

describe("council letter drafting", () => {
  const REPORT_MD = "# NPU V report card\n\nOverall pulse is **41.0**.";

  /** Every figure in `stats`, rendered the way the prompt must label it. */
  const FIGURE_LINES = [
    "- Incidents recorded in the last 90 days: 42",
    "- Incidents recorded in the prior 90 days: 30",
    "- Cases still open: 8",
    "- Median days to resolve a case: 12",
    '- Incidents in category "crime" (last 90 days): 20',
    '- Incidents in category "blight" (last 90 days): 22',
  ];

  function promptFor(call = 0): string {
    const request = generateContent.mock.calls[call][0] as { model: string; contents: string };
    return request.contents;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("carries the NPU's real statistics into the prompt, labelled", async () => {
    generateContent.mockResolvedValue({ text: "Dear Council Member," });

    const result = await draftLetter("V", stats, REPORT_MD);

    expect(result).toContain("Dear Council Member");
    const prompt = promptFor();
    // ACCEPTANCE: the draft is only honest if the model was handed the real
    // numbers, so at least three of them must reach the prompt verbatim.
    const cited = FIGURE_LINES.filter((line) => prompt.includes(line));
    expect(cited.length).toBeGreaterThanOrEqual(3);
    expect(cited).toEqual(FIGURE_LINES);
    expect(generateContent.mock.calls[0][0].model).toBe("gemini-2.5-flash");
    expect(prompt).toContain("NPU V");
    expect(prompt).toContain(REPORT_MD);
  });

  it("tells the model those figures are the only numbers it may use", async () => {
    generateContent.mockResolvedValue({ text: "Dear Council Member," });

    await draftLetter("V", stats, REPORT_MD);

    const prompt = promptFor();
    expect(prompt).toMatch(/use only the verified figures/i);
    expect(prompt).toMatch(/do not estimate/i);
    expect(prompt).toMatch(/never guess a missing number/i);
    expect(prompt).toMatch(/cite at least three of the verified figures/i);
    expect(prompt).toMatch(/do not invent names/i);
  });

  it("omits a missing figure instead of supplying a placeholder for it", async () => {
    generateContent.mockResolvedValue({ text: "Dear Council Member," });

    await draftLetter("V", { ...stats, median_resolution_days: null }, REPORT_MD);

    const prompt = promptFor();
    expect(prompt).not.toMatch(/median days to resolve/i);
    // The label is gone entirely — no "unknown", "n/a" or estimated stand-in.
    expect(prompt).not.toMatch(/median[^\n]*(unknown|n\/a|estimated|approximately)/i);
    // The remaining real figures still clear the three-statistic bar.
    const cited = FIGURE_LINES.filter((line) => prompt.includes(line));
    expect(cited.length).toBeGreaterThanOrEqual(3);
  });

  it("drops the category lines when no category counts were cached", async () => {
    generateContent.mockResolvedValue({ text: "Dear Council Member," });

    await draftLetter("V", { ...stats, counts_by_category: {} }, REPORT_MD);

    const prompt = promptFor();
    expect(prompt).not.toContain("Incidents in category");
    expect(prompt).toContain("- Cases still open: 8");
  });

  it("forbids citing a pulse score, which it is never given", async () => {
    generateContent.mockResolvedValue({ text: "Dear Council Member," });

    await draftLetter("V", stats, REPORT_MD);

    expect(promptFor()).toMatch(/pulse score is not a verified figure/i);
  });

  it("returns the unavailable marker rather than a fabricated letter when Gemini fails", async () => {
    generateContent.mockRejectedValue(new Error("quota exceeded"));

    const result = await draftLetter("V", stats, REPORT_MD);

    expect(result.startsWith(LETTER_FALLBACK_PREFIX)).toBe(true);
    expect(result).toMatch(/could not draft/i);
    expect(result).toMatch(/not a draft/i);
    expect(result).not.toContain("Dear Council Member");
  });

  it("returns the unavailable marker when Gemini returns no text", async () => {
    generateContent.mockResolvedValue({ text: undefined });

    const result = await draftLetter("V", stats, REPORT_MD);

    expect(result.startsWith(LETTER_FALLBACK_PREFIX)).toBe(true);
  });
});

describe("model selection", () => {
  const ORIGINAL_MODEL = process.env.GEMINI_MODEL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = "test-key";
    generateContent.mockResolvedValue({ text: "a report" });
  });

  afterEach(() => {
    if (ORIGINAL_MODEL === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = ORIGINAL_MODEL;
  });

  it("uses GEMINI_MODEL when set, so a retired model is a config change", async () => {
    process.env.GEMINI_MODEL = "gemini-3.5-flash";

    await generateReport("V", stats, "findings");

    expect(generateContent.mock.calls[0][0].model).toBe("gemini-3.5-flash");
  });

  it("falls back to the default when GEMINI_MODEL is an empty string", async () => {
    process.env.GEMINI_MODEL = "";

    await generateReport("V", stats, "findings");

    expect(generateContent.mock.calls[0][0].model).toBe("gemini-2.5-flash");
  });
});
