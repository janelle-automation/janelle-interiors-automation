import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const vendorsRouter = Router();

vendorsRouter.use(requireAuth);

vendorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = req.auth!.db;
    const { data, error } = await db
      .from('vendors')
      .select('id, name, category, contacts, notes')
      .order('name');
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
