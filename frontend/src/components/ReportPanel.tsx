import type { NpuDetail, Trend } from "../types";
import { scoreColor } from "./PulseMap";

export const TREND_STYLES: Record<Trend, { label: string; className: string }> = {
  improving: {
    label: "▲ Improving",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  },
  stable: {
    label: "▬ Stable",
    className: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  },
  worsening: {
    label: "▼ Worsening",
    className: "bg-rose-500/15 text-rose-300 ring-rose-500/40",
  },
};

const DIAL_RADIUS = 52;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

function ScoreDial({ score }: { score: number }): JSX.Element {
  const clamped = Math.min(100, Math.max(0, score));
  const dash = (clamped / 100) * DIAL_CIRCUMFERENCE;
  return (
    <svg
      viewBox="0 0 128 128"
      className="h-32 w-32 -rotate-90"
      role="img"
      aria-label={`Pulse score ${clamped.toFixed(1)} out of 100`}
      data-testid="score-dial"
    >
      <circle
        cx="64"
        cy="64"
        r={DIAL_RADIUS}
        fill="none"
        stroke="#1e293b"
        strokeWidth="12"
      />
      <circle
        cx="64"
        cy="64"
        r={DIAL_RADIUS}
        fill="none"
        stroke={scoreColor(clamped)}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${DIAL_CIRCUMFERENCE - dash}`}
      />
      <text
        x="64"
        y="64"
        textAnchor="middle"
        dominantBaseline="central"
        className="rotate-90 fill-slate-50 text-[28px] font-semibold tabular-nums"
        style={{ transformOrigin: "64px 64px" }}
      >
        {clamped.toFixed(0)}
      </text>
    </svg>
  );
}

/**
 * Minimal markdown renderer for the Gemini report card. The generator emits a
 * headline, bullets and short paragraphs (design spec §4), so headings, lists,
 * bold and inline code are the whole surface we need — no runtime dependency.
 */
function renderInline(text: string, keyPrefix: string): JSX.Element[] {
  const nodes: JSX.Element[] = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(
        <span key={`${keyPrefix}-t${index}`}>{text.slice(cursor, match.index)}</span>
      );
      index += 1;
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-semibold text-slate-100">
          {match[1]}
        </strong>
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded bg-slate-800 px-1 py-0.5 text-[0.85em] text-sky-300"
        >
          {match[2]}
        </code>
      );
    }
    index += 1;
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}-t${index}`}>{text.slice(cursor)}</span>);
  }
  return nodes;
}

function Markdown({ source }: { source: string }): JSX.Element {
  const blocks: JSX.Element[] = [];
  const lines = source.split("\n");
  let bullets: string[] = [];

  const flushBullets = (): void => {
    if (bullets.length === 0) {
      return;
    }
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul
        key={`ul-${blocks.length}`}
        className="ml-5 list-disc space-y-1 text-sm text-slate-300"
      >
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>
    );
  };

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (line === "") {
      flushBullets();
      return;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushBullets();
      const level = heading[1].length;
      const size =
        level === 1
          ? "text-lg font-semibold text-slate-50"
          : level === 2
            ? "text-base font-semibold text-slate-100"
            : "text-sm font-semibold uppercase tracking-wide text-slate-300";
      blocks.push(
        <p key={`h-${lineIndex}`} className={`mt-3 ${size}`}>
          {renderInline(heading[2], `h-${lineIndex}`)}
        </p>
      );
      return;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }

    flushBullets();
    blocks.push(
      <p key={`p-${lineIndex}`} className="text-sm leading-relaxed text-slate-300">
        {renderInline(line, `p-${lineIndex}`)}
      </p>
    );
  });

  flushBullets();
  return (
    <div className="space-y-2" data-testid="report-markdown">
      {blocks}
    </div>
  );
}

function formatUpdatedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ReportPanelSkeleton(): JSX.Element {
  return (
    <div className="animate-pulse space-y-4 p-6" data-testid="panel-skeleton">
      <div className="h-4 w-24 rounded bg-slate-800" />
      <div className="h-32 w-32 rounded-full bg-slate-800" />
      <div className="h-6 w-28 rounded-full bg-slate-800" />
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-slate-800" />
        <div className="h-3 w-5/6 rounded bg-slate-800" />
        <div className="h-3 w-4/6 rounded bg-slate-800" />
        <div className="h-3 w-full rounded bg-slate-800" />
      </div>
    </div>
  );
}

interface ReportPanelProps {
  detail: NpuDetail | null;
  loading: boolean;
  error: string | null;
  onCompare: () => void;
  onAsk: () => void;
}

export default function ReportPanel({
  detail,
  loading,
  error,
  onCompare,
  onAsk,
}: ReportPanelProps): JSX.Element {
  if (loading) {
    return <ReportPanelSkeleton />;
  }

  if (error) {
    return (
      <div className="p-6" data-testid="panel-error">
        <p className="text-sm text-rose-300">{error}</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-6" data-testid="panel-empty">
        <h2 className="text-lg font-semibold text-slate-100">Pick a neighborhood</h2>
        <p className="mt-2 text-sm text-slate-400">
          Select any of Atlanta&apos;s 25 NPUs on the map to read its pulse score,
          trend and AI-generated report card.
        </p>
      </div>
    );
  }

  const trend = TREND_STYLES[detail.trend];

  return (
    <div className="flex h-full flex-col" data-testid="report-panel">
      <div className="border-b border-slate-800 p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
          Neighborhood Planning Unit
        </p>
        <h2 className="text-2xl font-semibold text-slate-50" data-testid="panel-npu">
          NPU {detail.npu}
        </h2>

        <div className="mt-4 flex items-center gap-5">
          <ScoreDial score={detail.pulse_score} />
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-400">
                Pulse score
              </p>
              <p
                className="text-3xl font-semibold tabular-nums text-slate-50"
                data-testid="panel-score"
              >
                {detail.pulse_score.toFixed(1)}
              </p>
            </div>
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ring-1 ${trend.className}`}
              data-testid="trend-badge"
            >
              {trend.label}
            </span>
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCompare}
            className="flex-1 rounded-md border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
            data-testid="compare-button"
          >
            Compare
          </button>
          <button
            type="button"
            onClick={onAsk}
            className="flex-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-3 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/25"
            data-testid="ask-button"
          >
            Ask about this area
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <Markdown source={detail.report_md} />

        {detail.cortex_findings ? (
          <section
            className="mt-6 rounded-lg border border-slate-800 bg-slate-900/60 p-4"
            data-testid="cortex-findings"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Snowflake Cortex — anomalies
            </p>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              {detail.cortex_findings}
            </p>
          </section>
        ) : null}
      </div>

      <div className="border-t border-slate-800 px-6 py-3">
        <p className="text-xs text-slate-500" data-testid="updated-at">
          Last updated {formatUpdatedAt(detail.updated_at)}
        </p>
      </div>
    </div>
  );
}
