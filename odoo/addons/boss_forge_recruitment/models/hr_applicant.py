import uuid
from datetime import timedelta

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

from .business import database_uuid, external_record_id, iso_utc


class HrApplicant(models.Model):
    _inherit = "hr.applicant"

    bf_source = fields.Selection(
        [("recommend", "Recommended"), ("search", "Search"), ("deep_search", "Deep Search")],
        string="BOSS Source",
        index=True,
    )
    bf_external_candidate_id = fields.Char(string="BOSS Candidate ID", index=True, copy=False)
    bf_identity_key = fields.Char(string="Boss-Forge Identity Key", index=True, copy=False)
    bf_state_id = fields.Char(string="Boss-Forge Candidate State ID", index=True, copy=False)
    bf_source_fields = fields.Json(string="BOSS Source Fields", readonly=True)
    bf_screening_run_id = fields.Many2one("boss.forge.screening.run", ondelete="set null", index=True)
    bf_screening_status = fields.Selection(
        [
            ("pending", "Pending"),
            ("processing", "Processing"),
            ("completed", "Completed"),
            ("no_text", "No Resume Text"),
            ("failed", "Failed"),
        ],
        default="pending",
        index=True,
    )
    bf_rule_decision = fields.Selection(
        [
            ("matched", "Matched"),
            ("not_matched", "Not Matched"),
            ("insufficient", "Insufficient Information"),
            ("ambiguous", "Ambiguous"),
        ],
        string="Rule Decision",
        index=True,
    )
    bf_rule_score = fields.Float(string="Rule Score", digits=(8, 2))
    bf_rule_confidence = fields.Float(string="Rule Confidence", digits=(5, 4))
    bf_rule_version_ref = fields.Char(string="Rule Version Snapshot", readonly=True)
    bf_reason_codes = fields.Json(string="Rule Reason Codes", readonly=True)
    bf_current_english_level = fields.Char(string="Current English Level")
    bf_external_review_status = fields.Selection(
        [("pending", "Pending"), ("approved", "Approved"), ("rejected", "Rejected")],
        string="Boss-Forge Review State",
        readonly=True,
    )
    bf_institution_decision = fields.Selection(
        [("matched", "Matched"), ("not_matched", "Not Matched"), ("unknown", "Manual Review")],
        string="Institution Decision",
    )
    bf_institution_summary = fields.Char(string="Institution Summary")
    bf_review_status = fields.Selection(
        [
            ("pending", "Pending Review"),
            ("passed", "Passed"),
            ("rejected", "Rejected"),
            ("needs_review", "Needs Review"),
        ],
        default="pending",
        required=True,
        index=True,
        tracking=True,
    )
    bf_reviewed_by = fields.Many2one("res.users", readonly=True)
    bf_reviewed_at = fields.Datetime(readonly=True)
    bf_review_version = fields.Integer(default=0, readonly=True, copy=False)
    bf_rejection_reason = fields.Text()
    bf_contact_status = fields.Selection(
        [
            ("unauthorized", "Not Authorized"),
            ("queued", "Queued"),
            ("processing", "Processing"),
            ("simulated", "Simulated (No Message Sent)"),
            ("sent", "Sent"),
            ("failed", "Failed"),
            ("uncertain", "Uncertain"),
            ("replied", "Replied"),
            ("revoked", "Revoked"),
        ],
        default="unauthorized",
        required=True,
        index=True,
        tracking=True,
    )
    bf_last_contact_at = fields.Datetime(readonly=True)
    bf_contact_owner_id = fields.Many2one("res.users", string="Contact Owner")
    bf_do_not_contact = fields.Boolean(string="Do Not Contact", default=False, tracking=True)
    bf_do_not_contact_reason = fields.Text()
    bf_last_technical_error = fields.Text(readonly=True)
    bf_evidence_ids = fields.One2many("boss.forge.match.evidence", "applicant_id", string="Rule Evidence")
    bf_education_ids = fields.One2many(
        "boss.forge.applicant.education", "applicant_id", string="Education Evidence"
    )
    bf_contact_authorization_ids = fields.One2many(
        "boss.forge.contact.authorization", "applicant_id", string="Contact Authorizations"
    )

    _bf_candidate_job_unique = models.Constraint(
        "UNIQUE(job_id, bf_external_candidate_id)",
        "A BOSS candidate may only have one application per job.",
    )
    _bf_state_id_unique = models.Constraint(
        "UNIQUE(bf_state_id)",
        "A Boss-Forge candidate state may only map to one Odoo application.",
    )

    @api.constrains("bf_do_not_contact", "bf_do_not_contact_reason")
    def _check_do_not_contact_reason(self):
        for record in self:
            if record.bf_do_not_contact and not (record.bf_do_not_contact_reason or "").strip():
                raise ValidationError(_("A reason is required when a candidate must not be contacted."))

    def _bf_lock_review(self):
        self.ensure_one()
        self.env.cr.execute("SELECT bf_review_version FROM hr_applicant WHERE id = %s FOR UPDATE", [self.id])
        current = self.env.cr.fetchone()[0] or 0
        expected = self.env.context.get("bf_expected_review_version")
        if expected is not None and int(expected) != current:
            raise UserError(_("This candidate was reviewed by someone else. Refresh before retrying."))
        return current

    def _bf_assert_reviewer(self):
        self.ensure_one()
        if not self.job_id:
            raise ValidationError(_("A Boss-Forge candidate must belong to a job before review."))
        self.job_id._bf_assert_recruiter()

    def _bf_enqueue_review_completed(
        self, decision, reviewed_at, review_version
    ):
        self.ensure_one()
        if decision not in ("approved", "rejected"):
            raise ValidationError(_("Unsupported terminal review decision."))
        try:
            uuid.UUID(str(self.bf_state_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValidationError(
                _("A terminal review requires a valid Boss-Forge candidate state ID.")
            ) from exc
        payload = {
            "candidateStateId": self.bf_state_id,
            "odooDatabaseUuid": database_uuid(self.env),
            "odooApplicantId": self.id,
            "odooJobId": self.job_id.id,
            "decision": decision,
            "reviewerId": external_record_id(self.env.user),
            "reviewedAt": iso_utc(reviewed_at),
            "reviewVersion": review_version,
        }
        return self.env["boss.forge.integration.outbox"].enqueue(
            "candidate.review.completed.v1",
            "candidate_state",
            self.bf_state_id,
            review_version,
            payload,
        )

    def action_bf_review_without_contact(self):
        for applicant in self:
            applicant._bf_assert_reviewer()
            current = applicant._bf_lock_review()
            reviewed_at = fields.Datetime.now()
            review_version = current + 1
            applicant.write(
                {
                    "bf_review_status": "passed",
                    "bf_reviewed_by": self.env.user.id,
                    "bf_reviewed_at": reviewed_at,
                    "bf_review_version": review_version,
                    "bf_contact_status": "unauthorized",
                    "bf_rejection_reason": False,
                }
            )
            applicant._bf_enqueue_review_completed(
                "approved", reviewed_at, review_version
            )
            applicant.message_post(body=_("Candidate passed review without contact authorization."))
        return True

    def action_bf_review_and_contact(self):
        Authorization = self.env["boss.forge.contact.authorization"]
        for applicant in self:
            applicant._bf_assert_reviewer()
            applicant.job_id._bf_validate_configuration()
            if not applicant.job_id.bf_auto_contact_after_review:
                raise ValidationError(_("Auto-contact after review is disabled for this job."))
            if applicant.bf_do_not_contact:
                raise ValidationError(_("This candidate is marked Do Not Contact."))
            if not applicant.bf_state_id:
                raise ValidationError(_("The candidate is not yet mapped to a Boss-Forge candidate state."))
            if applicant.bf_contact_status in (
                "queued", "processing", "sent", "replied"
            ):
                raise ValidationError(_("This job application already has an active or completed contact."))

            current = applicant._bf_lock_review()
            review_version = current + 1
            reviewed_at = fields.Datetime.now()
            applicant.write(
                {
                    "bf_review_status": "passed",
                    "bf_reviewed_by": self.env.user.id,
                    "bf_reviewed_at": reviewed_at,
                    "bf_review_version": review_version,
                    "bf_contact_status": "queued",
                    "bf_contact_owner_id": self.env.user.id,
                    "bf_rejection_reason": False,
                }
            )
            review_event = applicant._bf_enqueue_review_completed(
                "approved", reviewed_at, review_version
            )
            policy = applicant.job_id.bf_contact_policy_id
            expires_at = reviewed_at + timedelta(hours=policy.authorization_ttl_hours)
            rendered_message = applicant.job_id.bf_message_template_id.render_message(applicant)
            params = self.env["ir.config_parameter"].sudo()
            requested_mode = params.get_param("boss_forge_connector.contact_transport_mode") or "fake"
            real_enabled = (params.get_param("boss_forge_connector.real_contact_enabled") or "False").lower() in (
                "1",
                "true",
                "yes",
            )
            transport_mode = "real" if requested_mode == "real" and real_enabled else "fake"
            authorization = Authorization.with_context(bf_create_authorization=True).create_from_review(
                applicant,
                review_version=review_version,
                reviewed_at=reviewed_at,
                expires_at=expires_at,
                rendered_message=rendered_message,
                transport_mode=transport_mode,
                predecessor_event=review_event,
            )
            applicant.message_post(
                body=_("Candidate passed review; immutable contact authorization %s was queued in %s mode.")
                % (authorization.authorization_uuid, transport_mode)
            )
        return True

    def action_bf_reject(self):
        for applicant in self:
            applicant._bf_assert_reviewer()
            if not (applicant.bf_rejection_reason or "").strip():
                raise ValidationError(_("Enter a rejection reason before rejecting the candidate."))
            current = applicant._bf_lock_review()
            reviewed_at = fields.Datetime.now()
            review_version = current + 1
            applicant.write(
                {
                    "bf_review_status": "rejected",
                    "bf_reviewed_by": self.env.user.id,
                    "bf_reviewed_at": reviewed_at,
                    "bf_review_version": review_version,
                }
            )
            applicant._bf_enqueue_review_completed(
                "rejected", reviewed_at, review_version
            )
            applicant.message_post(body=_("Candidate was rejected in Boss-Forge review."))
        return True

    def action_bf_needs_review(self):
        for applicant in self:
            applicant._bf_assert_reviewer()
            current = applicant._bf_lock_review()
            applicant.write(
                {
                    "bf_review_status": "needs_review",
                    "bf_reviewed_by": self.env.user.id,
                    "bf_reviewed_at": fields.Datetime.now(),
                    "bf_review_version": current + 1,
                }
            )
            applicant.message_post(body=_("Candidate was escalated for further review."))
        return True

    def _bf_apply_screening_result(self, payload):
        self.ensure_one()
        decision_map = {
            "matched": "matched",
            "not_matched": "not_matched",
            "insufficient": "insufficient",
            "ambiguous": "ambiguous",
        }
        status_map = {
            "completed": "completed",
            "no_text": "no_text",
            "failed": "failed",
            "processing": "processing",
        }
        values = {
            "bf_screening_status": status_map.get(payload.get("status"), "completed"),
            "bf_rule_decision": decision_map.get(payload.get("decision"), "ambiguous"),
            "bf_rule_score": float(payload.get("score") or 0),
            "bf_rule_confidence": float(payload.get("confidence") or 0),
            "bf_rule_version_ref": payload.get("ruleVersionId"),
            "bf_reason_codes": payload.get("reasonCodes") or [],
            "bf_current_english_level": payload.get("currentEnglishLevel"),
            "bf_external_review_status": (
                payload.get("reviewStatus")
                if payload.get("reviewStatus") in ("pending", "approved", "rejected")
                else False
            ),
            "bf_institution_decision": payload.get("institutionDecision")
            if payload.get("institutionDecision") in ("matched", "not_matched", "unknown")
            else False,
            "bf_institution_summary": payload.get("institutionSummary"),
            "bf_last_technical_error": payload.get("errorSummary"),
        }
        self.write(values)
        self.bf_evidence_ids.filtered(
            lambda line: line.screening_run_id == self.bf_screening_run_id
        ).unlink()
        for line in (payload.get("evidence") or [])[:500]:
            self.env["boss.forge.match.evidence"].sudo().create_from_payload(self, line, payload)
        if "education" in payload:
            self._bf_replace_education(payload.get("education") or [], payload)

    def _bf_replace_education(self, education_lines, payload):
        self.ensure_one()
        self.bf_education_ids.unlink()
        catalog = self.env["boss.forge.institution.catalog"].sudo().search(
            [
                ("company_id", "=", self.company_id.id),
                ("version", "=", payload.get("institutionCatalogVersion")),
            ],
            limit=1,
        )
        Education = self.env["boss.forge.applicant.education"].sudo()
        for line in education_lines[:50]:
            raw_name = line.get("institutionRaw") or ""
            resolution = (
                self.env["boss.forge.institution.alias"].sudo().resolve(raw_name, catalog)
                if catalog and raw_name
                else {"status": "unknown", "institutionIds": [], "aliasIds": []}
            )
            institution_id = resolution["institutionIds"][0] if resolution["status"] == "confirmed" else False
            alias_id = resolution["aliasIds"][0] if resolution["status"] == "confirmed" else False
            category_snapshot = line.get("categorySnapshot") or []
            if institution_id and not category_snapshot:
                category_snapshot = self.env["boss.forge.institution"].browse(institution_id).category_ids.mapped("code")
            Education.create(
                {
                    "applicant_id": self.id,
                    "stage": line.get("stage") if line.get("stage") in Education._fields["stage"].get_values(self.env) else "other",
                    "institution_raw": raw_name or _("Unknown institution"),
                    "institution_id": institution_id,
                    "institution_alias_id": alias_id,
                    "catalog_id": catalog.id if catalog else False,
                    "degree": line.get("degree"),
                    "major": line.get("major"),
                    "start_at": line.get("startAt"),
                    "end_at": line.get("endAt"),
                    "campus_or_college": line.get("campusOrCollege"),
                    "category_snapshot": category_snapshot,
                    "confidence": float(line.get("confidence") or 0),
                    "evidence_text": line.get("evidenceText"),
                    "artifact_reference": line.get("artifactReference"),
                    "normalization_status": resolution["status"],
                }
            )

    def _bf_apply_contact_result(self, payload):
        self.ensure_one()
        status_map = {
            "queued": "queued",
            "processing": "processing",
            "simulated": "simulated",
            "sent": "sent",
            "failed": "failed",
            "uncertain": "uncertain",
            "replied": "replied",
            "revoked": "revoked",
        }
        status = status_map.get(payload.get("status"))
        if not status:
            raise ValidationError(_("Unsupported contact result status."))
        values = {"bf_contact_status": status, "bf_last_technical_error": payload.get("errorSummary")}
        if payload.get("contactedAt"):
            values["bf_last_contact_at"] = fields.Datetime.to_datetime(payload["contactedAt"])
        self.write(values)
        if status == "uncertain":
            self.message_post(body=_("Contact result is uncertain. Automatic sending must remain paused pending review."))


class BossForgeMatchEvidence(models.Model):
    _name = "boss.forge.match.evidence"
    _description = "Boss-Forge Screening Evidence Mirror"
    _order = "sequence, id"

    applicant_id = fields.Many2one("hr.applicant", required=True, ondelete="cascade", index=True)
    screening_run_id = fields.Many2one("boss.forge.screening.run", ondelete="set null", index=True)
    sequence = fields.Integer(default=10)
    requirement = fields.Char(required=True)
    evidence_text = fields.Text()
    normalized_label = fields.Char()
    decision = fields.Selection(
        [("matched", "Matched"), ("not_matched", "Not Matched"), ("unknown", "Unknown")], required=True
    )
    confidence = fields.Float(digits=(5, 4))
    reason_code = fields.Char(index=True)
    dictionary_version = fields.Char()
    catalog_version = fields.Char()
    page_number = fields.Integer()
    artifact_reference = fields.Char(help="Opaque Boss-Forge artifact ID; never a BOSS cookie or local profile path.")

    @api.model
    def create_from_payload(self, applicant, line, result_payload):
        decision = line.get("decision")
        if decision not in ("matched", "not_matched", "unknown"):
            decision = {
                "positive": "matched",
                "negative": "not_matched",
                "ambiguous": "unknown",
            }.get(line.get("status"), "unknown")
        reason_codes = line.get("reasonCodes") or []
        if not isinstance(reason_codes, list):
            reason_codes = [reason_codes]
        return self.create(
            {
                "applicant_id": applicant.id,
                "screening_run_id": applicant.bf_screening_run_id.id,
                "sequence": int(line.get("sequence") or 10),
                "requirement": (
                    line.get("requirement")
                    or line.get("canonicalLabel")
                    or line.get("capabilityId")
                    or line.get("field")
                    or _("Rule condition")
                ),
                "evidence_text": line.get("evidenceText") or line.get("sourceText"),
                "normalized_label": (
                    line.get("normalizedLabel") or line.get("normalizedAlias")
                ),
                "decision": decision,
                "confidence": float(line.get("confidence") or 0),
                "reason_code": line.get("reasonCode") or ",".join(reason_codes)[:255],
                "dictionary_version": line.get("dictionaryVersion") or result_payload.get("dictionaryVersion"),
                "catalog_version": line.get("catalogVersion") or result_payload.get("institutionCatalogVersion"),
                "page_number": line.get("pageNumber"),
                "artifact_reference": line.get("artifactReference"),
            }
        )


class BossForgeApplicantEducation(models.Model):
    _name = "boss.forge.applicant.education"
    _description = "Boss-Forge Applicant Education Evidence"
    _order = "end_at desc, id"

    applicant_id = fields.Many2one("hr.applicant", required=True, ondelete="cascade", index=True)
    stage = fields.Selection(
        [("college", "College"), ("bachelor", "Bachelor"), ("master", "Master"), ("doctor", "Doctor"), ("other", "Other")],
        required=True,
        default="other",
    )
    institution_raw = fields.Char(required=True)
    institution_id = fields.Many2one("boss.forge.institution", ondelete="restrict")
    institution_alias_id = fields.Many2one("boss.forge.institution.alias", ondelete="restrict")
    catalog_id = fields.Many2one("boss.forge.institution.catalog", ondelete="restrict")
    degree = fields.Char()
    major = fields.Char()
    start_at = fields.Date()
    end_at = fields.Date()
    campus_or_college = fields.Char()
    category_snapshot = fields.Json(readonly=True)
    confidence = fields.Float(digits=(5, 4))
    normalization_status = fields.Selection(
        [("confirmed", "Confirmed"), ("unknown", "Manual Review")], required=True, default="unknown"
    )
    evidence_text = fields.Text()
    artifact_reference = fields.Char()
