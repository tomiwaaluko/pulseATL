import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(() => ({ models: { generateContent } })),
}));

import { chatAnswer, generateReport } from "../src/geminiClient.js";
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
