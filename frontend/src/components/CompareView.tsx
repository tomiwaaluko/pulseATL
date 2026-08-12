import { useEffect, useState } from "react";
import { ApiError, fetchCompare } from "../api";
import type { CompareResponse, NpuDetail, NpuSummary } from "../types";
import { scoreColor } from "./PulseMap";
import { TREND_STYLES } from "./ReportPanel";

interface CompareColumnProps {
  detail: NpuDetail;
  testId: string;
}

function CompareColumn({ detail, testId }: CompareColumnProps): JSX.Element {
  const trend = TREND_STYLES[detail.trend];
  return (
    <div
      className="rounded-lg border border-slate-800 bg-slate-950/40 p-5"
      data-testid={testId}
    >
      <p className="text-xs uppercase tracking-wider text-slate-400">
        Neighborhood Planning Unit
      </p>
      <p className="text-2xl font-semibold text-slate-50">NPU {detail.npu}</p>
      <p
        className="mt-3 text-5xl font-black tabular-nums"
        style={{ color: scoreColor(detail.pulse_score) }}
      >
        {detail.pulse_score.toFixed(1)}
      </p>
      <span
        className={`mt-3 inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ${trend.className}`}
      >
        {trend.label}
      </span>
    </div>
  );
}

interface CompareViewProps {
  baseNpu: string;
  npus: NpuSummary[];
  onClose: () => void;
}

export default function CompareView({
  baseNpu,
  npus,
  onClose,
}: CompareViewProps): JSX.Element {
  const [comparisonNpu, setComparisonNpu] = useState("");
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (comparisonNpu === "") {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCompare(baseNpu, comparisonNpu)
      .then((result) => {
        if (!cancelled) {
          setData(result);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not load this comparison."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseNpu, comparisonNpu]);

  const options = npus.filter((npu) => npu.npu !== baseNpu);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/80 p-4"
      data-testid="compare-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-50">
            Compare neighborhoods
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            data-testid="compare-close-button"
            aria-label="Close compare view"
          >
            ✕
          </button>
        </header>

        <div className="px-6 py-4">
          <label
            className="block text-xs uppercase tracking-wider text-slate-400"
            htmlFor="compare-npu-select"
          >
            Compare NPU {baseNpu} against
          </label>
          <select
            id="compare-npu-select"
            value={comparisonNpu}
            onChange={(event) => setComparisonNpu(event.target.value)}
            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
            data-testid="compare-npu-select"
          >
            <option value="">Select an NPU…</option>
            {options.map((npu) => (
              <option key={npu.npu} value={npu.npu}>
                NPU {npu.npu}
              </option>
            ))}
          </select>
        </div>

        <div className="px-6 pb-6">
          {loading ? (
            <p
              className="py-10 text-center text-sm text-slate-400"
              data-testid="compare-loading"
            >
              Loading comparison…
            </p>
          ) : error ? (
            <p
              className="py-10 text-center text-sm text-rose-300"
              data-testid="compare-error"
            >
              {error}
            </p>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <CompareColumn detail={data.a} testId="compare-column-a" />
                <CompareColumn detail={data.b} testId="compare-column-b" />
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-6 text-center">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400">
                    Pulse score gap
                  </p>
                  <p
                    className="mt-1 text-6xl font-black tabular-nums text-sky-300"
                    data-testid="compare-gap-pulse"
                  >
                    {Math.abs(data.gap.pulse_gap).toFixed(1)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400">
                    Median resolution gap
                  </p>
                  {data.gap.resolution_days_gap === null ? (
                    <p
                      className="mt-4 text-sm font-medium text-slate-400"
                      data-testid="compare-gap-resolution"
                    >
                      Resolution data unavailable for these neighborhoods
                    </p>
                  ) : (
                    <p
                      className="mt-1 text-6xl font-black tabular-nums text-amber-300"
                      data-testid="compare-gap-resolution"
                    >
                      {Math.abs(data.gap.resolution_days_gap).toFixed(0)}
                      <span className="ml-2 text-lg font-medium text-slate-400">
                        days
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p
              className="py-10 text-center text-sm text-slate-500"
              data-testid="compare-placeholder"
            >
              Pick a second neighborhood to see the equity gap.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
