import uuid
from datetime import timedelta

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

from .business import database_uuid, external_record_id, iso_utc


class BossForgeScreeningRun(models.Model):
    _name = "boss.forge.screening.run"
    _description = "Boss-Forge Screening Run Mirror"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "requested_at desc, id desc"
    _rec_name = "run_uuid"

    run_uuid = fields.Char(required=True, readonly=True, copy=False, default=lambda self: str(uuid.uuid4()), index=True)
    job_id = fields.Many2one("hr.job", required=True, ondelete="restrict", index=True)
    company_id = fields.Many2one(related="job_id.company_id", store=True, index=True)
    requested_by = fields.Many2one("res.users", required=True, readonly=True, default=lambda self: self.env.user)
    requested_at = fields.Datetime(required=True, readonly=True, default=fields.Datetime.now)
    schedule_id = fields.Many2one("boss.forge.screening.schedule", readonly=True, ondelete="set null")
    mode = fields.Selection([("immediate", "Immediate"), ("scheduled", "Scheduled")], required=True, readonly=True)
    source = fields.Selection(
        [("recommend", "Recommended"), ("search", "Search")],
        required=True,
        readonly=True,
        default="recommend",
    )
    state = fields.Selection(
        [
            ("queued", "Queued"),
            ("claimed", "Claimed"),
            ("collecting", "Collecting"),
            ("previewing", "Previewing"),
            ("screening", "Screening"),
            ("syncing_results", "Syncing Results"),
            ("waiting_review", "Waiting Review"),
            ("completed", "Completed"),
            ("partially_completed", "Partially Completed"),
            ("failed", "Failed"),
            ("cancel_requested", "Cancel Requested"),
            ("cancelled", "Cancelled"),
        ],
        required=True,
        default="queued",
        readonly=True,
        tracking=True,
        index=True,
    )
    config_snapshot = fields.Json(required=True, readonly=True)
    outbox_event_id = fields.Many2one("boss.forge.integration.outbox", readonly=True, ondelete="restrict")
    cancel_outbox_event_id = fields.Many2one(
        "boss.forge.integration.outbox", readonly=True, ondelete="restrict"
    )
    collected_count = fields.Integer(readonly=True)
    previewed_count = fields.Integer(readonly=True)
    screened_count = fields.Integer(readonly=True)
    matched_count = fields.Integer(readonly=True)
    failed_count = fields.Integer(readonly=True)
    pending_review_count = fields.Integer(readonly=True)
    started_at = fields.Datetime(readonly=True)
    completed_at = fields.Datetime(readonly=True)
    error_summary = fields.Text(readonly=True)

    _run_uuid_unique = models.Constraint("UNIQUE(run_uuid)", "Screening run UUID must be unique.")

    @api.model
    def request_for_job(
        self, job, source="recommend", mode="immediate", schedule=None, scheduled_for=None
    ):
        job._bf_assert_recruiter()
        job._bf_validate_configuration()
        if source not in ("recommend", "search"):
            raise ValidationError(_("The v1 integration supports only recommend and search sources."))
        if source == "search" and not (job.bf_job_keyword or "").strip():
            raise ValidationError(_("Search screening requires a BOSS job keyword."))
        rule = job.bf_rule_version_id
        snapshot = {
            "odooDatabaseUuid": database_uuid(self.env),
            "odooJobId": job.id,
            "jobName": job.name,
            "odooCompanyId": job.company_id.id,
            "bossAccountId": job.bf_boss_account_id.external_id,
            "bossJobKeyword": job.bf_job_keyword or None,
            "configVersion": job.bf_config_version,
            "ruleVersionId": external_record_id(rule),
            "ruleVersion": rule.version_number,
            "ruleSchemaVersion": rule.schema_version,
            "dictionaryVersion": rule.dictionary_version,
            "institutionCatalogVersion": rule.institution_catalog_id.version or None,
            "ruleConfig": rule.execution_config(),
            "execution": {"mode": mode, "source": source},
        }
        run = self.create(
            {
                "job_id": job.id,
                "mode": mode,
                "source": source,
                "schedule_id": schedule.id if schedule else False,
                "config_snapshot": snapshot,
            }
        )
        event_payload = {
            "requestId": run.run_uuid,
            "odooDatabaseUuid": database_uuid(self.env),
            "odooCompanyId": job.company_id.id,
            "odooJobId": job.id,
            "requestedById": external_record_id(self.env.user),
            "execution": {
                "mode": mode,
                "source": source,
                "searchKeyword": job.bf_job_keyword if source == "search" else None,
                "scheduledFor": iso_utc(scheduled_for) if scheduled_for else None,
            },
            "rule": {
                "versionId": external_record_id(rule),
                "version": rule.version_number,
                "schemaVersion": rule.schema_version,
                "dictionaryVersion": rule.dictionary_version,
                "config": rule.execution_config(),
            },
        }
        event = self.env["boss.forge.integration.outbox"].enqueue(
            "screening.run.requested.v1",
            "screening.run",
            run.run_uuid,
            1,
            event_payload,
        )
        run.outbox_event_id = event
        return run

    def action_cancel(self):
        for run in self:
            if run.state in ("completed", "failed", "cancelled"):
                raise UserError(_("A finished screening run cannot be cancelled."))
            if run.cancel_outbox_event_id:
                raise UserError(_("Cancellation has already been requested."))
            if run.outbox_event_id.state in ("pending", "failed"):
                run.outbox_event_id.write(
                    {
                        "state": "dead_letter",
                        "error_summary": "Cancelled in Odoo before delivery.",
                    }
                )
                run.write({"state": "cancelled", "completed_at": fields.Datetime.now()})
                continue
            cancelled_at = fields.Datetime.now()
            event = self.env["boss.forge.integration.outbox"].enqueue(
                "screening.run.cancelled.v1",
                "screening.run",
                run.run_uuid,
                2,
                {
                    "requestId": run.run_uuid,
                    "odooDatabaseUuid": database_uuid(self.env),
                    "odooJobId": run.job_id.id,
                    "cancelledById": external_record_id(self.env.user),
                    "cancelledAt": iso_utc(cancelled_at),
                },
                correlation_id=run.outbox_event_id.event_id,
            )
            run.write(
                {"state": "cancel_requested", "cancel_outbox_event_id": event.id}
            )


class BossForgeScreeningSchedule(models.Model):
    _name = "boss.forge.screening.schedule"
    _description = "Boss-Forge Screening Schedule"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "next_run_at, id"

    name = fields.Char(required=True, tracking=True)
    job_id = fields.Many2one("hr.job", required=True, ondelete="cascade", index=True, tracking=True)
    company_id = fields.Many2one(related="job_id.company_id", store=True, index=True)
    source = fields.Selection(
        [("recommend", "Recommended"), ("search", "Search")],
        required=True,
        default="recommend",
    )
    interval_number = fields.Integer(required=True, default=1)
    interval_type = fields.Selection(
        [("hours", "Hours"), ("days", "Days"), ("weeks", "Weeks")], required=True, default="days"
    )
    timezone = fields.Selection(related="company_id.partner_id.tz", readonly=True)
    next_run_at = fields.Datetime(required=True, tracking=True)
    last_run_at = fields.Datetime(readonly=True)
    active = fields.Boolean(default=False, tracking=True)
    schedule_version = fields.Integer(default=1, readonly=True)

    _interval_positive = models.Constraint("CHECK(interval_number > 0)", "Schedule interval must be positive.")

    def _next_datetime(self, current):
        self.ensure_one()
        if self.interval_type == "hours":
            return current + timedelta(hours=self.interval_number)
        if self.interval_type == "weeks":
            return current + timedelta(weeks=self.interval_number)
        return current + timedelta(days=self.interval_number)

    @api.model
    def _cron_request_due(self, limit=20):
        now = fields.Datetime.now()
        schedules = self.search([("active", "=", True), ("next_run_at", "<=", now)], limit=limit)
        for schedule in schedules:
            schedule.job_id._bf_validate_configuration()
            scheduled_for = schedule.next_run_at
            run = self.env["boss.forge.screening.run"].request_for_job(
                schedule.job_id,
                source=schedule.source,
                mode="scheduled",
                schedule=schedule,
                scheduled_for=scheduled_for,
            )
            schedule.write(
                {
                    "last_run_at": scheduled_for,
                    "next_run_at": schedule._next_datetime(scheduled_for),
                    "schedule_version": schedule.schedule_version + 1,
                }
            )
            run.message_post(body=_("Created by schedule %s for %s.") % (schedule.display_name, scheduled_for))
