from datetime import timezone

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError


def database_uuid(env):
    params = env["ir.config_parameter"].sudo()
    return params.get_param("database.uuid") or env.cr.dbname


def external_record_id(record):
    return f"{database_uuid(record.env)}:{record._name}:{record.id}"


def iso_utc(value):
    value = fields.Datetime.to_datetime(value)
    if value.tzinfo:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="seconds") + "Z"


class BossForgeBossAccount(models.Model):
    _name = "boss.forge.boss.account"
    _description = "Boss-Forge BOSS Account Mirror"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "company_id, name"

    name = fields.Char(required=True, tracking=True, help="A business-facing masked account name.")
    external_id = fields.Char(required=True, index=True, tracking=True)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company, index=True)
    department_id = fields.Many2one("hr.department", tracking=True)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user, tracking=True)
    worker_name = fields.Char(readonly=True)
    state = fields.Selection(
        [
            ("healthy", "Healthy"),
            ("login_required", "Login Required"),
            ("paused", "Paused"),
            ("offline", "Worker Offline"),
            ("fault", "Fault"),
        ],
        required=True,
        default="login_required",
        tracking=True,
        index=True,
    )
    daily_contact_limit = fields.Integer(default=20)
    contacts_used_today = fields.Integer(readonly=True)
    last_heartbeat_at = fields.Datetime(readonly=True)
    last_error_summary = fields.Text(readonly=True)
    active = fields.Boolean(default=True)

    _external_id_unique = models.Constraint(
        "UNIQUE(company_id, external_id)", "BOSS account external ID must be unique per company."
    )
    _daily_limit_nonnegative = models.Constraint(
        "CHECK(daily_contact_limit >= 0)", "Daily contact limit cannot be negative."
    )


class BossForgeMessageTemplate(models.Model):
    _name = "boss.forge.message.template"
    _description = "Boss-Forge Greeting Template Version"
    _order = "name, version desc"

    name = fields.Char(required=True)
    template_code = fields.Char(required=True, index=True)
    version = fields.Integer(required=True, default=1)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company, index=True)
    state = fields.Selection(
        [("draft", "Draft"), ("published", "Published"), ("retired", "Retired")],
        required=True,
        default="draft",
    )
    body = fields.Text(
        required=True,
        help="Supported placeholders: {candidate_name}, {job_name}, {company_name}. No code expressions are evaluated.",
    )
    published_by = fields.Many2one("res.users", readonly=True)
    published_at = fields.Datetime(readonly=True)
    active = fields.Boolean(default=True)

    _template_version_unique = models.Constraint(
        "UNIQUE(company_id, template_code, version)", "Template version must be unique per company."
    )
    _template_version_positive = models.Constraint("CHECK(version > 0)", "Template version must be positive.")

    def action_publish(self):
        for record in self:
            if record.state != "draft":
                raise UserError(_("Only draft templates can be published."))
            record.write(
                {"state": "published", "published_by": self.env.user.id, "published_at": fields.Datetime.now()}
            )

    def action_retire(self):
        self.filtered(lambda record: record.state == "published").write({"state": "retired"})

    def render_message(self, applicant):
        self.ensure_one()
        if self.state != "published":
            raise ValidationError(_("Only a published greeting template can be used."))
        values = {
            "candidate_name": applicant.partner_name or _("Candidate"),
            "job_name": applicant.job_id.name or "",
            "company_name": applicant.company_id.name or "",
        }
        rendered = self.body
        for key, value in values.items():
            rendered = rendered.replace("{" + key + "}", value)
        if "{" in rendered or "}" in rendered:
            raise ValidationError(_("The greeting template contains an unsupported placeholder."))
        rendered = rendered.strip()
        if not rendered or len(rendered) > 500:
            raise ValidationError(
                _("The final greeting must contain between 1 and 500 characters.")
            )
        return rendered

    def write(self, values):
        for record in self:
            if record.state in ("published", "retired"):
                allowed_retirement = (
                    record.state == "published" and set(values) == {"state"} and values.get("state") == "retired"
                )
                if not allowed_retirement:
                    raise UserError(_("Published greeting templates are immutable; create a new version."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.state != "draft" for record in self):
            raise UserError(_("Published greeting templates cannot be deleted."))


class BossForgeContactPolicy(models.Model):
    _name = "boss.forge.contact.policy"
    _description = "Boss-Forge Contact Policy Version"
    _order = "name, version desc"

    name = fields.Char(required=True)
    policy_code = fields.Char(required=True, index=True)
    version = fields.Integer(required=True, default=1)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company, index=True)
    state = fields.Selection(
        [("draft", "Draft"), ("published", "Published"), ("retired", "Retired")],
        required=True,
        default="draft",
    )
    daily_limit = fields.Integer(required=True, default=20)
    start_hour = fields.Float(required=True, default=9.0)
    end_hour = fields.Float(required=True, default=18.0)
    cross_job_cooldown_days = fields.Integer(required=True, default=30)
    authorization_ttl_hours = fields.Integer(required=True, default=24)
    stop_on_uncertain = fields.Boolean(default=True)
    published_by = fields.Many2one("res.users", readonly=True)
    published_at = fields.Datetime(readonly=True)
    active = fields.Boolean(default=True)

    _policy_version_unique = models.Constraint(
        "UNIQUE(company_id, policy_code, version)", "Policy version must be unique per company."
    )
    _daily_limit_nonnegative = models.Constraint("CHECK(daily_limit >= 0)", "Daily limit cannot be negative.")
    _cooldown_nonnegative = models.Constraint(
        "CHECK(cross_job_cooldown_days >= 0)", "Cross-job cooldown cannot be negative."
    )
    _ttl_positive = models.Constraint(
        "CHECK(authorization_ttl_hours > 0)", "Authorization TTL must be positive."
    )

    @api.constrains("start_hour", "end_hour")
    def _check_hours(self):
        for record in self:
            if not 0 <= record.start_hour < record.end_hour <= 24:
                raise ValidationError(_("Contact hours must satisfy 0 <= start < end <= 24."))

    def execution_snapshot(self):
        self.ensure_one()
        if self.state != "published":
            raise ValidationError(
                _("Only a published contact policy can be snapshotted.")
            )
        return {
            "dailyLimit": self.daily_limit,
            "allowedStartMinute": int(round(self.start_hour * 60)),
            "allowedEndMinute": int(round(self.end_hour * 60)),
            "crossPositionCooldownHours": self.cross_job_cooldown_days * 24,
            "authorizationTtlHours": self.authorization_ttl_hours,
            "stopOnUncertain": self.stop_on_uncertain,
        }

    def action_publish(self):
        for record in self:
            if record.state != "draft":
                raise UserError(_("Only draft policies can be published."))
            record.write(
                {"state": "published", "published_by": self.env.user.id, "published_at": fields.Datetime.now()}
            )

    def action_retire(self):
        self.filtered(lambda record: record.state == "published").write({"state": "retired"})

    def write(self, values):
        for record in self:
            if record.state in ("published", "retired"):
                allowed_retirement = (
                    record.state == "published" and set(values) == {"state"} and values.get("state") == "retired"
                )
                if not allowed_retirement:
                    raise UserError(_("Published contact policies are immutable; create a new version."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.state != "draft" for record in self):
            raise UserError(_("Published contact policies cannot be deleted."))
