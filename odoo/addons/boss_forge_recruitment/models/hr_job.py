from odoo import fields, models, _
from odoo.exceptions import ValidationError

from .business import database_uuid, external_record_id


class HrJob(models.Model):
    _inherit = "hr.job"

    bf_enabled = fields.Boolean(string="Enable Boss-Forge", default=False, tracking=True)
    bf_job_keyword = fields.Char(string="BOSS Job Keyword", tracking=True)
    bf_boss_account_id = fields.Many2one(
        "boss.forge.boss.account", string="BOSS Account", ondelete="restrict", tracking=True
    )
    bf_message_template_id = fields.Many2one(
        "boss.forge.message.template",
        string="Greeting Template Version",
        ondelete="restrict",
        domain="[('company_id', '=', company_id), ('state', '=', 'published')]",
        tracking=True,
    )
    bf_contact_policy_id = fields.Many2one(
        "boss.forge.contact.policy",
        string="Contact Policy Version",
        ondelete="restrict",
        domain="[('company_id', '=', company_id), ('state', '=', 'published')]",
        tracking=True,
    )
    bf_auto_contact_after_review = fields.Boolean(
        string="Auto-queue after review",
        default=False,
        tracking=True,
        help="This job-level switch is off by default. The global real-contact circuit breaker remains independent.",
    )
    bf_collaborator_ids = fields.Many2many(
        "res.users", "boss_forge_job_collaborator_rel", "job_id", "user_id", string="Collaborating Recruiters"
    )
    bf_hiring_manager_ids = fields.Many2many(
        "res.users", "boss_forge_job_hiring_manager_rel", "job_id", "user_id", string="Hiring Managers"
    )
    bf_priority = fields.Selection(
        [("0", "Normal"), ("1", "High"), ("2", "Urgent")], string="Boss-Forge Priority", default="0"
    )
    bf_target_date = fields.Date(string="Hiring Target Date")
    bf_last_sync_at = fields.Datetime(readonly=True)
    bf_health_state = fields.Selection(
        [("ok", "OK"), ("login_required", "Login Required"), ("paused", "Paused"), ("fault", "Fault")],
        default="paused",
        readonly=True,
    )
    bf_config_version = fields.Integer(default=0, readonly=True, copy=False)

    def _bf_assert_recruiter(self):
        for job in self:
            allowed = (
                self.env.is_superuser()
                or self.env.user.has_group("hr_recruitment.group_hr_recruitment_manager")
                or job.user_id == self.env.user
                or self.env.user in job.bf_collaborator_ids
            )
            if not allowed:
                raise ValidationError(_("You are not assigned to this job's Boss-Forge recruitment team."))

    def _bf_validate_configuration(self):
        self.ensure_one()
        missing = []
        if not self.bf_enabled:
            missing.append(_("Boss-Forge enabled"))
        if not self.company_id:
            missing.append(_("company"))
        if not self.user_id:
            missing.append(_("primary recruiter"))
        if not self.bf_boss_account_id:
            missing.append(_("BOSS account"))
        if not self.bf_rule_version_id or self.bf_rule_version_id.state != "published":
            missing.append(_("published rule version"))
        if not self.bf_message_template_id or self.bf_message_template_id.state != "published":
            missing.append(_("published greeting template"))
        if not self.bf_contact_policy_id or self.bf_contact_policy_id.state != "published":
            missing.append(_("published contact policy"))
        if missing:
            raise ValidationError(_("Incomplete Boss-Forge job configuration: %s") % ", ".join(missing))
        if self.bf_boss_account_id.company_id != self.company_id:
            raise ValidationError(_("The BOSS account and job must belong to the same company."))
        if self.bf_rule_version_id.rule_set_id.job_id != self:
            raise ValidationError(_("The published rule version must belong to this job."))

    def action_bf_publish_config(self):
        Outbox = self.env["boss.forge.integration.outbox"]
        for job in self:
            job._bf_assert_recruiter()
            job._bf_validate_configuration()
            self.env.cr.execute("SELECT bf_config_version FROM hr_job WHERE id = %s FOR UPDATE", [job.id])
            next_version = (self.env.cr.fetchone()[0] or 0) + 1
            job.write({"bf_config_version": next_version, "bf_last_sync_at": fields.Datetime.now()})
            rule = job.bf_rule_version_id
            policy = job.bf_contact_policy_id
            template = job.bf_message_template_id
            Outbox.enqueue(
                "job.config.published.v1",
                "hr.job",
                external_record_id(job),
                next_version,
                {
                    "odooDatabaseUuid": database_uuid(self.env),
                    "odooJobId": job.id,
                    "odooCompanyId": job.company_id.id,
                    "name": job.name,
                    "bossAccountId": job.bf_boss_account_id.external_id,
                    "bossJobKeyword": job.bf_job_keyword or None,
                    "ownerId": external_record_id(job.user_id),
                    "collaboratorIds": [external_record_id(user) for user in job.bf_collaborator_ids],
                    "active": bool(job.active and job.bf_enabled),
                    "rule": {
                        "versionId": external_record_id(rule),
                        "version": rule.version_number,
                        "schemaVersion": rule.schema_version,
                        "dictionaryVersion": rule.dictionary_version,
                        "config": rule.execution_config(),
                    },
                    "contactPolicy": {
                        **policy.execution_snapshot(),
                        "policyVersionId": external_record_id(policy),
                        "autoContactAfterReview": job.bf_auto_contact_after_review,
                    },
                },
            )
        return True

    def action_bf_request_screening(self):
        self.ensure_one()
        run = self.env["boss.forge.screening.run"].request_for_job(self, source="recommend", mode="immediate")
        return {
            "type": "ir.actions.act_window",
            "res_model": "boss.forge.screening.run",
            "res_id": run.id,
            "view_mode": "form",
            "target": "current",
        }
