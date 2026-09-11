export default function ConfigNeeded() {
  const steps = [
    ['Create the .env', 'Copy .env.example to .env at the repo root.'],
    ['Add Supabase keys', 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the repo-root .env (Supabase → Settings → API).'],
    ['Apply the schema', 'Run npm run db:apply:seed, or paste supabase/schema.sql into the SQL editor.'],
    ['Restart the dev server', 'The app will pick up the new environment on reload.'],
  ];
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brass text-xl font-bold text-white">J</div>
          <div>
            <div className="text-[16px] font-semibold text-ink">Janelle Interiors</div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Workflow System</div>
          </div>
        </div>

        <div className="card p-7">
          <span className="text-[12px] font-semibold text-brass-deep">Setup required</span>
          <h1 className="mt-2 text-2xl font-semibold text-ink">Connect the backend</h1>
          <p className="mt-2 text-[14px] text-ink-soft">
            This app runs entirely on live data. Point it at your Supabase project to sign in and begin.
          </p>

          <ol className="mt-5 space-y-3">
            {steps.map(([title, body], i) => (
              <li key={title} className="flex gap-3.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sunk text-[11px] text-brass-deep">
                  {i + 1}
                </span>
                <div>
                  <div className="text-[14px] font-medium text-ink">{title}</div>
                  <div className="text-[12px] text-ink-soft">{body}</div>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-5 text-[11px] text-ink-faint">
            Full instructions: docs/HANDOVER.md
          </p>
        </div>
      </div>
    </div>
  );
}
