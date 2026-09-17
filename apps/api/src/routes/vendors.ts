import { Router } from 'express';
import { canWith } from '@janelle/shared';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const vendorsRouter = Router();

vendorsRouter.use(requireAuth);

const SELECT = 'id, name, category, website, contacts, notes';

vendorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.auth!.db;
    const { data, error } = await db.from('vendors').select(SELECT).order('name');
    if (error) throw new Error(error.message);

    // How much is open with each. The screen has always had a slot for
    // this and the web app filled it with a hard-coded zero, so every
    // vendor read "none open" while a dozen orders sat against them.
    const { data: pos } = await db.from('purchase_orders').select('vendor_id, amount, status');
    const CLOSED = ['received', 'cancelled'];
    const open = new Map<string, { count: number; value: number }>();
    for (const row of pos ?? []) {
      const po = row as { vendor_id: string | null; amount: number | null; status: string };
      if (!po.vendor_id || CLOSED.includes(po.status)) continue;
      const at = open.get(po.vendor_id) ?? { count: 0, value: 0 };
      at.count += 1;
      at.value += Number(po.amount ?? 0);
      open.set(po.vendor_id, at);
    }

    res.json({
      data: (data ?? []).map((v) => {
        const row = v as { id: string };
        const tally = open.get(row.id) ?? { count: 0, value: 0 };
        return { ...v, open_pos: tally.count, open_value: tally.value };
      }),
    });
  }),
);

// What the caller may do on this screen, so it offers only those controls.
// The route below checks again; this only decides what is shown.
vendorsRouter.get('/can', (req, res) => {
  const { permissions, role } = req.auth!;
  res.json({
    data: {
      create: canWith(permissions, role, 'vendors', 'create'),
      update: canWith(permissions, role, 'vendors', 'update'),
      delete: canWith(permissions, role, 'vendors', 'delete'),
    },
  });
});

/**
 * People type "houzz.com". Browsers and `new URL()` do not accept that, and
 * a link built from it resolves against our own origin — so the directory
 * would quietly link back into the app. Assume https when no scheme is given
 * and reject anything that still will not parse, rather than storing a string
 * that renders as a broken link later.
 */
function normalizeWebsite(raw: string): string | null | undefined {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  // A hostname with no dot ("houzz") is a typo, not a site.
  if (!url.hostname.includes('.')) return undefined;
  return url.toString().replace(/\/$/, '');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add a vendor by hand. Ingestion creates vendors as a side effect of parsing
 * quotes (services/promote.ts), which only ever finds the ones that email in —
 * a vendor the studio orders from through a website had no way in at all.
 */
vendorsRouter.post(
  '/',
  requirePermission('vendors', 'create'),
  asyncHandler(async (req, res) => {
    const db = req.auth!.db;
    const orgId = req.auth!.orgId;
    if (!orgId) return res.status(400).json({ error: 'No organization for user' });

    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'A vendor name is required' });

    const website = normalizeWebsite(String(req.body?.website ?? ''));
    if (website === undefined) return res.status(400).json({ error: 'That website does not look like a valid address' });

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    if (email && !EMAIL.test(email)) return res.status(400).json({ error: 'That email does not look valid' });

    const phone = String(req.body?.phone ?? '').trim();
    const contactName = String(req.body?.contact_name ?? '').trim();
    const category = String(req.body?.category ?? '').trim() || null;
    const notes = String(req.body?.notes ?? '').trim() || null;

    // Same shape ingestion writes, so both sources stay readable by the
    // assistant's list_vendors tool and by upsertVendor's merge.
    const contacts = email || phone || contactName
      ? [{
          ...(contactName ? { name: contactName } : {}),
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        }]
      : [];

    // Checked here as well as by the unique index from migration 0011: the
    // index may be absent on a database that still holds duplicates, and a
    // named conflict reads better than a raw constraint violation anyway.
    //
    // `_` and `%` are wildcards to ilike, and vendor names do contain them
    // ("Flooring101" is fine, "A_B Tile" would match "AxB Tile"). Escaped so
    // the comparison stays literal. limit(1) rather than maybeSingle(),
    // which errors on exactly the duplicate rows this is here to catch.
    const literal = name.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { data: clash } = await db.from('vendors').select('id, name').ilike('name', literal).limit(1);
    const existing = (clash ?? [])[0] as { name: string } | undefined;
    if (existing) {
      return res.status(409).json({ error: `“${existing.name}” is already in the directory` });
    }

    const { data, error } = await db
      .from('vendors')
      .insert({ org_id: orgId, name, category, website, contacts, notes })
      .select(SELECT)
      .maybeSingle();
    if (error) {
      // The unique index firing despite the check above — two people adding
      // the same vendor at once.
      if (/duplicate key|uq_vendors_org_name/i.test(error.message)) {
        return res.status(409).json({ error: `“${name}” is already in the directory` });
      }
      throw new Error(error.message);
    }

    await db.from('activity_log').insert({
      org_id: orgId,
      actor: req.auth!.userId,
      action: 'vendor.add',
      entity: 'vendors',
      entity_id: (data as { id: string } | null)?.id ?? null,
      meta: { name, website },
    });

    res.json({ data: { ...data, open_pos: 0, open_value: 0 } });
  }),
);
