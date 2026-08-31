import logging
import uuid
from datetime import datetime, timedelta, timezone

import requests

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError


_logger = logging.getLogger(__name__)

ENVELOPE_FIELDS = {
    "eventId",
    "eventType",
    "aggregateType",
    "aggregateId",
    "aggregateVersion",
    "occurredAt",
    "payload",
}
INBOUND_ENVELOPE_FIELDS = ENVELOPE_FIELDS | {"correlationId"}
OUTBOUND_EVENT_TYPES = {
    "job.config.published.v1",
    "screening.run.requested.v1",
    "screening.run.cancelled.v1",
    "candidate.review.completed.v1",
    "candidate.contact.authorized.v1",
}
INBOUND_EVENT_TYPES = {
    "screening.run.started.v1",
    "candidate.collected.v1",
    "candidate.screened.v1",
    "candidate.screening_failed.v1",
    "screening.run.completed.v1",
    "contact.queued.v1",
    "contact.simulated.v1",
    "contact.sent.v1",
    "contact.failed.v1",
    "contact.uncertain.v1",
    "candidate.reply.received.v1",
    "boss.account.health_changed.v1",
}


def _parse_iso_datetime(value):
    if not isinstance(value, str):
        raise ValidationError(_("Event timestamps must be ISO-8601 strings."))
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(_("Invalid ISO-8601 timestamp: %s") % value) from exc
    if parsed.tzinfo is None:
        raise ValidationError(_("Event timestamps must include a timezone offset."))
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def _assert_uuid(value, label):
    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValidationError(_("%s must be a UUID.") % label) from exc


def _positive_integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValidationError(_("%s must be a positive integer.") % label)
    return value


class BossForgeIntegrationOutbox(models.Model):
    _name = "boss.forge.integration.outbox"
    _description = "Boss-Forge Integration Outbox"
    _order = "create_date desc, id desc"
    _rec_name = "event_id"

    event_id = fields.Char(required=True, readonly=True, index=True, default=lambda self: str(uuid.uuid4()))
    event_type = fields.Char(required=True, readonly=True, index=True)
    aggregate_type = fields.Char(required=True, readonly=True, index=True)
    aggregate_id = fields.Char(required=True, readonly=True, index=True)
    aggregate_version = fields.Integer(required=True, readonly=True, default=1)
    occurred_at = fields.Datetime(required=True, readonly=True, default=fields.Datetime.now)
    payload = fields.Json(required=True, readonly=True, default=dict)
    correlation_id = fields.Char(readonly=True, index=True)
    state = fields.Selection(
        [
            ("pending", "Pending"),
            ("processing", "Processing"),
            ("delivered", "Delivered"),
            ("failed", "Failed"),
            ("dead_letter", "Dead Letter"),
        ],
        required=True,
        default="pending",
        readonly=True,
        index=True,
    )
    attempt_count = fields.Integer(readonly=True, default=0)
    max_attempts = fields.Integer(readonly=True, default=8)
    next_attempt_at = fields.Datetime(readonly=True, default=fields.Datetime.now, index=True)
    delivered_at = fields.Datetime(readonly=True)
    error_summary = fields.Text(readonly=True)
    response_payload = fields.Json(readonly=True)
    locked_at = fields.Datetime(readonly=True, index=True)
    predecessor_event_id = fields.Many2one(
        "boss.forge.integration.outbox",
        readonly=True,
        ondelete="restrict",
        index=True,
    )

    _event_id_unique = models.Constraint("UNIQUE(event_id)", "The integration event ID must be unique.")
    _aggregate_version_positive = models.Constraint(
        "CHECK(aggregate_version > 0)", "The aggregate version must be positive."
    )
    _aggregate_version_unique = models.Constraint(
        "UNIQUE(aggregate_type, aggregate_id, aggregate_version)",
        "An aggregate version may only be enqueued once.",
    )

    @api.constrains("event_type")
    def _check_event_type(self):
        for record in self:
            if record.event_type not in OUTBOUND_EVENT_TYPES:
                raise ValidationError(_("Unsupported outbound event type: %s") % record.event_type)

    @api.model
    def enqueue(
        self,
        event_type,
        aggregate_type,
        aggregate_id,
        aggregate_version,
        payload,
        correlation_id=None,
        event_id=None,
        occurred_at=None,
        predecessor_event=None,
    ):
        """Create the event in the caller's transaction; never performs network I/O."""
        if not isinstance(payload, dict):
            raise ValidationError(_("Event payload must be a JSON object."))
        aggregate_type = str(aggregate_type or "").strip()
        aggregate_id = str(aggregate_id or "").strip()
        if not aggregate_type or not aggregate_id:
            raise ValidationError(_("Aggregate type and ID are required."))
        if (
            isinstance(aggregate_version, bool)
            or not isinstance(aggregate_version, int)
            or aggregate_version <= 0
        ):
            raise ValidationError(_("aggregateVersion must be a positive integer."))
        event_id = str(event_id or uuid.uuid4())
        correlation_id = str(correlation_id or uuid.uuid4())
        _assert_uuid(event_id, "eventId")
        _assert_uuid(correlation_id, "correlationId")
        predecessor_id = False
        if predecessor_event:
            if getattr(predecessor_event, "_name", None) == self._name:
                if len(predecessor_event) != 1:
                    raise ValidationError(_("Exactly one predecessor Outbox event is required."))
                predecessor_id = predecessor_event.id
            else:
                predecessor_id = predecessor_event
            predecessor_event = self.browse(predecessor_id).exists()
            if not predecessor_event or len(predecessor_event) != 1:
                raise ValidationError(_("The predecessor Outbox event does not exist."))
            predecessor_id = predecessor_event.id

        self._acquire_aggregate_lock(aggregate_type, aggregate_id)
        existing_event = self.search([("event_id", "=", event_id)], limit=1)
        if existing_event:
            if (
                existing_event.event_type != event_type
                or existing_event.aggregate_type != aggregate_type
                or existing_event.aggregate_id != aggregate_id
                or existing_event.aggregate_version != aggregate_version
                or existing_event.payload != payload
                or existing_event.predecessor_event_id.id != predecessor_id
            ):
                raise ValidationError(
                    _("An existing eventId cannot be reused with different Outbox content.")
                )
            return existing_event

        existing_version = self.search(
            [
                ("aggregate_type", "=", aggregate_type),
                ("aggregate_id", "=", aggregate_id),
                ("aggregate_version", "=", aggregate_version),
            ],
            limit=1,
        )
        if existing_version:
            if (
                existing_version.event_type != event_type
                or existing_version.payload != payload
                or existing_version.predecessor_event_id.id != predecessor_id
            ):
                raise ValidationError(
                    _("This aggregateVersion is already bound to different Outbox content.")
                )
            return existing_version

        latest = self.search(
            [
                ("aggregate_type", "=", aggregate_type),
                ("aggregate_id", "=", aggregate_id),
            ],
            order="aggregate_version desc",
            limit=1,
        )
        if latest and aggregate_version < latest.aggregate_version:
            raise ValidationError(
                _("An older aggregateVersion cannot be enqueued after a newer version.")
            )
        return self.create(
            {
                "event_id": event_id,
                "event_type": event_type,
                "aggregate_type": aggregate_type,
                "aggregate_id": aggregate_id,
                "aggregate_version": aggregate_version,
                "occurred_at": occurred_at or fields.Datetime.now(),
                "payload": payload,
                "correlation_id": correlation_id,
                "predecessor_event_id": predecessor_id,
            }
        )

    @api.model
    def _acquire_aggregate_lock(self, aggregate_type, aggregate_id, try_only=False):
        lock_key = f"{aggregate_type}\x1f{aggregate_id}"
        if try_only:
            self.env.cr.execute(
                "SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0))",
                [lock_key],
            )
            return bool(self.env.cr.fetchone()[0])
        self.env.cr.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            [lock_key],
        )
        return True

    def _envelope(self):
        self.ensure_one()
        occurred_at = fields.Datetime.to_datetime(self.occurred_at)
        return {
            "eventId": self.event_id,
            "eventType": self.event_type,
            "aggregateType": self.aggregate_type,
            "aggregateId": self.aggregate_id,
            "aggregateVersion": self.aggregate_version,
            "occurredAt": occurred_at.isoformat() + "Z",
            "payload": self.payload or {},
        }

    def action_retry(self):
        self.filtered(lambda record: record.state in ("failed", "dead_letter")).write(
            {
                "state": "pending",
                "next_attempt_at": fields.Datetime.now(),
                "error_summary": False,
                "locked_at": False,
            }
        )

    def write(self, values):
        immutable = {
            "event_id", "event_type", "aggregate_type", "aggregate_id",
            "aggregate_version", "occurred_at", "payload", "correlation_id",
            "predecessor_event_id",
        }
        if immutable.intersection(values):
            raise UserError(_("Outbox event envelopes are immutable."))
        return super().write(values)

    @api.model
    def _cron_dispatch(self, limit=50):
        now = fields.Datetime.now()
        self._recover_expired_processing_leases(now=now)
        events = self.search(
            [("state", "in", ("pending", "failed")), ("next_attempt_at", "<=", now)],
            order="next_attempt_at, aggregate_type, aggregate_id, aggregate_version, id",
        )
        processed = 0
        commit_progress = bool(self.env.context.get("cron_id"))
        for event in events:
            if event._dispatch_one(commit_progress=commit_progress):
                processed += 1
                if processed >= limit:
                    break
        return processed

    @api.model
    def _processing_timeout_minutes(self):
        raw = self.env["ir.config_parameter"].sudo().get_param(
            "boss_forge_connector.processing_timeout_minutes",
            "5",
        )
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = 5
        return max(1, min(value, 1440))

    @api.model
    def _recover_expired_processing_leases(self, now=None):
        now = fields.Datetime.to_datetime(now or fields.Datetime.now())
        expired_before = now - timedelta(minutes=self._processing_timeout_minutes())
        self.flush_model(["state", "locked_at", "next_attempt_at", "error_summary"])
        self.env.cr.execute(
            """
            UPDATE boss_forge_integration_outbox
               SET state = 'failed',
                   locked_at = NULL,
                   next_attempt_at = %s,
                   error_summary = %s
             WHERE state = 'processing'
               AND (locked_at IS NULL OR locked_at <= %s)
            RETURNING id
            """,
            [
                now,
                "Recovered an expired processing lease; delivery will retry with the same Idempotency-Key.",
                expired_before,
            ],
        )
        recovered_ids = [row[0] for row in self.env.cr.fetchall()]
        if recovered_ids:
            self.browse(recovered_ids).invalidate_recordset(
                ["state", "locked_at", "next_attempt_at", "error_summary"],
                flush=False,
            )
        return len(recovered_ids)

    def _has_blocking_predecessor(self):
        self.ensure_one()
        if self.predecessor_event_id and self.predecessor_event_id.state != "delivered":
            return True
        return bool(
            self.search_count(
                [
                    ("id", "!=", self.id),
                    ("aggregate_type", "=", self.aggregate_type),
                    ("aggregate_id", "=", self.aggregate_id),
                    ("aggregate_version", "<", self.aggregate_version),
                    ("state", "!=", "delivered"),
                ]
            )
        )

    def _finalize_claim(self, claim_epoch, values, commit_progress=False):
        """Apply a result only if this worker still owns the processing epoch."""
        self.ensure_one()
        self.env.cr.execute(
            """
            SELECT id
              FROM boss_forge_integration_outbox
             WHERE id = %s
               AND state = 'processing'
               AND attempt_count = %s
             FOR UPDATE
            """,
            [self.id, claim_epoch],
        )
        if not self.env.cr.fetchone():
            self.invalidate_recordset()
            return False
        self.invalidate_recordset()
        self.write({**values, "locked_at": False})
        if commit_progress:
            self.env["ir.cron"]._commit_progress(processed=1)
        return True

    def _dispatch_one(self, commit_progress=False):
        self.ensure_one()
        if not self.exists() or not self._acquire_aggregate_lock(
            self.aggregate_type,
            self.aggregate_id,
            try_only=True,
        ):
            return False
        self.flush_recordset(["state", "next_attempt_at"])
        self.env.cr.execute(
            """
            SELECT state, next_attempt_at
              FROM boss_forge_integration_outbox
             WHERE id = %s
             FOR UPDATE SKIP LOCKED
            """,
            [self.id],
        )
        locked = self.env.cr.fetchone()
        if not locked or locked[0] not in ("pending", "failed"):
            return False
        self.invalidate_recordset(
            ["state", "next_attempt_at", "predecessor_event_id"]
        )
        now = fields.Datetime.now()
        if self.next_attempt_at and self.next_attempt_at > now:
            return False
        if self._has_blocking_predecessor():
            return False

        params = self.env["ir.config_parameter"].sudo()
        base_url = (params.get_param("boss_forge_connector.base_url") or "").rstrip("/")
        token = params.get_param("boss_forge_connector.service_token") or ""
        if not base_url or not token:
            self.write(
                {
                    "state": "failed",
                    "error_summary": "Connector base URL or service token is not configured.",
                    "next_attempt_at": now + timedelta(minutes=15),
                    "locked_at": False,
                }
            )
            if commit_progress:
                self.env["ir.cron"]._commit_progress(processed=1)
            return True

        self.write(
            {
                "state": "processing",
                "attempt_count": self.attempt_count + 1,
                "locked_at": now,
            }
        )
        claim_epoch = self.attempt_count
        # The fencing query below is raw SQL. Flush the claimed epoch even
        # outside a cron transaction so manual dispatch cannot observe the
        # pre-claim state and leave the event stuck in processing.
        self.flush_recordset(["state", "attempt_count", "locked_at"])
        if commit_progress:
            # Persist the owner epoch before network I/O. A hard crash leaves a
            # visible lease that can be recovered; retries reuse event_id.
            self.env["ir.cron"]._commit_progress()
        try:
            response = requests.post(
                f"{base_url}/api/integration/odoo/v1/events",
                json=self._envelope(),
                headers={
                    "Authorization": f"Bearer {token}",
                    "Idempotency-Key": self.event_id,
                    "X-Correlation-Id": self.correlation_id or self.event_id,
                    "Content-Type": "application/json",
                },
                timeout=(5, 20),
            )
            response.raise_for_status()
            try:
                response_payload = response.json()
            except ValueError:
                response_payload = {"status": response.status_code}
            self._finalize_claim(
                claim_epoch,
                {
                    "state": "delivered",
                    "delivered_at": fields.Datetime.now(),
                    "response_payload": response_payload,
                    "error_summary": False,
                },
                commit_progress=commit_progress,
            )
        except Exception as exc:
            attempts = claim_epoch
            dead = attempts >= self.max_attempts
            wait_minutes = min(2 ** min(attempts, 8), 240)
            finalized = self._finalize_claim(
                claim_epoch,
                {
                    "state": "dead_letter" if dead else "failed",
                    "next_attempt_at": fields.Datetime.now() + timedelta(minutes=wait_minutes),
                    "error_summary": str(exc)[:1000],
                },
                commit_progress=commit_progress,
            )
            if finalized:
                _logger.warning("Boss-Forge event %s delivery failed: %s", self.event_id, exc)
            else:
                _logger.warning(
                    "Ignoring stale Outbox worker result for %s epoch %s",
                    self.event_id,
                    claim_epoch,
                )
        return True

    @api.ondelete(at_uninstall=False)
    def _unlink_only_undelivered(self):
        if any(record.state == "delivered" for record in self):
            raise UserError(_("Delivered integration events are immutable audit records."))


class BossForgeIntegrationInbox(models.Model):
    _name = "boss.forge.integration.inbox"
    _description = "Boss-Forge Integration Inbox"
    _order = "create_date desc, id desc"
    _rec_name = "event_id"

    event_id = fields.Char(required=True, readonly=True, index=True)
    event_type = fields.Char(required=True, readonly=True, index=True)
    aggregate_type = fields.Char(required=True, readonly=True)
    aggregate_id = fields.Char(required=True, readonly=True, index=True)
    aggregate_version = fields.Integer(required=True, readonly=True)
    occurred_at = fields.Datetime(required=True, readonly=True)
    payload = fields.Json(required=True, readonly=True)
    correlation_id = fields.Char(readonly=True, index=True)
    state = fields.Selection(
        [
            ("processing", "Processing"),
            ("completed", "Completed"),
            ("failed", "Failed"),
        ],
        required=True,
        readonly=True,
        default="processing",
    )
    processed_at = fields.Datetime(readonly=True)
    handler_result = fields.Json(readonly=True)
    error_summary = fields.Text(readonly=True)

    _event_id_unique = models.Constraint("UNIQUE(event_id)", "The inbound event ID must be unique.")

    def write(self, values):
        immutable = {
            "event_id", "event_type", "aggregate_type", "aggregate_id",
            "aggregate_version", "occurred_at", "payload", "correlation_id",
        }
        if immutable.intersection(values):
            raise UserError(_("Inbox event envelopes are immutable."))
        return super().write(values)

    @api.model
    def ingest(self, envelope, correlation_id=None):
        if not isinstance(envelope, dict):
            raise ValidationError(_("The request body must be a JSON object."))
        missing = INBOUND_ENVELOPE_FIELDS - set(envelope)
        if missing:
            raise ValidationError(_("Missing envelope fields: %s") % ", ".join(sorted(missing)))
        if not isinstance(envelope["payload"], dict):
            raise ValidationError(_("Envelope payload must be a JSON object."))
        if envelope["eventType"] not in INBOUND_EVENT_TYPES:
            raise ValidationError(_("Unsupported inbound event type: %s") % envelope["eventType"])
        _assert_uuid(envelope["eventId"], "eventId")
        _assert_uuid(envelope["correlationId"], "correlationId")
        if not isinstance(envelope["aggregateVersion"], int) or envelope["aggregateVersion"] <= 0:
            raise ValidationError(_("aggregateVersion must be a positive integer."))
        if correlation_id and correlation_id != envelope["correlationId"]:
            raise ValidationError(_("X-Correlation-Id must match envelope correlationId."))

        occurred_at = _parse_iso_datetime(envelope["occurredAt"])
        existing = self.search([("event_id", "=", envelope["eventId"])], limit=1)
        if existing:
            expected = {
                "event_type": envelope["eventType"],
                "aggregate_type": envelope["aggregateType"],
                "aggregate_id": str(envelope["aggregateId"]),
                "aggregate_version": envelope["aggregateVersion"],
                "occurred_at": occurred_at,
                "payload": envelope["payload"],
                "correlation_id": envelope["correlationId"],
            }
            if any(existing[field_name] != value for field_name, value in expected.items()):
                raise ValidationError(
                    _("An existing eventId cannot be reused with different content.")
                )
            if existing.state == "completed":
                return existing, True
            record = existing
            record.write(
                {
                    "state": "processing",
                    "error_summary": False,
                    "handler_result": False,
                }
            )
        else:
            record = self.create(
                {
                    "event_id": envelope["eventId"],
                    "event_type": envelope["eventType"],
                    "aggregate_type": envelope["aggregateType"],
                    "aggregate_id": str(envelope["aggregateId"]),
                    "aggregate_version": envelope["aggregateVersion"],
                    "occurred_at": occurred_at,
                    "payload": envelope["payload"],
                    "correlation_id": envelope["correlationId"],
                }
            )
        try:
            with self.env.cr.savepoint():
                result = record._apply_event()
            record.write(
                {
                    "state": "completed",
                    "processed_at": fields.Datetime.now(),
                    "handler_result": result,
                    "error_summary": False,
                }
            )
        except Exception as exc:
            record.write({"state": "failed", "error_summary": str(exc)[:1000]})
            return record, False
        return record, False

    def _find_applicant(self, payload):
        Applicant = self.env["hr.applicant"].sudo()
        applicant_id = payload.get("odooApplicantId")
        if applicant_id:
            applicant = Applicant.browse(int(applicant_id)).exists()
            if applicant:
                return applicant
        candidate_state_id = payload.get("candidateStateId")
        if candidate_state_id:
            applicant = Applicant.search([("bf_state_id", "=", candidate_state_id)], limit=1)
            if applicant:
                return applicant
        return Applicant.browse()

    def _find_run(self, payload):
        run_uuid = payload.get("screeningRunId") or payload.get("requestId") or self.aggregate_id
        return self.env["boss.forge.screening.run"].sudo().search([("run_uuid", "=", run_uuid)], limit=1)

    def _validate_database(self, payload, required=False):
        expected = self.env["ir.config_parameter"].sudo().get_param("database.uuid") or self.env.cr.dbname
        received = payload.get("odooDatabaseUuid")
        if required and not received:
            raise ValidationError(_("odooDatabaseUuid is required."))
        if received and received != expected:
            raise ValidationError(_("The event targets a different Odoo database."))

    def _resolve_contact_route(self, payload):
        required = {
            "contactIntentId",
            "authorizationId",
            "candidateStateId",
            "odooDatabaseUuid",
            "odooApplicantId",
            "odooJobId",
            "bossAccountId",
            "contactPolicyVersionId",
            "transportMode",
        }
        missing = sorted(
            key for key in required
            if payload.get(key) in (None, "")
        )
        if missing:
            raise ValidationError(
                _("Missing contact routing fields: %s") % ", ".join(missing)
            )
        self._validate_database(payload, required=True)
        _assert_uuid(payload["contactIntentId"], "contactIntentId")
        _assert_uuid(payload["authorizationId"], "authorizationId")
        _assert_uuid(payload["candidateStateId"], "candidateStateId")
        applicant_id = _positive_integer(
            payload["odooApplicantId"], "odooApplicantId"
        )
        job_id = _positive_integer(payload["odooJobId"], "odooJobId")
        if payload["transportMode"] not in ("fake", "real"):
            raise ValidationError(_("transportMode must be fake or real."))
        if self.aggregate_id != payload["contactIntentId"]:
            raise ValidationError(
                _("The contact event aggregateId must equal contactIntentId.")
            )

        authorization = self.env[
            "boss.forge.contact.authorization"
        ].sudo().search(
            [("authorization_uuid", "=", payload["authorizationId"])],
            limit=1,
        )
        if not authorization:
            raise ValidationError(
                _("The contact event does not identify an existing authorization.")
            )
        applicant = authorization.applicant_id.exists()
        job = authorization.job_id.exists()
        if not applicant or not job:
            raise ValidationError(
                _("The contact authorization has an invalid Odoo route.")
            )
        mismatches = []
        if applicant.id != applicant_id:
            mismatches.append("odooApplicantId")
        if job.id != job_id or applicant.job_id != job:
            mismatches.append("odooJobId")
        if (
            authorization.candidate_state_id != payload["candidateStateId"]
            or applicant.bf_state_id != payload["candidateStateId"]
        ):
            mismatches.append("candidateStateId")
        if (
            authorization.boss_account_external_id != payload["bossAccountId"]
            or not job.bf_boss_account_id
            or job.bf_boss_account_id.external_id != payload["bossAccountId"]
        ):
            mismatches.append("bossAccountId")
        if authorization.policy_version_ref != payload["contactPolicyVersionId"]:
            mismatches.append("contactPolicyVersionId")
        if authorization.transport_mode != payload["transportMode"]:
            mismatches.append("transportMode")
        if mismatches:
            raise ValidationError(
                _("Contact routing fields do not match the immutable authorization: %s")
                % ", ".join(sorted(set(mismatches)))
            )
        return applicant, authorization

    def _is_stale_event(self):
        self.ensure_one()
        return bool(
            self.search(
                [
                    ("id", "!=", self.id),
                    ("state", "=", "completed"),
                    ("aggregate_type", "=", self.aggregate_type),
                    ("aggregate_id", "=", self.aggregate_id),
                    ("aggregate_version", ">", self.aggregate_version),
                ],
                limit=1,
            )
        )

    def _apply_event(self):
        self.ensure_one()
        payload = self.payload or {}
        contact_states = {
            "contact.queued.v1": "queued",
            "contact.simulated.v1": "simulated",
            "contact.sent.v1": "sent",
            "contact.failed.v1": "failed",
            "contact.uncertain.v1": "uncertain",
        }
        contact_route = (
            self._resolve_contact_route(payload)
            if self.event_type in contact_states
            else None
        )
        self._validate_database(
            payload,
            required=self.event_type in contact_states,
        )
        if self._is_stale_event():
            return {
                "ignored": True,
                "reason": "stale_aggregate_version",
                "aggregateVersion": self.aggregate_version,
            }

        if self.event_type == "screening.run.started.v1":
            run = self._find_run(payload)
            if not run:
                raise ValidationError(_("The started event does not identify an Odoo screening run."))
            if run.state not in (
                "cancel_requested", "cancelled", "completed", "failed"
            ):
                run.write({"state": "collecting", "started_at": self.occurred_at})
            return {"model": "boss.forge.screening.run", "id": run.id}

        if self.event_type == "candidate.collected.v1":
            return self._apply_candidate_collected(payload)

        if self.event_type == "candidate.screened.v1":
            applicant = self._find_applicant(payload)
            if not applicant:
                raise ValidationError(_("The screening event does not identify an existing applicant."))
            applicant._bf_apply_screening_result({**payload, "status": "completed"})
            return {"model": "hr.applicant", "id": applicant.id}

        if self.event_type == "candidate.screening_failed.v1":
            applicant = self._find_applicant(payload)
            if not applicant:
                raise ValidationError(_("The failed screening event does not identify an applicant."))
            no_text = payload.get("failureCode") == "no_text"
            applicant.write(
                {
                    "bf_screening_status": "no_text" if no_text else "failed",
                    "bf_rule_decision": "insufficient" if no_text else "ambiguous",
                    "bf_last_technical_error": payload.get("message") or payload.get("failureCode"),
                }
            )
            return {"model": "hr.applicant", "id": applicant.id}

        if self.event_type == "screening.run.completed.v1":
            run = self._find_run(payload)
            if not run:
                raise ValidationError(_("The completion event does not identify an Odoo screening run."))
            pending_review = int(payload.get("pendingReviewCount") or 0)
            terminal_status = payload.get("status")
            if terminal_status == "cancelled":
                next_state = "cancelled"
            elif terminal_status == "failed":
                next_state = "failed"
            else:
                next_state = "waiting_review" if pending_review else "completed"
            run.write(
                {
                    "state": next_state,
                    "collected_count": int(payload.get("collectedCount") or 0),
                    "matched_count": int(payload.get("matchedCount") or 0),
                    "failed_count": int(payload.get("failedCount") or 0),
                    "pending_review_count": pending_review,
                    "previewed_count": int(payload.get("collectedCount") or 0),
                    "screened_count": max(
                        int(payload.get("collectedCount") or 0)
                        - int(payload.get("failedCount") or 0),
                        0,
                    ),
                    "completed_at": self.occurred_at,
                    "error_summary": (
                        payload.get("errorMessage")
                        if terminal_status == "failed"
                        else False
                    ),
                }
            )
            return {"model": "boss.forge.screening.run", "id": run.id}

        if self.event_type in contact_states:
            applicant, authorization = contact_route
            status = contact_states[self.event_type]
            if status == "sent" and payload.get("transportMode") == "fake":
                status = "simulated"
            result = {
                **payload,
                "status": status,
                "errorSummary": payload.get("errorMessage"),
                "resultReference": payload.get("externalMessage"),
            }
            if result["status"] == "sent":
                result["contactedAt"] = fields.Datetime.to_string(self.occurred_at)
            applicant._bf_apply_contact_result(result)
            authorization._apply_result(result)
            return {"model": "hr.applicant", "id": applicant.id}

        if self.event_type == "candidate.reply.received.v1":
            applicant = self._find_applicant(payload)
            if not applicant:
                raise ValidationError(_("The reply event does not identify an existing applicant."))
            applicant.write({"bf_contact_status": "replied"})
            summary = payload.get("replySummary") or payload.get("message") or _("Candidate replied on BOSS.")
            applicant.message_post(body=str(summary)[:2000])
            return {"model": "hr.applicant", "id": applicant.id}

        if self.event_type == "boss.account.health_changed.v1":
            external_id = payload.get("bossAccountId")
            account = self.env["boss.forge.boss.account"].sudo().search(
                [("external_id", "=", external_id)], limit=1
            )
            if not account:
                raise ValidationError(_("The health event does not identify a BOSS account."))
            state_map = {
                "healthy": "healthy",
                "login_required": "login_required",
                "paused": "paused",
                "offline": "offline",
                "fault": "fault",
            }
            state = state_map.get(payload.get("healthState") or payload.get("state"), "fault")
            account.write(
                {
                    "state": state,
                    "worker_name": payload.get("workerId"),
                    "last_heartbeat_at": self.occurred_at,
                    "last_error_summary": payload.get("errorMessage"),
                }
            )
            return {"model": "boss.forge.boss.account", "id": account.id}

        raise ValidationError(_("No handler for event type %s") % self.event_type)

    def _apply_candidate_collected(self, payload):
        if not payload.get("odooJobId"):
            raise ValidationError(_("candidate.collected.v1 requires odooJobId."))
        _assert_uuid(payload.get("candidateStateId"), "candidateStateId")
        Job = self.env["hr.job"].sudo()
        job = Job.browse(int(payload["odooJobId"])).exists()
        if not job:
            raise ValidationError(_("The referenced Odoo job does not exist."))

        applicant = self._find_applicant(payload)
        if not applicant and payload.get("externalCandidateId"):
            applicant = self.env["hr.applicant"].sudo().search(
                [
                    ("job_id", "=", job.id),
                    ("bf_external_candidate_id", "=", payload["externalCandidateId"]),
                ],
                limit=1,
            )
        run = self._find_run(payload)
        screening_status = {
            "queued": "pending",
            "pending": "pending",
            "processing": "processing",
            "completed": "completed",
            "no_text": "no_text",
            "failed": "failed",
        }.get(payload.get("screeningStatus"), "pending")
        values = {
            "partner_name": payload.get("candidateName") or _("BOSS Candidate"),
            "job_id": job.id,
            "bf_external_candidate_id": payload.get("externalCandidateId"),
            "bf_identity_key": payload.get("identityKey"),
            "bf_state_id": payload.get("candidateStateId"),
            "bf_source": payload.get("source") or "recommend",
            "bf_screening_status": screening_status,
            "bf_source_fields": payload.get("fields") or {},
            "bf_screening_run_id": run.id if run else False,
        }
        values = {key: value for key, value in values.items() if value not in (None, "")}
        created = not bool(applicant)
        if applicant:
            applicant.write(values)
        else:
            applicant = self.env["hr.applicant"].sudo().create(values)
        mapping = self.env["boss.forge.external.map"].sudo().ensure_mapping(
            applicant,
            external_type="candidate_state",
            external_id=payload["candidateStateId"],
        )
        return {
            "model": "hr.applicant",
            "id": applicant.id,
            "created": created,
            "externalMapId": mapping.id,
        }


class BossForgeExternalMap(models.Model):
    _name = "boss.forge.external.map"
    _description = "Boss-Forge External ID Map"
    _order = "odoo_model, odoo_res_id"

    odoo_model = fields.Char(required=True, readonly=True, index=True)
    odoo_res_id = fields.Integer(required=True, readonly=True, index=True)
    external_type = fields.Char(required=True, readonly=True, index=True)
    external_id = fields.Char(required=True, readonly=True, index=True)
    company_id = fields.Many2one("res.company", required=True, readonly=True, default=lambda self: self.env.company)
    active = fields.Boolean(default=True)

    _odoo_mapping_unique = models.Constraint(
        "UNIQUE(company_id, odoo_model, odoo_res_id, external_type)",
        "An Odoo record may only have one mapping per external type.",
    )
    _external_mapping_unique = models.Constraint(
        "UNIQUE(company_id, external_type, external_id)",
        "An external record may only be mapped once.",
    )

    @api.model
    def ensure_mapping(self, record, external_type, external_id):
        if not record or not record.id:
            raise ValidationError(_("An external mapping requires a saved Odoo record."))
        if not external_type or not external_id:
            raise ValidationError(_("External mapping type and ID are required."))
        Mapping = self.with_context(active_test=False)
        existing_external = Mapping.search(
            [
                ("external_type", "=", external_type),
                ("external_id", "=", str(external_id)),
            ],
            limit=1,
        )
        if existing_external:
            if (
                existing_external.odoo_model != record._name
                or existing_external.odoo_res_id != record.id
            ):
                raise ValidationError(
                    _("External ID %s is already mapped to a different Odoo record.")
                    % external_id
                )
            if not existing_external.active:
                existing_external.write({"active": True})
            return existing_external
        existing_record = Mapping.search(
            [
                ("odoo_model", "=", record._name),
                ("odoo_res_id", "=", record.id),
                ("external_type", "=", external_type),
            ],
            limit=1,
        )
        if existing_record:
            raise ValidationError(
                _("This Odoo record is already mapped to another %s ID.")
                % external_type
            )
        company = record.company_id or self.env.company
        return Mapping.create(
            {
                "odoo_model": record._name,
                "odoo_res_id": record.id,
                "external_type": external_type,
                "external_id": str(external_id),
                "company_id": company.id,
            }
        )

    def write(self, values):
        immutable = {"odoo_model", "odoo_res_id", "external_type", "external_id", "company_id"}
        if immutable.intersection(values):
            raise UserError(_("External ID bindings cannot be changed in place."))
        return super().write(values)
