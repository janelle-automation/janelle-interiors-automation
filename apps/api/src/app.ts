import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { dashboardRouter } from './routes/dashboard.js';
import { projectsRouter } from './routes/projects.js';
import { vendorsRouter } from './routes/vendors.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.js';
import { promptsRouter } from './routes/prompts.js';
import { followUpsRouter } from './routes/followUps.js';
import { reportsRouter } from './routes/reports.js';
import { emailsRouter } from './routes/emails.js';
import { documentsRouter } from './routes/documents.js';
import { activityRouter } from './routes/activity.js';
import { draftsRouter } from './routes/drafts.js';
import { opsRouter } from './routes/ops.js';
import { tasksRouter } from './routes/tasks.js';
import { teamRouter } from './routes/team.js';
import { digestsRouter } from './routes/digests.js';
import { assistantRouter } from './routes/assistant.js';
import { errorHandler, notFound } from './middleware/error.js';

/**
 * The Express application, with no server attached.
 *
 * Kept separate from `index.ts` so the same app can run two ways:
 *   • locally — `index.ts` calls `listen()` and starts the cron scheduler;
 *   • on Vercel — `api/[...path].mjs` exports this app as a serverless
 *     function, where there is no long-running process to listen or schedule.
 */
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(
  cors({
    origin: env.corsOrigins.length ? env.corsOrigins : true,
    credentials: true,
  }),
);

// Routes
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/vendors', vendorsRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/follow-ups', followUpsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/emails', emailsRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/drafts', draftsRouter);
app.use('/api/ops', opsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/team', teamRouter);
app.use('/api/digests', digestsRouter);
app.use('/api/assistant', assistantRouter);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

export default app;
