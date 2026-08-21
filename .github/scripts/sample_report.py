"""Summarise one deployed NPU report for the health-check workflow.

Reports whether the Cortex findings and the Gemini narrative are real content
or the pipeline's documented placeholders, so a run that technically succeeded
but wrote 25 rows of "[report pending]" is not mistaken for a healthy one.
"""
import json
import sys

CORTEX_PLACEHOLDER = "[cortex-unavailable]"
REPORT_PLACEHOLDER = "[report pending]"


def classify(text: str, placeholder: str) -> str:
    return "PLACEHOLDER" if text.strip().startswith(placeholder) else "REAL"


def main() -> int:
    npu, path = sys.argv[1], sys.argv[2]
    with open(path, encoding="utf-8") as handle:
        detail = json.load(handle)

    cortex = detail.get("cortex_findings") or ""
    gemini = detail.get("gemini_report") or ""
    stats = detail.get("stats_json") or {}

    print(f"NPU {npu}: pulse_score={detail.get('pulse_score')} trend={detail.get('trend')}")
    print(f"cortex : {classify(cortex, CORTEX_PLACEHOLDER)} ({len(cortex)} chars)")
    print(f"    {cortex[:200]}")
    print(f"gemini : {classify(gemini, REPORT_PLACEHOLDER)} ({len(gemini)} chars)")
    print(f"    {gemini[:200]}")
    print(
        f"median_resolution_days={stats.get('median_resolution_days')} "
        f"incident_count_90d={stats.get('incident_count_90d')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
