import { startServer } from '../dashboard/server.js';

export interface DashboardOpts {
  port?: number;
  open?: boolean;
}

export async function runDashboard(opts: DashboardOpts): Promise<void> {
  const port = opts.port ?? 7842;
  await startServer({ port, open: opts.open !== false });
  // Keep the process alive; server will print URL.
}
