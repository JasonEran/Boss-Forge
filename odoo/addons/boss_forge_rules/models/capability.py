import re
import unicodedata

from odoo import api, fields, models, _
from odoo.exceptions import ValidationError


def normalize_alias(value):
    value = unicodedata.normalize("NFKC", value or "").casefold().strip()
    return re.sub(r"[\s\-_/·.,，。()（）]+", "", value)


class BossForgeCapability(models.Model):
    _name = "boss.forge.capability"
    _description = "Boss-Forge Standard Capability"
    _order = "category, name"

    name = fields.Char(required=True, translate=True)
    code = fields.Char(required=True, index=True)
    category = fields.Selection(
        [
            ("language", "Language"),
            ("certificate", "Certificate"),
            ("skill", "Skill"),
            ("job_family", "Job Family"),
            ("industry", "Industry"),
        ],
        required=True,
        default="skill",
    )
    description = fields.Text(translate=True)
    alias_ids = fields.One2many("boss.forge.capability.alias", "capability_id")
    active = fields.Boolean(default=True)

    _code_unique = models.Constraint("UNIQUE(code)", "Capability code must be unique.")

    @api.constrains("code")
    def _check_code(self):
        for record in self:
            if not re.fullmatch(r"[a-z][a-z0-9_]*", record.code or ""):
                raise ValidationError(_("Capability codes use lowercase letters, digits, and underscores."))


class BossForgeCapabilityAlias(models.Model):
    _name = "boss.forge.capability.alias"
    _description = "Boss-Forge Capability Alias"
    _order = "capability_id, alias_type, term"

    capability_id = fields.Many2one("boss.forge.capability", required=True, ondelete="cascade", index=True)
    term = fields.Char(required=True)
    normalized_term = fields.Char(compute="_compute_normalized_term", store=True, index=True)
    alias_type = fields.Selection(
        [
            ("confirmed", "Confirmed"),
            ("negative", "Negative"),
            ("planned", "Planned"),
            ("failed", "Failed"),
            ("confusable", "Confusable"),
        ],
        required=True,
        default="confirmed",
        help="Negative/planned/failed expressions are evidence against a confirmed capability.",
    )
    locale = fields.Char(default="zh_CN")
    active = fields.Boolean(default=True)

    _alias_unique = models.Constraint(
        "UNIQUE(capability_id, normalized_term, alias_type)",
        "This normalized alias already exists for the capability and expression type.",
    )

    @api.depends("term")
    def _compute_normalized_term(self):
        for record in self:
            record.normalized_term = normalize_alias(record.term)

    @api.constrains("normalized_term")
    def _check_normalized_term(self):
        if any(not record.normalized_term for record in self):
            raise ValidationError(_("An alias cannot normalize to an empty value."))
