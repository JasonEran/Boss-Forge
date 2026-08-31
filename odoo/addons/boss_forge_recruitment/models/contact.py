import uuid

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

from .business import database_uuid, external_record_id, iso_utc


class BossForgeContactAuthorization(models.Model):
    _name = "boss.forge.contact.authorization"
    _description = "Boss-Forge Immutable Contact Authorization"
    _order = "reviewed_at desc, id desc"
    _rec_name = "authorization_uuid"

    authorization_uuid = fields.Char(
        required=True, readonly=True, copy=False, default=lambda self: str(uuid.uuid4()), index=True
    )
    applicant_id = fields.Many2one("hr.applicant", required=True, readonly=True, ondelete="restrict", index=True)
    job_id = fields.Many2one("hr.job", required=True, readonly=True, ondelete="restrict", index=True)
    company_id = fields.Many2one("res.company", required=True, readonly=True, index=True)
    candidate_state_id = fields.Char(required=True, readonly=True, index=True)
    review_version = fields.Integer(required=True, readonly=True)
    reviewer_id = fields.Many2one("res.users", required=True, readonly=True)
    reviewed_at = fields.Datetime(required=True, readonly=True)
    expires_at = fields.Datetime(required=True, readonly=True)
    boss_account_external_id = fields.Char(required=True, readonly=True)
    rule_version_ref = fields.Char(required=True, readonly=True)
    template_version_ref = fields.Char(required=True, readonly=True)
    policy_version_ref = fields.Char(required=True, readonly=True)
    rendered_message = fields.Text(required=True, readonly=True)
    transport_mode = fields.Selection([("fake", "Fake"), ("real", "Real")], required=True, readonly=True)
    snapshot = fields.Json(required=True, readonly=True)
    state = fields.Selection(
        [
            ("authorized", "Authorized"),
            ("queued", "Queued"),
            ("processing", "Processing"),
            ("simulated", "Simulated (No Message Sent)"),
            ("sent", "Sent"),
            ("failed", "Failed"),
            ("uncertain", "Uncertain"),
            ("revoked", "Revoked"),
            ("expired", "Expired"),
        ],
        required=True,
        default="authorized",
        readonly=True,
        index=True,
    )
    outbox_event_id = fields.Many2one("boss.forge.integration.outbox", readonly=True, ondelete="restrict")
    completed_at = fields.Datetime(readonly=True)
    result_reference = fields.Char(readonly=True)
    error_summary = fields.Text(readonly=True)

    _authorization_uuid_unique = models.Constraint(
        "UNIQUE(authorization_uuid)", "Contact authorization UUID must be unique."
    )
    _authorization_review_unique = models.Constraint(
        "UNIQUE(applicant_id, review_version)", "Only one authorization may exist for an applicant review version."
    )
    _review_version_positive = models.Constraint("CHECK(review_version > 0)", "Review version must be positive.")

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.context.get("bf_create_authorization") and not self.env.is_superuser():
            raise UserError(_("Contact authorizations can only be created by the review workflow."))
        return super().create(values_list)

    @api.model
    def create_from_review(
        self,
        applicant,
        review_version,
        reviewed_at,
        expires_at,
        rendered_message,
        transport_mode,
        predecessor_event=None,
    ):
        try:
            uuid.UUID(str(applicant.bf_state_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValidationError(
                _("The Boss-Forge candidate state ID must be a UUID.")
            ) from exc
        rendered_message = (rendered_message or "").strip()
        if not rendered_message or len(rendered_message) > 500:
            raise ValidationError(
                _("The final greeting must contain between 1 and 500 characters.")
            )
        job = applicant.job_id
        rule = job.bf_rule_version_id
        template = job.bf_message_template_id
        policy = job.bf_contact_policy_id
        snapshot = {
            "odooDatabaseUuid": database_uuid(self.env),
            "odooApplicantId": applicant.id,
            "odooJobId": job.id,
            "candidateStateId": applicant.bf_state_id,
            "reviewVersion": review_version,
            "reviewerId": external_record_id(self.env.user),
            "reviewedAt": iso_utc(reviewed_at),
            "bossAccountId": job.bf_boss_account_id.external_id,
            "ruleVersionId": external_record_id(rule),
            "templateVersionId": external_record_id(template),
            "contactPolicyVersionId": external_record_id(policy),
            "renderedMessage": rendered_message,
            "transportMode": transport_mode,
            "authorizationExpiresAt": iso_utc(expires_at),
            "doNotContact": False,
        }
        authorization = self.create(
            {
                "applicant_id": applicant.id,
                "job_id": job.id,
                "company_id": job.company_id.id,
                "candidate_state_id": applicant.bf_state_id,
                "review_version": review_version,
                "reviewer_id": self.env.user.id,
                "reviewed_at": reviewed_at,
                "expires_at": expires_at,
                "boss_account_external_id": job.bf_boss_account_id.external_id,
                "rule_version_ref": external_record_id(rule),
                "template_version_ref": external_record_id(template),
                "policy_version_ref": external_record_id(policy),
                "rendered_message": rendered_message,
                "transport_mode": transport_mode,
                "snapshot": snapshot,
            }
        )
        payload = {
            "authorizationId": authorization.authorization_uuid,
            "candidateStateId": applicant.bf_state_id,
            "odooDatabaseUuid": database_uuid(self.env),
            "odooApplicantId": applicant.id,
            "odooJobId": job.id,
            "reviewerId": external_record_id(self.env.user),
            "reviewedAt": iso_utc(reviewed_at),
            "reviewVersion": review_version,
            "bossAccountId": job.bf_boss_account_id.external_id,
            "ruleVersionId": external_record_id(rule),
            "templateVersionId": external_record_id(template),
            "contactPolicyVersionId": external_record_id(policy),
            "renderedMessage": rendered_message,
            "transportMode": transport_mode,
            "authorizationExpiresAt": iso_utc(expires_at),
            "doNotContact": False,
        }
        event = self.env["boss.forge.integration.outbox"].enqueue(
            "candidate.contact.authorized.v1",
            "contact.authorization",
            authorization.authorization_uuid,
            review_version,
            payload,
            predecessor_event=predecessor_event,
        )
        authorization.with_context(bf_apply_result=True).write({"state": "queued", "outbox_event_id": event.id})
        return authorization

    def action_revoke(self):
        for authorization in self:
            authorization.applicant_id._bf_assert_reviewer()
            if authorization.state not in ("authorized", "queued"):
                raise ValidationError(_("Only an unprocessed authorization can be revoked."))
            if authorization.outbox_event_id.state not in ("pending", "failed"):
                raise ValidationError(_("The v1 contract cannot revoke an authorization after delivery."))
            authorization.outbox_event_id.write(
                {"state": "dead_letter", "error_summary": "Revoked in Odoo before delivery."}
            )
            authorization.with_context(bf_apply_result=True).write({"state": "revoked"})
            authorization.applicant_id.write({"bf_contact_status": "revoked"})

    def _apply_result(self, payload):
        self.ensure_one()
        states = {
            "queued", "processing", "simulated", "sent",
            "failed", "uncertain", "revoked",
        }
        state = payload.get("status")
        if state not in states:
            raise ValidationError(_("Unsupported authorization result status."))
        values = {
            "state": state,
            "result_reference": payload.get("resultReference"),
            "error_summary": payload.get("errorSummary"),
        }
        if state in ("simulated", "sent", "failed", "uncertain", "revoked"):
            values["completed_at"] = fields.Datetime.now()
        self.with_context(bf_apply_result=True).write(values)

    def write(self, values):
        if not self.env.context.get("bf_apply_result"):
            raise UserError(_("Contact authorization snapshots are immutable."))
        allowed = {"state", "outbox_event_id", "completed_at", "result_reference", "error_summary"}
        if set(values) - allowed:
            raise UserError(_("Only delivery-result fields may change on a contact authorization."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _prevent_unlink(self):
        raise UserError(_("Contact authorizations are immutable audit records."))
