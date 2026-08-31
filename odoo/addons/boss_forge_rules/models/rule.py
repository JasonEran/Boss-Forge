import hashlib
import json
import math
import unicodedata
from copy import deepcopy

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError

from .institution import CATALOG_CATEGORY_CODES


MAX_RULE_DEPTH = 12
MAX_RULE_NODES = 100
MAX_RULE_VALUES = 50
MAX_FIELD_LENGTH = 100
MAX_VALUE_LENGTH = 500
UNKNOWN_POLICIES = {"manual_review", "fail", "ignore"}
EDUCATION_LEVELS = {"high_school", "associate", "bachelor", "master", "doctor"}
EDUCATION_STAGE_SELECTORS = {
    "associate", "bachelor", "master", "doctor", "other", "highest", "any", "all",
}
CONFIG_KEYS = {"schemaVersion", "name", "root", "institutionCatalog"}
CATALOG_KEYS = {
    "schemaVersion", "version", "status", "source", "importedBy", "reviewedBy",
    "publishedAt", "changeSummary", "institutions", "contentHash",
}
CATALOG_SOURCE_KEYS = {"name", "asOfDate", "url"}
INSTITUTION_KEYS = {
    "id", "standardName", "countryOrRegion", "kind", "categories", "aliases",
    "doubleFirstClassDisciplines", "validFrom", "validTo",
}
ALIAS_KEYS = {"id", "value", "kind", "confidence"}
MISSING = object()


def _rule_error(message):
    raise ValidationError(_("Invalid rule configuration: %s") % message)


def _exact_keys(value, allowed, path):
    unknown = sorted(set(value) - allowed)
    if unknown:
        _rule_error(
            _("%(path)s contains unsupported field(s): %(fields)s.")
            % {"path": path, "fields": ", ".join(unknown)}
        )


def _non_empty_string(value, path, maximum=MAX_VALUE_LENGTH):
    if not isinstance(value, str) or not value.strip():
        _rule_error(_("%s must be a non-empty string.") % path)
    parsed = value.strip()
    if len(parsed) > maximum:
        _rule_error(_("%(path)s must not exceed %(maximum)s characters.") % {
            "path": path,
            "maximum": maximum,
        })
    return parsed


def _confidence(value, path, optional=False):
    if optional and value is MISSING:
        return
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        or value > 1
    ):
        _rule_error(_("%s must be between 0 and 1.") % path)


def _unknown_policy(value, path, optional=False):
    if optional and value is MISSING:
        return
    if value not in UNKNOWN_POLICIES:
        _rule_error(_("%s must be manual_review, fail, or ignore.") % path)


def _values(value, path):
    if not isinstance(value, list) or not value:
        _rule_error(_("%s must be a non-empty array.") % path)
    if len(value) > MAX_RULE_VALUES:
        _rule_error(_("%(path)s must not contain more than %(maximum)s values.") % {
            "path": path,
            "maximum": MAX_RULE_VALUES,
        })
    parsed = [
        _non_empty_string(item, f"{path}[{index}]")
        for index, item in enumerate(value)
    ]
    normalized = [unicodedata.normalize("NFKC", item).casefold() for item in parsed]
    if len(set(normalized)) != len(normalized):
        _rule_error(_("%s contains duplicate normalized values.") % path)


def _number_boundary(value, path):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
        or value > 100
    ):
        _rule_error(_("%s must be a finite number between 0 and 100.") % path)


def _validate_catalog_shape(value):
    path = "config.institutionCatalog"
    if not isinstance(value, dict):
        _rule_error(_("%s must be an object.") % path)
    _exact_keys(value, CATALOG_KEYS, path)
    required = CATALOG_KEYS - {"contentHash"}
    missing = sorted(required - set(value))
    if missing:
        _rule_error(_("%(path)s is missing field(s): %(fields)s.") % {
            "path": path,
            "fields": ", ".join(missing),
        })
    if value.get("schemaVersion") != "1.0":
        _rule_error(_("%s.schemaVersion must be 1.0.") % path)
    _non_empty_string(value.get("version"), f"{path}.version")
    if value.get("status") != "published":
        _rule_error(_("%s must be published.") % path)
    source = value.get("source")
    if not isinstance(source, dict):
        _rule_error(_("%s.source must be an object.") % path)
    _exact_keys(source, CATALOG_SOURCE_KEYS, f"{path}.source")
    institutions = value.get("institutions")
    if not isinstance(institutions, list):
        _rule_error(_("%s.institutions must be an array.") % path)
    for institution_index, institution in enumerate(institutions):
        institution_path = f"{path}.institutions[{institution_index}]"
        if not isinstance(institution, dict):
            _rule_error(_("%s must be an object.") % institution_path)
        _exact_keys(institution, INSTITUTION_KEYS, institution_path)
        aliases = institution.get("aliases")
        if not isinstance(aliases, list):
            _rule_error(_("%s.aliases must be an array.") % institution_path)
        for alias_index, alias in enumerate(aliases):
            alias_path = f"{institution_path}.aliases[{alias_index}]"
            if not isinstance(alias, dict):
                _rule_error(_("%s must be an object.") % alias_path)
            _exact_keys(alias, ALIAS_KEYS, alias_path)
    content_hash = value.get("contentHash")
    if not isinstance(content_hash, str) or not content_hash.startswith("sha256:"):
        _rule_error(_("%s.contentHash must be a sha256 digest.") % path)


def _validate_rule_node(value, path, depth, context):
    if depth > MAX_RULE_DEPTH:
        _rule_error(_("Rule depth exceeds %s.") % MAX_RULE_DEPTH)
    context["node_count"] += 1
    if context["node_count"] > MAX_RULE_NODES:
        _rule_error(_("Rule contains more than %s nodes.") % MAX_RULE_NODES)
    if not isinstance(value, dict):
        _rule_error(_("%s must be an object.") % path)

    if value.get("operator") in {"AND", "OR", "NOT"}:
        _exact_keys(value, {"operator", "children"}, path)
        children = value.get("children")
        if not isinstance(children, list) or not children:
            _rule_error(_("%s.children must not be empty.") % path)
        if value["operator"] == "NOT" and len(children) != 1:
            _rule_error(_("%s.children must contain exactly one node for NOT.") % path)
        for index, child in enumerate(children):
            _validate_rule_node(child, f"{path}.children[{index}]", depth + 1, context)
        return "group"

    if value.get("type") in {"all", "any"}:
        _exact_keys(value, {"type", "children"}, path)
        children = value.get("children")
        if not isinstance(children, list) or not children:
            _rule_error(_("%s.children must not be empty.") % path)
        for index, child in enumerate(children):
            _validate_rule_node(child, f"{path}.children[{index}]", depth + 1, context)
        return "group"

    node_type = value.get("type")
    if node_type == "tem8":
        _exact_keys(value, {"type", "minimumConfidence", "unknownPolicy"}, path)
        _confidence(value.get("minimumConfidence"), f"{path}.minimumConfidence")
        _unknown_policy(
            value.get("unknownPolicy", MISSING),
            f"{path}.unknownPolicy",
            optional=True,
        )
    elif node_type == "capability":
        _exact_keys(
            value,
            {"type", "capability", "match", "minimumConfidence", "unknownPolicy"},
            path,
        )
        if value.get("capability") != "tem8" or value.get("match") != "confirmed":
            _rule_error(_("%s supports only the confirmed tem8 capability.") % path)
        _confidence(
            value.get("minimumConfidence", MISSING),
            f"{path}.minimumConfidence",
            optional=True,
        )
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "range":
        _exact_keys(value, {"type", "field", "minimum", "maximum", "unknownPolicy"}, path)
        if value.get("field") != "yearsOfExperience":
            _rule_error(_("%s.field supports only yearsOfExperience in schema 1.0.") % path)
        if "minimum" not in value and "maximum" not in value:
            _rule_error(_("%s requires minimum, maximum, or both.") % path)
        if "minimum" in value:
            _number_boundary(value["minimum"], f"{path}.minimum")
        if "maximum" in value:
            _number_boundary(value["maximum"], f"{path}.maximum")
        if (
            "minimum" in value
            and "maximum" in value
            and value["minimum"] > value["maximum"]
        ):
            _rule_error(_("%s.minimum must not exceed maximum.") % path)
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "keyword":
        _exact_keys(value, {"type", "field", "values", "mode", "unknownPolicy"}, path)
        _non_empty_string(value.get("field"), f"{path}.field", MAX_FIELD_LENGTH)
        _values(value.get("values"), f"{path}.values")
        if value.get("mode") not in {"any", "all"}:
            _rule_error(_("%s.mode must be any or all.") % path)
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "enum":
        _exact_keys(
            value,
            {"type", "field", "values", "mode", "match", "unknownPolicy"},
            path,
        )
        _non_empty_string(value.get("field"), f"{path}.field", MAX_FIELD_LENGTH)
        _values(value.get("values"), f"{path}.values")
        if value.get("mode") not in {"any", "all"}:
            _rule_error(_("%s.mode must be any or all.") % path)
        if value.get("match") not in {"exact", "contains"}:
            _rule_error(_("%s.match must be exact or contains.") % path)
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "text":
        _exact_keys(value, {"type", "field", "value", "match", "unknownPolicy"}, path)
        _non_empty_string(value.get("field"), f"{path}.field", MAX_FIELD_LENGTH)
        _non_empty_string(value.get("value"), f"{path}.value")
        if value.get("match") not in {"exact", "contains"}:
            _rule_error(_("%s.match must be exact or contains.") % path)
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "education_level":
        _exact_keys(value, {"type", "minimum", "unknownPolicy"}, path)
        if value.get("minimum") not in EDUCATION_LEVELS:
            _rule_error(
                _("%s.minimum must be high_school, associate, bachelor, master, or doctor.")
                % path
            )
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
    elif node_type == "institution_category":
        _exact_keys(
            value,
            {
                "type", "educationStage", "categories", "mode", "required",
                "catalogVersion", "unknownPolicy",
            },
            path,
        )
        if value.get("educationStage") not in EDUCATION_STAGE_SELECTORS:
            _rule_error(_("%s.educationStage is invalid.") % path)
        categories = value.get("categories")
        if not isinstance(categories, list) or not categories:
            _rule_error(_("%s.categories must contain at least one category.") % path)
        unknown_categories = [
            str(category) for category in categories
            if not isinstance(category, str) or category not in CATALOG_CATEGORY_CODES
        ]
        if unknown_categories:
            _rule_error(_("%(path)s contains unknown institution categories: %(categories)s.") % {
                "path": path,
                "categories": ", ".join(unknown_categories),
            })
        if len(set(categories)) != len(categories):
            _rule_error(_("%s.categories contains duplicates.") % path)
        if value.get("mode") not in {"any", "all"}:
            _rule_error(_("%s.mode must be any or all.") % path)
        if not isinstance(value.get("required"), bool):
            _rule_error(_("%s.required must be boolean.") % path)
        _non_empty_string(value.get("catalogVersion"), f"{path}.catalogVersion")
        _unknown_policy(value.get("unknownPolicy"), f"{path}.unknownPolicy")
        context["institution_versions"].append(value["catalogVersion"].strip())
    else:
        _rule_error(_("%s is an unsupported rule node.") % path)
    return "leaf"


def _validate_execution_rule_config(config):
    if not isinstance(config, dict):
        _rule_error(_("config must be an object."))
    _exact_keys(config, CONFIG_KEYS, "config")
    if config.get("schemaVersion") != "1.0":
        _rule_error(_("config.schemaVersion must be 1.0."))
    if "name" in config:
        _non_empty_string(config.get("name"), "config.name")
    context = {"node_count": 0, "institution_versions": []}
    root_kind = _validate_rule_node(config.get("root"), "config.root", 0, context)
    if root_kind != "group":
        _rule_error(_("config.root must be an AND/OR/NOT or all/any group node."))
    catalog = config.get("institutionCatalog")
    if context["institution_versions"] and catalog is None:
        _rule_error(_("config.institutionCatalog is required for institution rules."))
    if catalog is not None:
        _validate_catalog_shape(catalog)
        catalog_version = catalog.get("version")
        if any(
            version != catalog_version
            for version in context["institution_versions"]
        ):
            _rule_error(
                _("Institution rule catalogVersion must match the embedded catalog snapshot.")
            )


def _institution_nodes(value):
    if isinstance(value, dict):
        if value.get("type") == "institution_category":
            yield value
        for child in value.values():
            yield from _institution_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _institution_nodes(child)


class BossForgeRuleTemplate(models.Model):
    _name = "boss.forge.rule.template"
    _description = "Boss-Forge Rule Template"
    _order = "name"

    name = fields.Char(required=True, translate=True)
    company_id = fields.Many2one("res.company", required=True, default=lambda self: self.env.company)
    department_id = fields.Many2one("hr.department")
    owner_id = fields.Many2one("res.users", default=lambda self: self.env.user)
    scope = fields.Selection(
        [("company", "Company"), ("department", "Department"), ("personal", "Personal")],
        required=True,
        default="department",
    )
    config_json = fields.Json(required=True, default=lambda self: {"schemaVersion": "1.0", "root": {}})
    active = fields.Boolean(default=True)


class BossForgeRuleSet(models.Model):
    _name = "boss.forge.rule.set"
    _description = "Boss-Forge Job Rule Set"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "job_id, name"

    name = fields.Char(required=True, tracking=True)
    job_id = fields.Many2one("hr.job", required=True, ondelete="cascade", index=True, tracking=True)
    company_id = fields.Many2one(related="job_id.company_id", store=True, index=True)
    owner_id = fields.Many2one("res.users", required=True, default=lambda self: self.env.user, tracking=True)
    version_ids = fields.One2many("boss.forge.rule.version", "rule_set_id")
    current_version_id = fields.Many2one(
        "boss.forge.rule.version", readonly=True, copy=False, domain="[('rule_set_id', '=', id), ('state', '=', 'published')]"
    )
    active = fields.Boolean(default=True)


class BossForgeRuleVersion(models.Model):
    _name = "boss.forge.rule.version"
    _description = "Boss-Forge Immutable Rule Version"
    _order = "rule_set_id, version_number desc"
    _rec_name = "display_name"

    rule_set_id = fields.Many2one("boss.forge.rule.set", required=True, ondelete="cascade", index=True)
    company_id = fields.Many2one(related="rule_set_id.company_id", store=True, index=True)
    version_number = fields.Integer(required=True, default=1)
    display_name = fields.Char(compute="_compute_display_name", store=True)
    state = fields.Selection(
        [("draft", "Draft"), ("testing", "Testing"), ("published", "Published"), ("retired", "Retired")],
        required=True,
        default="draft",
        index=True,
    )
    schema_version = fields.Char(required=True, default="1.0")
    dictionary_version = fields.Char(required=True, default="1.0")
    institution_catalog_id = fields.Many2one(
        "boss.forge.institution.catalog",
        ondelete="restrict",
        help=(
            "Optional company-reviewed catalog for custom institution classification rules. "
            "BOSS 985/211/Double First-Class platform-tag rules do not require it."
        ),
    )
    config_json = fields.Json(required=True, default=lambda self: {"schemaVersion": "1.0", "root": {}})
    config_hash = fields.Char(readonly=True, copy=False)
    created_by = fields.Many2one("res.users", readonly=True, default=lambda self: self.env.user)
    reviewed_by = fields.Many2one("res.users", readonly=True, copy=False)
    published_by = fields.Many2one("res.users", readonly=True, copy=False)
    published_at = fields.Datetime(readonly=True, copy=False)
    publish_notes = fields.Text()
    replay_statistics = fields.Json(readonly=True, copy=False)

    _rule_version_unique = models.Constraint(
        "UNIQUE(rule_set_id, version_number)", "Rule version number must be unique inside a rule set."
    )
    _rule_version_positive = models.Constraint("CHECK(version_number > 0)", "Rule version must be positive.")

    @api.depends("rule_set_id.name", "version_number")
    def _compute_display_name(self):
        for record in self:
            record.display_name = f"{record.rule_set_id.name or ''} v{record.version_number}"

    @api.constrains("config_json")
    def _validate_config_json(self):
        for record in self:
            config = record.config_json
            if not isinstance(config, dict):
                raise ValidationError(_("Rule configuration must be a JSON object."))
            if config.get("schemaVersion") != record.schema_version:
                raise ValidationError(_("Rule schemaVersion must match the version field."))
            if not isinstance(config.get("root"), dict):
                raise ValidationError(_("Rule configuration requires a root object."))

    def action_start_testing(self):
        self.filtered(lambda record: record.state == "draft").write({"state": "testing"})

    def action_use_boss_academic_tag_template(self):
        """Use explicit BOSS platform labels; never infer categories from school names."""
        for record in self:
            if record.state != "draft":
                raise UserError(_("Only draft rule versions can use a template."))
            record.write(
                {
                    "dictionary_version": "2026.08.3",
                    "institution_catalog_id": False,
                    "config_json": {
                        "schemaVersion": "1.0",
                        "name": "BOSS academic platform tags",
                        "root": {
                            "operator": "AND",
                            "children": [
                                {
                                    "type": "enum",
                                    "field": "bossPlatformTags",
                                    "values": ["985", "211", "双一流"],
                                    "mode": "any",
                                    "match": "exact",
                                    "unknownPolicy": "fail",
                                }
                            ],
                        },
                    },
                }
            )
        return True

    def execution_config(self):
        """Return the exact immutable configuration consumed by Boss-Forge."""
        self.ensure_one()
        config = deepcopy(self.config_json or {})
        leaves = list(_institution_nodes(config.get("root")))
        supplied_snapshot = "institutionCatalog" in config
        catalog = self.institution_catalog_id
        if catalog:
            catalog._assert_published_for_rule_use()
        if leaves or supplied_snapshot:
            if not catalog:
                raise ValidationError(
                    _("Institution rules require a selected institution catalog.")
                )
            snapshot = catalog.rule_engine_snapshot()
            mismatched = [
                leaf.get("catalogVersion")
                for leaf in leaves
                if leaf.get("catalogVersion") != snapshot["version"]
            ]
            if mismatched:
                raise ValidationError(
                    _(
                        "Every institution rule catalogVersion must match "
                        "the selected catalog version %s."
                    )
                    % snapshot["version"]
                )
            config["institutionCatalog"] = snapshot
        _validate_execution_rule_config(config)
        return config

    def action_publish(self):
        for record in self:
            if record.state not in ("draft", "testing"):
                raise UserError(_("Only draft or testing rule versions can be published."))
            if record.institution_catalog_id:
                record.institution_catalog_id._assert_published_for_rule_use()
            execution_config = record.execution_config()
            canonical = json.dumps(
                execution_config,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
            record.write(
                {
                    "state": "published",
                    "config_json": execution_config,
                    "config_hash": digest,
                    "reviewed_by": self.env.user.id,
                    "published_by": self.env.user.id,
                    "published_at": fields.Datetime.now(),
                }
            )
            record.rule_set_id.current_version_id = record

    def action_retire(self):
        self.filtered(lambda record: record.state == "published").write({"state": "retired"})

    def action_new_version(self):
        self.ensure_one()
        next_number = max(self.rule_set_id.version_ids.mapped("version_number") or [0]) + 1
        version = self.copy(
            {
                "version_number": next_number,
                "state": "draft",
                "config_hash": False,
                "reviewed_by": False,
                "published_by": False,
                "published_at": False,
                "replay_statistics": False,
            }
        )
        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": version.id,
            "view_mode": "form",
            "target": "current",
        }

    def write(self, values):
        for record in self:
            if record.state in ("published", "retired"):
                allowed_retirement = (
                    record.state == "published" and set(values) == {"state"} and values.get("state") == "retired"
                )
                if not allowed_retirement:
                    raise UserError(_("Published rule versions are immutable; create a new version."))
        return super().write(values)

    @api.ondelete(at_uninstall=False)
    def _unlink_draft_only(self):
        if any(record.state != "draft" for record in self):
            raise UserError(_("Only draft rule versions can be deleted."))


class HrJob(models.Model):
    _inherit = "hr.job"

    bf_rule_set_ids = fields.One2many("boss.forge.rule.set", "job_id", string="Boss-Forge Rule Sets")
    bf_rule_version_id = fields.Many2one(
        "boss.forge.rule.version",
        string="Published Rule Version",
        ondelete="restrict",
        domain="[('rule_set_id.job_id', '=', id), ('state', '=', 'published')]",
        tracking=True,
    )
