import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';

export const purchaseOrdersRouter = Router();
purchaseOrdersRouter.use(requireAuth);
// Closing a module to a role has to mean something: until now nothing
// anywhere checked `read`, so revoking it would have been a switch that
// changed nothing. No view, no module — writes are still checked
// separately below.
purchaseOrdersRouter.use(requirePermission('purchase_orders', 'read'));

purchaseOrdersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from('purchase_orders')
      .select('id, po_number, project_id, vendor_id, amount, status, order_date, eta, received_date, vendors(name), projects(name)')
      .order('order_date', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ data });
  }),
);
