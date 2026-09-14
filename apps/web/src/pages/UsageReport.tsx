import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AI_FEATURE_TRIGGER,
  type AiUsageBucket,
  type AiUsageReport,
  type AiFeature,
} from '@janelle/shared';
import { publicApi } from '../lib/api';

/**
 * The AI usage report, reachable only by its link.
 *
 * Rendered outside the app shell and outside the auth gate: whoever holds
 * the URL can read it, and nothing else. That is the point — the studio can
 * show what the agent costs without handing out an account.
 */

const WINDOWS = [7, 30, 90] as const;

function usd(n: number): string {
  // Sub-cent totals are normal in the first days; don't round them to £0.00.
  if (n > 0 && n < 0.01) return '<$0.01';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="text-[12.5px] font-medium text-ink-soft">{label}</div>
      <div className="mt-2 text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </div>
      {hint && <div className="mt-2 text-[12px] text-ink-faint">{hint}</div>}
    </div>
  );
}

/** A plain bar list — the shape of the spend matters more than precision. */
function BarList({
  title,
  buckets,
  total,
  note,
}: {
  title: string;
  buckets: AiUsageBucket[];
  total: number;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      {note && <div className="mt-0.5 text-[12px] text-ink-faint">{note}</div>}
      {buckets.length === 0 ? (
        <div className="mt-4 text-[13px] text-ink-faint">Nothing yet.</div>
      ) : (
        <ul className="mt-4 space-y-3">
          {buckets.map((b) => (
            <li key={b.key}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="truncate text-ink">{b.label}</span>
                <span className="shrink-0 tabular-nums font-medium text-ink">{usd(b.cost_usd)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunk">
                <div
                  className="h-full rounded-full bg-brass"
                  style={{ width: `${total > 0 ? Math.max(2, (b.cost_usd / total) * 100) : 0}%` }}
                />
              </div>
              <div className="mt-1 text-[11.5px] text-ink-faint">
                {b.calls} call{b.calls === 1 ? '' : 's'} · {compact(b.input_tokens)} in ·{' '}
                {compact(b.output_tokens)} out
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Daily spend, as a small column chart. */
function DailyChart({ buckets }: { buckets: AiUsageBucket[] }) {
  const max = Math.max(0.000001, ...buckets.map((b) => b.cost_usd));
  return (
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="text-[13px] font-semibold text-ink">Spend per day</div>
      {buckets.length === 0 ? (
        <div className="mt-4 text-[13px] text-ink-faint">Nothing yet.</div>
      ) : (
        <div className="mt-5 flex h-32 items-end gap-1">
          {buckets.map((b) => (
            <div key={b.key} className="group flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t bg-brass/80 transition-colors group-hover:bg-brass"
                style={{ height: `${Math.max(2, (b.cost_usd / max) * 100)}%` }}
                title={`${b.key} · ${usd(b.cost_usd)} · ${b.calls} calls`}
              />
            </div>
          ))}
        </div>
      )}
      {buckets.length > 1 && (
        <div className="mt-2 flex justify-between text-[11px] text-ink-faint">
          <span>{buckets[0].key}</span>
          <span>{buckets[buckets.length - 1].key}</span>
        </div>
      )}
    </div>
  );
}

export default function UsageReport() {
  const { token = '' } = useParams();
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    publicApi<AiUsageReport>(`/public/ai-usage?t=${encodeURIComponent(token)}&days=${days}`)
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, days]);

  if (loading && !report) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="text-[13px] font-medium text-ink-faint">Loading…</div>
      </div>
    );
  }

  // A wrong, revoked or rotated link all look the same on purpose.
  if (error || !report) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="w-full max-w-md rounded-xl border border-line bg-panel p-7 text-center">
          <h1 className="text-xl font-semibold text-ink">This link isn’t working</h1>
          <p className="mt-2 text-[13.5px] text-ink-soft">
            It may have been turned off or replaced. Ask the studio for a current link.
          </p>
        </div>
      </div>
    );
  }

  const { totals } = report;
  const delta = report.previous_cost_usd > 0
    ? ((totals.cost_usd - report.previous_cost_usd) / report.previous_cost_usd) * 100
    : null;

  const agentCost = report.by_feature
    .filter((b) => AI_FEATURE_TRIGGER[b.key as AiFeature] === 'agent')
    .reduce((sum, b) => sum + b.cost_usd, 0);
  const agentShare = totals.cost_usd > 0 ? Math.round((agentCost / totals.cost_usd) * 100) : 0;

  return (
    <div className="min-h-screen bg-canvas px-5 py-10 md:px-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-faint">
            {report.org_name}
          </div>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.02em] text-ink">AI usage</h1>
          <p className="mt-2 max-w-2xl text-[14px] text-ink-soft">
            What the studio’s assistant cost to run over the last {report.window_days} days —
            reading email, raising tasks, drafting follow-ups and answering questions.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={`rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                  days === w
                    ? 'bg-brass text-white'
                    : 'border border-line bg-panel text-ink-soft hover:text-ink'
                }`}
              >
                {w} days
              </button>
            ))}
            {loading && <span className="text-[12px] text-ink-faint">updating…</span>}
          </div>
        </header>

        <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Tile
            label="Total cost"
            value={usd(totals.cost_usd)}
            hint={
              delta === null
                ? 'no earlier period to compare'
                : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}% vs previous ${report.window_days} days`
            }
          />
          <Tile
            label="Calls"
            value={totals.calls.toLocaleString()}
            hint={totals.failed > 0 ? `${totals.failed} failed` : 'all succeeded'}
          />
          <Tile
            label="Tokens"
            value={compact(totals.input_tokens + totals.output_tokens)}
            hint={`${compact(totals.input_tokens)} in · ${compact(totals.output_tokens)} out`}
          />
          <Tile
            label="Run by the agent"
            value={`${agentShare}%`}
            hint="rest is people pressing buttons"
          />
        </section>

        <DailyChart buckets={report.by_day} />

        <section className="grid gap-4 lg:grid-cols-2">
          <BarList
            title="What it was spent on"
            buckets={report.by_feature}
            total={totals.cost_usd}
            note="Each job the assistant does."
          />
          <BarList
            title="Who triggered it"
            buckets={report.by_person}
            total={totals.cost_usd}
            note="The agent’s own scheduled work has no person attached."
          />
        </section>

        {report.by_model.length > 1 && (
          <BarList title="By model" buckets={report.by_model} total={totals.cost_usd} />
        )}

        <section className="rounded-xl border border-line bg-panel p-5">
          <div className="text-[13px] font-semibold text-ink">Most recent calls</div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-faint">
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Job</th>
                  <th className="pb-2 font-medium">Who</th>
                  <th className="pb-2 text-right font-medium">Tokens</th>
                  <th className="pb-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {report.recent.map((r) => (
                  <tr key={r.id} className="border-b border-line/60 last:border-0">
                    <td className="py-2 text-ink-soft">{when(r.created_at)}</td>
                    <td className="py-2 text-ink">
                      {r.feature}
                      {!r.ok && <span className="ml-2 text-[11px] font-medium text-crit">failed</span>}
                    </td>
                    <td className="py-2 text-ink-soft">{r.actor_name ?? 'The agent'}</td>
                    <td className="py-2 text-right tabular-nums text-ink-soft">
                      {compact(r.input_tokens + r.output_tokens)}
                    </td>
                    <td className="py-2 text-right tabular-nums text-ink">{usd(r.cost_usd)}</td>
                  </tr>
                ))}
                {report.recent.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-ink-faint">
                      No calls in this period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="space-y-1 pb-6 text-[11.5px] text-ink-faint">
          <div>
            Generated {when(report.generated_at)}
            {totals.avg_latency_ms != null && ` · average response ${(totals.avg_latency_ms / 1000).toFixed(1)}s`}
          </div>
          <div>
            Costs are estimated from published per-token rates, not an invoice.
            {report.unpriced_models.length > 0 &&
              ` No published price for: ${report.unpriced_models.join(', ')} — those calls count as $0.`}
          </div>
        </footer>
      </div>
    </div>
  );
}
