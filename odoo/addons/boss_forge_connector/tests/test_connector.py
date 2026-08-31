import uuid
from datetime import timedelta
from unittest.mock import Mock, patch

from odoo import fields
from odoo.addons.base.models.ir_cron import IrCron
from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase

from ..models.integration import BossForgeIntegrationInbox


class TestBossForgeConnector(TransactionCase):
    def test_default_api_url_matches_internal_compose(self):
        defaults = self.env["res.config.settings"].default_get(
            ["bf_api_base_url"]
        )
        self.assertEqual(
            defaults["bf_api_base_url"],
            "http://boss-forge-api:3100",
        )
        view = self.env.ref(
            "boss_forge_connector.res_config_settings_view_form_boss_forge"
        )
        self.assertIn(
            'placeholder="http://boss-forge-api:3100"',
            view.arch_db,
        )
        self.assertNotIn("boss-forge-api:3001", view.arch_db)

    def test_outbox_uses_stable_envelope(self):
        event = self.env["boss.forge.integration.outbox"].enqueue(
            "screening.run.requested.v1", "screening.run", "run-1", 1, {"odooJobId": 7}
        )
        envelope = event._envelope()
        self.assertEqual(envelope["eventId"], event.event_id)
        self.assertEqual(envelope["eventType"], "screening.run.requested.v1")
        self.assertEqual(envelope["payload"], {"odooJobId": 7})

    def test_outbox_enqueue_is_idempotent_and_versions_are_monotonic(self):
        Outbox = self.env["boss.forge.integration.outbox"]
        payload = {"odooJobId": 7, "active": True}
        first = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-7", 1, payload
        )
        replay = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-7", 1, payload
        )
        self.assertEqual(replay, first)
        self.assertEqual(
            Outbox.search_count(
                [
                    ("aggregate_type", "=", "hr.job"),
                    ("aggregate_id", "=", "job-7"),
                    ("aggregate_version", "=", 1),
                ]
            ),
            1,
        )
        with self.assertRaises(ValidationError):
            Outbox.enqueue(
                "job.config.published.v1",
                "hr.job",
                "job-7",
                1,
                {**payload, "active": False},
            )
        Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-7", 3, payload
        )
        with self.assertRaises(ValidationError):
            Outbox.enqueue(
                "job.config.published.v1", "hr.job", "job-7", 2, payload
            )
        with self.assertRaises(ValidationError):
            Outbox.enqueue(
                "job.config.published.v1", "hr.job", "job-8", 0, payload
            )

    def test_outbox_failed_predecessor_blocks_newer_version(self):
        params = self.env["ir.config_parameter"].sudo()
        params.set_param("boss_forge_connector.base_url", "http://boss-forge-api:3100")
        params.set_param("boss_forge_connector.service_token", "test-token")
        Outbox = self.env["boss.forge.integration.outbox"]
        older = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-order", 1, {"version": 1}
        )
        newer = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-order", 2, {"version": 2}
        )
        older.write(
            {
                "state": "failed",
                "next_attempt_at": fields.Datetime.now() + timedelta(minutes=30),
            }
        )
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        with patch(
            "odoo.addons.boss_forge_connector.models.integration.requests.post",
            return_value=response,
        ) as post:
            self.assertFalse(newer._dispatch_one())
            post.assert_not_called()
            older.write({"next_attempt_at": fields.Datetime.now()})
            self.assertTrue(older._dispatch_one())
            self.assertTrue(newer._dispatch_one())
        self.assertEqual(older.state, "delivered")
        self.assertEqual(newer.state, "delivered")
        self.assertEqual(post.call_count, 2)
        self.assertEqual(
            post.call_args_list[0].kwargs["headers"]["Idempotency-Key"],
            older.event_id,
        )
        self.assertEqual(
            post.call_args_list[1].kwargs["headers"]["Idempotency-Key"],
            newer.event_id,
        )

    def test_failed_aggregate_does_not_block_another_aggregate(self):
        params = self.env["ir.config_parameter"].sudo()
        params.set_param("boss_forge_connector.base_url", "http://boss-forge-api:3100")
        params.set_param("boss_forge_connector.service_token", "test-token")
        Outbox = self.env["boss.forge.integration.outbox"]
        blocked_older = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-a-blocked", 1, {"version": 1}
        )
        blocked_newer = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-a-blocked", 2, {"version": 2}
        )
        independent = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-b-independent", 1, {"version": 1}
        )
        blocked_older.write(
            {
                "state": "failed",
                "next_attempt_at": fields.Datetime.now() + timedelta(minutes=30),
            }
        )
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        with patch(
            "odoo.addons.boss_forge_connector.models.integration.requests.post",
            return_value=response,
        ) as post:
            self.assertEqual(Outbox._cron_dispatch(limit=1), 1)

        self.assertEqual(blocked_older.state, "failed")
        self.assertEqual(blocked_newer.state, "pending")
        self.assertEqual(independent.state, "delivered")
        post.assert_called_once()
        self.assertEqual(
            post.call_args.kwargs["json"]["aggregateId"],
            "job-b-independent",
        )

    def test_outbox_recovers_expired_processing_lease(self):
        params = self.env["ir.config_parameter"].sudo()
        params.set_param("boss_forge_connector.base_url", "http://boss-forge-api:3100")
        params.set_param("boss_forge_connector.service_token", "test-token")
        params.set_param("boss_forge_connector.processing_timeout_minutes", "5")
        Outbox = self.env["boss.forge.integration.outbox"]
        event = Outbox.enqueue(
            "job.config.published.v1", "hr.job", "job-lease", 1, {"version": 1}
        )
        event.write(
            {
                "state": "processing",
                "locked_at": fields.Datetime.now() - timedelta(minutes=10),
            }
        )
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}
        with patch(
            "odoo.addons.boss_forge_connector.models.integration.requests.post",
            return_value=response,
        ) as post:
            self.assertEqual(Outbox._cron_dispatch(limit=1), 1)
        self.assertEqual(event.state, "delivered")
        self.assertFalse(event.locked_at)
        self.assertEqual(event.attempt_count, 1)
        self.assertEqual(
            post.call_args.kwargs["headers"]["Idempotency-Key"], event.event_id
        )

    def test_outbox_commits_claim_before_http_and_fences_stale_epoch(self):
        params = self.env["ir.config_parameter"].sudo()
        params.set_param("boss_forge_connector.base_url", "http://boss-forge-api:3100")
        params.set_param("boss_forge_connector.service_token", "test-token")
        event = self.env["boss.forge.integration.outbox"].enqueue(
            "job.config.published.v1", "hr.job", "job-fence", 1, {"version": 1}
        )
        response = Mock(status_code=200)
        response.raise_for_status.return_value = None
        response.json.return_value = {"ok": True}

        def post_after_committed_claim(*args, **kwargs):
            self.assertEqual(commit.call_count, 1)
            self.assertEqual(event.state, "processing")
            self.assertTrue(event.locked_at)
            self.assertEqual(event.attempt_count, 1)
            return response

        with patch.object(
            IrCron,
            "_commit_progress",
            autospec=True,
            return_value=float("inf"),
        ) as commit, patch(
            "odoo.addons.boss_forge_connector.models.integration.requests.post",
            side_effect=post_after_committed_claim,
        ):
            self.assertTrue(event._dispatch_one(commit_progress=True))
        self.assertEqual(commit.call_count, 2)
        self.assertEqual(event.state, "delivered")

        event.write(
            {
                "state": "processing",
                "attempt_count": 3,
                "locked_at": fields.Datetime.now(),
            }
        )
        self.assertFalse(
            event._finalize_claim(2, {"state": "failed"})
        )
        self.assertEqual(event.state, "processing")
        self.assertTrue(
            event._finalize_claim(3, {"state": "delivered"})
        )
        self.assertEqual(event.state, "delivered")

    def test_inbox_rejects_incomplete_envelope(self):
        with self.assertRaises(Exception):
            self.env["boss.forge.integration.inbox"].ingest({"eventId": "missing-fields"})

    def test_failed_inbox_event_is_retried_then_idempotent(self):
        event_id = str(uuid.uuid4())
        envelope = {
            "eventId": event_id,
            "eventType": "boss.account.health_changed.v1",
            "aggregateType": "boss_account",
            "aggregateId": "account-1",
            "aggregateVersion": 1,
            "occurredAt": "2026-08-31T08:00:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {"bossAccountId": "account-1", "healthState": "healthy"},
        }
        partner = self.env["res.partner"].create({"name": "Original Name"})

        def partially_write_then_fail(_record):
            partner.write({"name": "Must Roll Back"})
            raise ValidationError("temporary failure")

        with patch.object(
            BossForgeIntegrationInbox,
            "_apply_event",
            autospec=True,
            side_effect=partially_write_then_fail,
        ):
            event, duplicate = self.env[
                "boss.forge.integration.inbox"
            ].ingest(envelope)
        self.assertFalse(duplicate)
        self.assertEqual(event.state, "failed")
        partner.invalidate_recordset()
        self.assertEqual(partner.name, "Original Name")

        with patch.object(
            BossForgeIntegrationInbox,
            "_apply_event",
            return_value={"retried": True},
        ) as handler:
            retried, duplicate = self.env[
                "boss.forge.integration.inbox"
            ].ingest(envelope)
            self.assertFalse(duplicate)
            self.assertEqual(retried.state, "completed")
            handler.assert_called_once()

        with patch.object(BossForgeIntegrationInbox, "_apply_event") as handler:
            completed, duplicate = self.env[
                "boss.forge.integration.inbox"
            ].ingest(envelope)
            self.assertTrue(duplicate)
            self.assertEqual(completed.state, "completed")
            handler.assert_not_called()

    def test_cancellation_event_is_allowed_and_envelope_is_immutable(self):
        event = self.env["boss.forge.integration.outbox"].enqueue(
            "screening.run.cancelled.v1",
            "screening.run",
            str(uuid.uuid4()),
            2,
            {"requestId": str(uuid.uuid4())},
        )
        with self.assertRaises(UserError):
            event.write({"payload": {"changed": True}})
