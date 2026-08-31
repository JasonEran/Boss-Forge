import hashlib
import json

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase


class TestBossForgeRules(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.job = cls.env["hr.job"].create({"name": "Rule Test Job"})
        cls.rule_set = cls.env["boss.forge.rule.set"].create({"name": "Default", "job_id": cls.job.id})

    def test_published_rule_is_immutable(self):
        version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "config_json": {
                    "schemaVersion": "1.0",
                    "root": {
                        "operator": "AND",
                        "children": [
                            {
                                "type": "tem8",
                                "minimumConfidence": 0.8,
                                "unknownPolicy": "manual_review",
                            }
                        ],
                    },
                },
            }
        )
        version.action_publish()
        self.assertTrue(version.config_hash)
        with self.assertRaises(UserError):
            version.write({"config_json": {"schemaVersion": "1.0", "root": {}}})

    def test_empty_root_is_rejected_on_publish(self):
        version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "config_json": {"schemaVersion": "1.0", "root": {}},
            }
        )
        with self.assertRaises(ValidationError):
            version.action_publish()

    def test_generic_composite_rule_publishes(self):
        version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "config_json": {
                    "schemaVersion": "1.0",
                    "name": "General recruiter rule",
                    "root": {
                        "operator": "AND",
                        "children": [
                            {
                                "type": "tem8",
                                "minimumConfidence": 0.8,
                                "unknownPolicy": "manual_review",
                            },
                            {
                                "type": "capability",
                                "capability": "tem8",
                                "match": "confirmed",
                                "minimumConfidence": 0.7,
                                "unknownPolicy": "fail",
                            },
                            {
                                "type": "range",
                                "field": "yearsOfExperience",
                                "minimum": 2,
                                "maximum": 8,
                                "unknownPolicy": "manual_review",
                            },
                            {
                                "type": "keyword",
                                "field": "skills",
                                "values": ["Python", "Odoo"],
                                "mode": "all",
                                "unknownPolicy": "manual_review",
                            },
                            {
                                "type": "enum",
                                "field": "city",
                                "values": ["Shanghai", "Suzhou"],
                                "mode": "any",
                                "match": "exact",
                                "unknownPolicy": "ignore",
                            },
                            {
                                "type": "text",
                                "field": "summary",
                                "value": "recruitment",
                                "match": "contains",
                                "unknownPolicy": "manual_review",
                            },
                            {
                                "type": "education_level",
                                "minimum": "bachelor",
                                "unknownPolicy": "fail",
                            },
                            {
                                "operator": "NOT",
                                "children": [
                                    {
                                        "type": "text",
                                        "field": "summary",
                                        "value": "intern only",
                                        "match": "contains",
                                        "unknownPolicy": "ignore",
                                    }
                                ],
                            },
                            {
                                "type": "any",
                                "children": [
                                    {
                                        "type": "keyword",
                                        "field": "skills",
                                        "values": ["PostgreSQL"],
                                        "mode": "any",
                                        "unknownPolicy": "manual_review",
                                    }
                                ],
                            },
                            {
                                "operator": "OR",
                                "children": [
                                    {
                                        "type": "all",
                                        "children": [
                                            {
                                                "type": "education_level",
                                                "minimum": "associate",
                                                "unknownPolicy": "manual_review",
                                            }
                                        ],
                                    }
                                ],
                            },
                        ],
                    },
                },
            }
        )
        version.action_publish()
        self.assertEqual(version.state, "published")
        self.assertTrue(version.config_hash)

    def test_unknown_fields_policy_and_invalid_not_are_rejected(self):
        invalid_roots = [
            {
                "operator": "AND",
                "children": [
                    {
                        "type": "tem8",
                        "minimumConfidence": 0.8,
                        "unexpected": True,
                    }
                ],
            },
            {
                "operator": "AND",
                "children": [
                    {
                        "type": "range",
                        "field": "yearsOfExperience",
                        "minimum": 1,
                        "unknownPolicy": "guess",
                    }
                ],
            },
            {
                "operator": "NOT",
                "children": [
                    {"type": "tem8", "minimumConfidence": 0.8},
                    {"type": "tem8", "minimumConfidence": 0.9},
                ],
            },
            {
                "operator": "AND",
                "children": [
                    {
                        "type": "tem8",
                        "minimumConfidence": 0.8,
                        "unknownPolicy": None,
                    }
                ],
            },
        ]
        for index, root in enumerate(invalid_roots, start=1):
            with self.subTest(index=index):
                version = self.env["boss.forge.rule.version"].create(
                    {
                        "rule_set_id": self.rule_set.id,
                        "version_number": 100 + index,
                        "config_json": {"schemaVersion": "1.0", "root": root},
                    }
                )
                with self.assertRaises(ValidationError):
                    version.action_publish()

    def test_institution_alias_resolution_is_deterministic(self):
        catalog = self.env["boss.forge.institution.catalog"].create(
            {"name": "Test", "version": "test-1", "source_name": "Approved fixture", "source_date": "2026-01-01"}
        )
        institution = self.env["boss.forge.institution"].create(
            {"catalog_id": catalog.id, "name": "Example University", "code": "example"}
        )
        alias = self.env["boss.forge.institution.alias"].create(
            {"institution_id": institution.id, "raw_name": "Example U", "alias_type": "short"}
        )
        standard_result = self.env["boss.forge.institution.alias"].resolve(
            "Example University", catalog
        )
        self.assertEqual(standard_result["status"], "confirmed")
        self.assertEqual(standard_result["institutionIds"], [institution.id])
        self.assertEqual(standard_result["aliasIds"], [])
        alias_result = self.env["boss.forge.institution.alias"].resolve(
            "Example U", catalog
        )
        self.assertEqual(alias_result["status"], "confirmed")
        self.assertEqual(alias_result["institutionIds"], [institution.id])
        self.assertEqual(alias_result["aliasIds"], [alias.id])

        other = self.env["boss.forge.institution"].create(
            {
                "catalog_id": catalog.id,
                "name": "Other University",
                "code": "other-example",
            }
        )
        self.env["boss.forge.institution.alias"].create(
            {
                "institution_id": other.id,
                "raw_name": "Example University",
                "alias_type": "english",
            }
        )
        ambiguous = self.env["boss.forge.institution.alias"].resolve(
            "Example University", catalog
        )
        self.assertEqual(ambiguous["status"], "unknown")
        self.assertEqual(
            ambiguous["institutionIds"], sorted([institution.id, other.id])
        )

    def test_institution_alias_defaults_to_abbreviation_not_official(self):
        catalog = self.env["boss.forge.institution.catalog"].create(
            {
                "name": "Alias Default Test",
                "version": "alias-default-1",
                "source_name": "Approved fixture",
                "source_date": "2026-01-01",
            }
        )
        institution = self.env["boss.forge.institution"].create(
            {
                "catalog_id": catalog.id,
                "name": "Example University",
                "code": "alias-default-example",
            }
        )
        alias = self.env["boss.forge.institution.alias"].create(
            {"institution_id": institution.id, "raw_name": "Example U"}
        )
        self.assertEqual(alias.alias_type, "short")
        self.assertEqual(alias._rule_engine_snapshot()["kind"], "abbreviation")

    def test_retired_catalog_is_rejected_for_publish_and_execution(self):
        catalog = self.env["boss.forge.institution.catalog"].create(
            {
                "name": "Retirement Safety Test",
                "version": "retired-safety-1",
                "source_name": "Approved fixture",
                "source_date": "2026-01-01",
                "change_summary": "Fixture for retired catalog checks.",
            }
        )
        self.env["boss.forge.institution"].create(
            {
                "catalog_id": catalog.id,
                "name": "Retirement Test University",
                "code": "retirement-test-university",
                "country_id": self.env.ref("base.cn").id,
            }
        )
        catalog.action_publish()
        published_version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "version_number": 20,
                "institution_catalog_id": catalog.id,
                "config_json": {
                    "schemaVersion": "1.0",
                    "root": {
                        "operator": "AND",
                        "children": [
                            {
                                "type": "institution_category",
                                "educationStage": "bachelor",
                                "categories": ["other_domestic"],
                                "mode": "any",
                                "required": True,
                                "catalogVersion": catalog.version,
                                "unknownPolicy": "manual_review",
                            }
                        ],
                    },
                },
            }
        )
        published_version.action_publish()
        catalog.action_retire()

        with self.assertRaises(ValidationError):
            published_version.execution_config()

        new_version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "version_number": 21,
                "institution_catalog_id": catalog.id,
                "config_json": {
                    "schemaVersion": "1.0",
                    "root": {
                        "operator": "AND",
                        "children": [
                            {
                                "type": "institution_category",
                                "educationStage": "bachelor",
                                "categories": ["other_domestic"],
                                "mode": "any",
                                "required": True,
                                "catalogVersion": catalog.version,
                                "unknownPolicy": "manual_review",
                            }
                        ],
                    },
                },
            }
        )
        with self.assertRaises(ValidationError):
            new_version.action_publish()

    def test_published_catalog_snapshot_is_embedded_in_institution_rule(self):
        catalog = self.env["boss.forge.institution.catalog"].create(
            {
                "name": "Reviewed 985 Fixture",
                "version": "cn-reviewed-2026.01",
                "source_name": "Approved internal fixture",
                "source_date": "2026-01-01",
                "change_summary": "Initial reviewed test catalog.",
            }
        )
        institution = self.env["boss.forge.institution"].create(
            {
                "catalog_id": catalog.id,
                "name": "北京大学",
                "code": "inst-peking",
                "country_id": self.env.ref("base.cn").id,
                "category_ids": [
                    (
                        6,
                        0,
                        [
                            self.env.ref(
                                "boss_forge_rules.institution_category_985"
                            ).id
                        ],
                    )
                ],
            }
        )
        self.env["boss.forge.institution.alias"].create(
            {
                "institution_id": institution.id,
                "raw_name": "北大",
                "alias_type": "short",
            }
        )
        catalog.action_publish()
        snapshot = catalog.rule_engine_snapshot()
        self.assertEqual(snapshot["schemaVersion"], "1.0")
        self.assertEqual(snapshot["status"], "published")
        self.assertEqual(snapshot["institutions"][0]["kind"], "university")
        self.assertEqual(
            snapshot["institutions"][0]["aliases"][0]["kind"],
            "abbreviation",
        )
        draft = {key: value for key, value in snapshot.items() if key != "contentHash"}
        canonical = json.dumps(
            draft,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        expected_hash = "sha256:" + hashlib.sha256(
            canonical.encode("utf-8")
        ).hexdigest()
        self.assertEqual(snapshot["contentHash"], expected_hash)

        version = self.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": self.rule_set.id,
                "version_number": 2,
                "institution_catalog_id": catalog.id,
                "config_json": {
                    "schemaVersion": "1.0",
                    "root": {
                        "operator": "AND",
                        "children": [
                            {
                                "type": "institution_category",
                                "educationStage": "bachelor",
                                "categories": ["project_985"],
                                "mode": "any",
                                "required": True,
                                "catalogVersion": catalog.version,
                                "unknownPolicy": "manual_review",
                            }
                        ],
                    },
                },
            }
        )
        version.action_publish()
        self.assertEqual(version.config_json["institutionCatalog"], snapshot)
