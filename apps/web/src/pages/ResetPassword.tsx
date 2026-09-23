import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { PasswordInput } from '../components/ui';

/** Supabase refuses anything shorter; the studio asks for a little more. */
export const MIN_PASSWORD = 8;

/**
 * Finish a reset: choose the new password.
 *
 * Reached only from the emailed link, which signs the person in for exactly
 * this purpose — so there is no "current password" to ask for. They proved
 * who they are by opening mail sent to their own address.
 */
export default function ResetPassword() {
  const { endRecovery, signOut, user } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return setError('The two passwords do not match.');

    setBusy(true);
    setError(null);
    try {
      const { error: failed } = await supabase.auth.updateUser({ password });
      if (failed) throw failed;

      // Anyone signed in elsewhere is signed out. A reset is what someone
      // does when they fear their account was reached by somebody else, and
      // leaving that other session alive would defeat the whole exercise.
      try {
        await supabase.auth.signOut({ scope: 'others' });
      } catch {
        /* the new password still stands */
      }

      endRecovery();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-brass text-xl font-bold text-white">J</div>
          <div>
            <div className="text-[16px] font-semibold text-ink">Janelle Interiors</div>
            <div className="text-[12px] text-ink-faint">Workflow System</div>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-7">
          <h1 className="text-[20px] font-bold text-ink">Choose a new password</h1>
          <p className="!mt-1 text-[13px] text-ink-soft">
            {user?.email ? `For ${user.email}.` : 'Set the password you will sign in with.'}
          </p>

          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            autoFocus
          />
          <PasswordInput
            required
            minLength={MIN_PASSWORD}
            placeholder="Repeat it"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />

          {error && <p className="rounded-lg bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{error}</p>}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Saving…' : 'Save and sign in'}
          </button>

          <button
            type="button"
            onClick={() => {
              endRecovery();
              void signOut();
            }}
            className="btn-ghost btn-sm w-full"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
