import hashlib
import json
import re
import unicodedata
from datetime import timezone

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError


def normalize_institution_name(value):
    value = unicodedata.normalize("NFKC", value or "").casefold().strip()
    return re.sub(r"[\s\-_/·.,，。()（）]+", "", value)


CATALOG_CATEGORY_CODES = {
    "project_985", "project_211", "double_first_class_university",
    "double_first_class_discipline", "company_allowlist",
    "company_blocklist", "overseas", "other_domestic",
}
INSTITUTION_KIND_MAP = {
    "main": "university", "college": "college",
    "independent_college": "independent_college", "campus": "campus",
    "research_institute": "research_institute", "joint_program": "other",
    "other": "other",
}
ALIAS_KIND_MAP = {
    "short": "abbreviation", "english": "english_name",
    "former": "former_name", "ocr": "ocr_variant",
    "campus": "campus_mapping",
}


def _external_record_id(record):
    params = record.env["ir.config_parameter"].sudo()
    database_id = params.get_param("database.uuid") or record.env.cr.dbname
    return f"{database_id}:{record._name}:{record.id}"


def _iso_utc(value):
    value = fields.Datetime.to_datetime(value)
    if value.tzinfo:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="seconds") + "Z"


def _stable_json(value):
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False,
    )


class BossForgeInstitutionCategory(models.Model):
    _name = "boss.forge.institution.category"
    _description = "Boss-Forge Institution Category"
    _order = "sequence, code"

    name = fields.Char(required=True, translate=True)
    code = fields.Char(required=True, index=True)
    sequence = fields.Integer(default=10)
    description = fields.Text(translate=True)
    active = fields.Boolean(default=True)

    _code_unique = models.Constraint("UNIQUE(code)", "Institution category code must be unique.")


class BossForgeInstitutionCatalog(models.Model):
    _name = "boss.forge.institution.catalog"
    _description = "Boss-Forge Institution Catalog Version"
    _order = "published_at desc, id desc"

    name = fields.Char(required=True)
    version = fields.Char(required=True, index=True)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company, index=True)
    state = fields.Selection(
        [("draft", "Draft"), ("published", "Published"), ("retired", "Retired")],
        required=True,
        default="draft",
        index=True,
    )
    source_name = fields.Char(required=True)
    source_date = fields.Date(required=True)
    source_reference = fields.Char(help="Internal document number or approved source URL.")
    validation_notes = fields.Text()
    change_summary = fields.Text()
    institution_ids = fields.One2many("boss.forge.institution", "catalog_id")
    institution_count = fields.Integer(compute="_compute_institution_count")
    content_hash = fields.Char(readonly=True, copy=False)
    published_by = fields.Many2one("res.users", readonly=True, copy=False)
    published_at = fields.Datetime(readonly=True, copy=False)

    _catalog_version_unique = models.Constraint(
        "UNIQUE(company_id, version)", "Institution catalog version must be unique per company."
    )

    @api.depends("institution_ids")
    def _compute_institution_count(self):
        for record in self:
            record.institution_count = len(record.institution_ids)

    def _catalog_draft(self, published_at=None, reviewed_by=None, status=None):
        self.ensure_one()
        reviewed_by = reviewed_by or self.published_by
        published_at = published_at or self.published_at
        if not reviewed_by or not published_at:
            raise ValidationError(
                _("A catalog snapshot requires its reviewer and publication time.")
            )
        if not (self.change_summary or "").strip():
            raise ValidationError(
                _("A change summary is required before publishing a catalog.")
            )
        institutions = [
            institution._rule_engine_snapshot()
            for institution in self.institution_ids.sorted(
                lambda item: item.code or ""
            )
        ]
        source = {
            "name": self.source_name.strip(),
            "asOfDate": fields.Date.to_string(self.source_date),
        }
        if (self.source_reference or "").strip():
            source["url"] = self.source_reference.strip()
        return {
            "schemaVersion": "1.0",
            "version": self.version.strip(),
            "status": status or self.state,
            "source": source,
            "importedBy": _external_record_id(self.create_uid),
            "reviewedBy": _external_record_id(reviewed_by),
            "publishedAt": _iso_utc(published_at),
            "changeSummary": self.change_summary.strip(),
            "institutions": institutions,
        }

    def _calculate_content_hash(self, draft):
        self.ensure_one()
        digest = hashlib.sha256(_stable_json(draft).encode("utf-8")).hexdigest()
        return "sha256:" + digest

    def rule_engine_snapshot(self):
        self.ensure_one()
        self._assert_published_for_rule_use()
        if not self.content_hash:
            raise ValidationError(
                _("Only a published institution catalog can be snapshotted.")
            )
        draft = self._catalog_draft()
        expected = self._calculate_content_hash(draft)
        if expected != self.content_hash:
            raise ValidationError(
                _("The published institution catalog content hash is invalid.")
            )
        return {**draft, "contentHash": expected}

    def _assert_published_for_rule_use(self):
        """Lock the catalog and reject retired/draft versions before rule use."""
        self.ensure_one()
        self.flush_recordset(["state"])
        self.env.cr.execute(
            "SELECT state FROM boss_forge_institution_catalog "
            "WHERE id = %s FOR SHARE",
            [self.id],
        )
        row = self.env.cr.fetchone()
        self.invalidate_recordset(["state"])
        if not row or row[0] != "published":
            raise ValidationError(
                _("Only a currently published institution catalog may be used by rules.")
            )
        return self

    def action_publish(self):
        for record in self:
            if record.state != "draft":
                raise UserError(_("Only a draft institution catalog can be published."))
            if not record.institution_ids:
                raise ValidationError(_("A catalog must contain at least one reviewed institution before publishing."))
            published_at = fields.Datetime.now()
            draft = record._catalog_draft(
                published_at=published_at,
                reviewed_by=self.env.user,
                status="published",
            )
            content_hash = record._calculate_content_hash(draft)
            record.write(
                {
                    "state": "published",
                    "content_hash": content_hash,
                    "published_by": self.env.user.id,
                    "published_at": published_at,
                }
            )

    def action_retire(self):
        self.filtered(lambda record: record.state == "published").write({"state": "retired"})

    def write(self, values):
        for record in self:
            if record.state in ("published", "retired"):
                if set(values) != {"state"} or values.get("state") != "retired" or record.state != "published":
                    raise UserError(_("Published institution catalogs are immutable."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.state != "draft" for record in self):
            raise UserError(_("Published institution catalogs cannot be deleted."))


class BossForgeInstitution(models.Model):
    _name = "boss.forge.institution"
    _description = "Boss-Forge Institution"
    _order = "name"

    catalog_id = fields.Many2one("boss.forge.institution.catalog", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="catalog_id.company_id", store=True, index=True)
    name = fields.Char(required=True, index=True)
    code = fields.Char(required=True, index=True)
    country_id = fields.Many2one("res.country")
    entity_kind = fields.Selection(
        [
            ("main", "Main institution"),
            ("college", "College"),
            ("campus", "Campus / branch"),
            ("independent_college", "Independent college"),
            ("joint_program", "Joint programme"),
            ("research_institute", "Research institute"),
            ("other", "Other"),
        ],
        required=True,
        default="main",
    )
    parent_id = fields.Many2one("boss.forge.institution", ondelete="restrict")
    category_ids = fields.Many2many(
        "boss.forge.institution.category",
        "boss_forge_institution_category_rel",
        "institution_id",
        "category_id",
        string="Reviewed categories",
    )
    alias_ids = fields.One2many("boss.forge.institution.alias", "institution_id")
    discipline_names = fields.Text(help="Required when only named disciplines are double-first-class.")
    valid_from = fields.Date()
    valid_to = fields.Date()
    notes = fields.Text()
    active = fields.Boolean(default=True)

    _institution_code_unique = models.Constraint(
        "UNIQUE(catalog_id, code)", "Institution code must be unique inside a catalog."
    )

    @api.constrains("parent_id", "catalog_id")
    def _check_parent_catalog(self):
        for record in self:
            if record.parent_id and record.parent_id.catalog_id != record.catalog_id:
                raise ValidationError(_("Parent and child institutions must belong to the same catalog version."))

    @api.constrains("entity_kind", "parent_id")
    def _check_non_main_parent(self):
        for record in self:
            if record.entity_kind in (
                "campus",
                "independent_college",
                "joint_program",
                "research_institute",
            ) and not record.parent_id:
                raise ValidationError(_("A branch, college, programme, or institute must name its parent record."))

    def _rule_engine_snapshot(self):
        self.ensure_one()
        if not self.active:
            raise ValidationError(
                _("Institution %s is inactive and cannot be published.")
                % self.display_name
            )
        if not self.country_id or not self.country_id.code:
            raise ValidationError(
                _("Institution %s requires an ISO country/region.")
                % self.display_name
            )
        kind = INSTITUTION_KIND_MAP.get(self.entity_kind)
        if not kind:
            raise ValidationError(
                _("Institution kind %s cannot be mapped to the rule engine.")
                % self.entity_kind
            )
        categories = sorted(self.category_ids.mapped("code"))
        unknown = set(categories) - CATALOG_CATEGORY_CODES
        if unknown:
            raise ValidationError(
                _("Institution %s uses unsupported categories: %s")
                % (self.display_name, ", ".join(sorted(unknown)))
            )
        aliases = [
            alias._rule_engine_snapshot()
            for alias in self.alias_ids.sorted(
                lambda item: f"{self.code}:alias:{item.id}"
            )
        ]
        normalized_names = {normalize_institution_name(self.name)}
        for alias in self.alias_ids:
            if alias.normalized_name in normalized_names:
                raise ValidationError(
                    _("Institution %s has a duplicate name or alias.")
                    % self.display_name
                )
            normalized_names.add(alias.normalized_name)
        snapshot = {
            "id": self.code.strip(),
            "standardName": self.name.strip(),
            "countryOrRegion": self.country_id.code.upper(),
            "kind": kind,
            "categories": categories,
            "aliases": aliases,
        }
        disciplines = sorted(
            {
                item.strip()
                for item in re.split(
                    r"[\n,，;；]+", self.discipline_names or ""
                )
                if item.strip()
            }
        )
        if "double_first_class_discipline" in categories and not disciplines:
            raise ValidationError(
                _("Institution %s requires reviewed disciplines.")
                % self.display_name
            )
        if disciplines:
            snapshot["doubleFirstClassDisciplines"] = disciplines
        if self.valid_from:
            snapshot["validFrom"] = fields.Date.to_string(self.valid_from)
        if self.valid_to:
            snapshot["validTo"] = fields.Date.to_string(self.valid_to)
        return snapshot

    @api.model_create_multi
    def create(self, values_list):
        catalogs = self.env["boss.forge.institution.catalog"].browse(
            [values.get("catalog_id") for values in values_list if values.get("catalog_id")]
        )
        if any(catalog.state != "draft" for catalog in catalogs):
            raise UserError(_("Institutions may only be added to a draft catalog."))
        return super().create(values_list)

    def write(self, values):
        if any(record.catalog_id.state != "draft" for record in self):
            raise UserError(_("Institutions in a published catalog are immutable."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.catalog_id.state != "draft" for record in self):
            raise UserError(_("Institutions in a published catalog cannot be deleted."))


class BossForgeInstitutionAlias(models.Model):
    _name = "boss.forge.institution.alias"
    _description = "Boss-Forge Institution Alias"
    _order = "raw_name"

    institution_id = fields.Many2one("boss.forge.institution", required=True, ondelete="cascade", index=True)
    catalog_id = fields.Many2one(related="institution_id.catalog_id", store=True, index=True)
    raw_name = fields.Char(required=True, index=True)
    normalized_name = fields.Char(compute="_compute_normalized_name", store=True, index=True)
    alias_type = fields.Selection(
        [
            ("official", "Official name"),
            ("short", "Short name"),
            ("english", "English name"),
            ("former", "Former name"),
            ("ocr", "OCR correction"),
            ("campus", "Campus mapping"),
        ],
        required=True,
        default="short",
        help=(
            "Aliases default to abbreviation because the canonical official name "
            "belongs in the institution Name field. Select a more specific type "
            "when applicable."
        ),
    )
    valid_from = fields.Date()
    valid_to = fields.Date()
    active = fields.Boolean(default=True)

    _institution_alias_unique = models.Constraint(
        "UNIQUE(institution_id, normalized_name)",
        "This normalized alias already exists for the institution.",
    )

    @api.depends("raw_name")
    def _compute_normalized_name(self):
        for record in self:
            record.normalized_name = normalize_institution_name(record.raw_name)

    @api.constrains("normalized_name")
    def _check_normalized_name(self):
        if any(not record.normalized_name for record in self):
            raise ValidationError(_("An institution alias cannot normalize to an empty value."))

    def _rule_engine_snapshot(self):
        self.ensure_one()
        if not self.active:
            raise ValidationError(
                _("Alias %s is inactive and cannot be published.")
                % self.display_name
            )
        if self.valid_from or self.valid_to:
            raise ValidationError(
                _("Alias-level validity dates are not supported by the rule engine.")
            )
        kind = ALIAS_KIND_MAP.get(self.alias_type)
        if not kind:
            raise ValidationError(
                _("Alias type %s cannot be mapped to the rule engine.")
                % self.alias_type
            )
        return {
            "id": f"{self.institution_id.code}:alias:{self.id}",
            "value": self.raw_name.strip(),
            "kind": kind,
        }

    @api.model_create_multi
    def create(self, values_list):
        institutions = self.env["boss.forge.institution"].browse(
            [values.get("institution_id") for values in values_list if values.get("institution_id")]
        )
        if any(record.catalog_id.state != "draft" for record in institutions):
            raise UserError(_("Aliases may only be added to a draft catalog."))
        return super().create(values_list)

    def write(self, values):
        if any(record.catalog_id.state != "draft" for record in self):
            raise UserError(_("Aliases in a published catalog are immutable."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.catalog_id.state != "draft" for record in self):
            raise UserError(_("Aliases in a published catalog cannot be deleted."))

    @api.model
    def resolve(self, raw_name, catalog):
        """Return deterministic candidates; callers must treat multiple/no matches as unknown."""
        normalized = normalize_institution_name(raw_name)
        alias_matches = self.search(
            [("catalog_id", "=", catalog.id), ("normalized_name", "=", normalized), ("active", "=", True)]
        )
        standard_matches = self.env["boss.forge.institution"].search(
            [("catalog_id", "=", catalog.id), ("active", "=", True)]
        ).filtered(
            lambda institution: normalize_institution_name(institution.name)
            == normalized
        )
        institution_ids = sorted(
            set(alias_matches.mapped("institution_id").ids)
            | set(standard_matches.ids)
        )
        return {
            "status": "confirmed" if len(institution_ids) == 1 else "unknown",
            "institutionIds": institution_ids,
            "aliasIds": alias_matches.sorted("id").ids,
            "normalizedInput": normalized,
        }
