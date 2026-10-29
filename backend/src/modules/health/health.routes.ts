import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { one } from '../../db/pool.js';

/** Public health output is deliberately minimal: no hostnames, versions, credentials or topology. */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_req, reply) => {
    let database = false;
    try {
      database = (await one<{ ok: number }>(ctx.db, 'SELECT 1 AS ok'))?.ok === 1;
    } catch {
      database = false;
    }
    return reply.code(database ? 200 : 503).send({ status: database ? 'ready' : 'degraded', database });
  });
}
