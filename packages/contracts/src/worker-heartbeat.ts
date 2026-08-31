import { z } from "zod";

export const WorkerStateSchema = z.enum(["ready", "busy", "degraded", "stopping"]);

export const WorkerHeartbeatSchema = z.object({
  schemaVersion: z.literal(1),
  workerId: z.string().min(1),
  hostname: z.string().min(1),
  pid: z.number().int().positive(),
  state: WorkerStateSchema,
  observedAt: z.string().datetime({ offset: true }),
  nodeVersion: z.string().min(1),
  bossCli: z.object({
    packageName: z.literal("@joohw/boss-cli"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    entrypoint: z.string().min(1)
  }),
  chrome: z.object({
    available: z.boolean(),
    path: z.string().min(1).nullable()
  }),
  ocrEnabled: z.boolean(),
  activeAccountId: z.string().min(1).nullable(),
  lastError: z.string().min(1).nullable()
});

export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;
export type WorkerState = z.infer<typeof WorkerStateSchema>;
