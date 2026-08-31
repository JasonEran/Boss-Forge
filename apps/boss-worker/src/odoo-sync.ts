import { OdooIntegrationRepository, createDatabase } from "@boss-forge/data";

const POLL_INTERVAL_MS = 2_000;
let stopping = false;

function integrationConfig(): { eventsUrl: string; token: string; workerId: string } {
  const eventsUrl =
    process.env.ODOO_EVENTS_URL?.trim() ||
    "http://odoo:8069/boss_forge/api/v1/events";
  const token =
    process.env.ODOO_INTEGRATION_TOKEN?.trim() ||
    process.env.BOSS_FORGE_SERVICE_TOKEN?.trim();
  if (!token) throw new Error("ODOO_INTEGRATION_TOKEN or BOSS_FORGE_SERVICE_TOKEN is required.");
  return {
    eventsUrl,
    token,
    workerId: process.env.BOSS_FORGE_ODOO_SYNC_WORKER_ID?.trim() || "odoo-sync-01"
  };
}

async function waitForNextPoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

async function main(): Promise<void> {
  const loop = process.argv.includes("--loop");
  const config = integrationConfig();
  const sql = createDatabase();
  const repository = new OdooIntegrationRepository(sql);
  try {
    await repository.recoverStaleOutboundEvents();
    do {
      const event = await repository.claimOutboundEvent(config.workerId);
      if (!event) {
        if (!loop) {
          console.log(JSON.stringify({ ok: true, event: "odoo.sync.idle" }));
          return;
        }
        await waitForNextPoll();
        continue;
      }
      const { attempts: _attempts, ...body } = event;
      try {
        const response = await fetch(config.eventsUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
            "idempotency-key": event.eventId,
            "x-correlation-id": event.correlationId
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) {
          const responseText = (await response.text()).slice(0, 500);
          throw new Error(`Odoo returned HTTP ${response.status}: ${responseText}`);
        }
        await repository.finishOutboundEvent({ eventId: event.eventId, delivered: true });
        console.log(
          JSON.stringify({
            ok: true,
            event: "odoo.sync.delivered",
            eventId: event.eventId,
            eventType: event.eventType
          })
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.finishOutboundEvent({
          eventId: event.eventId,
          delivered: false,
          error: message
        });
        console.error(
          JSON.stringify({
            ok: false,
            event: "odoo.sync.failed",
            eventId: event.eventId,
            eventType: event.eventType,
            message
          })
        );
      }
    } while (!stopping);
  } finally {
    await sql.end();
  }
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
