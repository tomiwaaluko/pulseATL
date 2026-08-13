import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchNpuDetail, fetchNpus } from "./api";
import CompareView from "./components/CompareView";
import PulseMap from "./components/PulseMap";
import ReportPanel from "./components/ReportPanel";
import type { NpuDetail, NpuSummary } from "./types";

function MapSkeleton(): JSX.Element {
  return (
    <div
      className="flex h-full w-full animate-pulse items-center justify-center bg-slate-900"
      data-testid="map-skeleton"
    >
      <p className="text-sm text-slate-500">Loading Atlanta NPUs…</p>
    </div>
  );
}

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

function ErrorScreen({ message, onRetry }: ErrorScreenProps): JSX.Element {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-6 text-center"
      data-testid="error-screen"
    >
      <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
        Pulse ATL
      </h1>
      <p className="text-base font-medium text-rose-300">
        We couldn&apos;t load the neighborhood pulse data.
      </p>
      <p className="max-w-md text-sm text-slate-400" data-testid="error-message">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md bg-sky-500 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400"
        data-testid="retry-button"
      >
        Retry
      </button>
    </div>
  );
}

export default function App(): JSX.Element {
  const [npus, setNpus] = useState<NpuSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedNpu, setSelectedNpu] = useState<string | null>(null);
  const [detail, setDetail] = useState<NpuDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [compareOpen, setCompareOpen] = useState(false);

  const loadNpus = useCallback(async (): Promise<void> => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await fetchNpus();
      setNpus(data.npus);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Could not reach the Pulse ATL API.";
      setListError(message);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNpus();
  }, [loadNpus]);

  useEffect(() => {
    if (selectedNpu === null) {
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setCompareOpen(false);

    fetchNpuDetail(selectedNpu)
      .then((data) => {
        if (!cancelled) {
          setDetail(data);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setDetailError(
          error instanceof ApiError
            ? `Could not load NPU ${selectedNpu}: ${error.message}`
            : `Could not load NPU ${selectedNpu}.`
        );
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNpu]);

  if (listError !== null) {
    return <ErrorScreen message={listError} onRetry={() => void loadNpus()} />;
  }

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight text-slate-50">
            Pulse ATL
          </h1>
          <p className="text-xs text-slate-400">
            Civic health across Atlanta&apos;s 25 Neighborhood Planning Units
          </p>
        </div>
        {selectedNpu !== null ? (
          <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300">
            Viewing NPU {selectedNpu}
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-[45vh] flex-1 lg:min-h-0">
          {listLoading ? (
            <MapSkeleton />
          ) : (
            <PulseMap
              npus={npus}
              selectedNpu={selectedNpu}
              onSelectNpu={setSelectedNpu}
            />
          )}
        </div>

        <aside
          className="w-full shrink-0 overflow-y-auto border-t border-slate-800 bg-slate-900 lg:w-[26rem] lg:border-l lg:border-t-0"
          data-testid="side-panel"
        >
          <ReportPanel
            detail={detail}
            loading={detailLoading}
            error={detailError}
            onCompare={() => setCompareOpen(true)}
            onAsk={() => undefined}
          />
        </aside>
      </div>

      {compareOpen && selectedNpu !== null ? (
        <CompareView
          baseNpu={selectedNpu}
          npus={npus}
          onClose={() => setCompareOpen(false)}
        />
      ) : null}
    </div>
  );
}
