import json
import uuid

from odoo.exceptions import UserError, ValidationError
from odoo.tests.common import TransactionCase

from ..models.business import database_uuid


class TestBossForgeRecruitment(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.account = cls.env["boss.forge.boss.account"].create(
            {"name": "Account ***01", "external_id": "account-test-01", "state": "healthy"}
        )
        cls.job = cls.env["hr.job"].create(
            {
                "name": "Cross-border Operations",
                "company_id": cls.env.company.id,
                "user_id": cls.env.user.id,
                "bf_enabled": True,
                "bf_job_keyword": "Cross-border Operations",
                "bf_boss_account_id": cls.account.id,
                "bf_auto_contact_after_review": True,
            }
        )
        cls.rule_set = cls.env["boss.forge.rule.set"].create({"name": "Default", "job_id": cls.job.id})
        cls.rule_version = cls.env["boss.forge.rule.version"].create(
            {
                "rule_set_id": cls.rule_set.id,
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
        cls.rule_version.action_publish()
        cls.template = cls.env["boss.forge.message.template"].create(
            {
                "name": "Test Greeting",
                "template_code": "test_greeting",
                "version": 1,
                "body": "Hello {candidate_name}, this is about {job_name}.",
            }
        )
        cls.template.action_publish()
        cls.policy = cls.env["boss.forge.contact.policy"].create(
            {"name": "Test Policy", "policy_code": "test_policy", "version": 1}
        )
        cls.policy.action_publish()
        cls.job.write(
            {
                "bf_rule_version_id": cls.rule_version.id,
                "bf_message_template_id": cls.template.id,
                "bf_contact_policy_id": cls.policy.id,
            }
        )
        cls.env["ir.config_parameter"].sudo().set_param("boss_forge_connector.contact_transport_mode", "fake")
        cls.env["ir.config_parameter"].sudo().set_param("boss_forge_connector.real_contact_enabled", "False")

    def test_publish_job_and_request_screening_create_outbox_only(self):
        self.job.action_bf_publish_config()
        config_event = self.env["boss.forge.integration.outbox"].search(
            [("event_type", "=", "job.config.published.v1")], limit=1
        )
        self.assertTrue(config_event)
        self.assertIn("rule", config_event.payload)
        self.assertIn("contactPolicy", config_event.payload)
        self.assertIn("ownerId", config_event.payload)
        self.assertEqual(
            set(config_event.payload),
            {
                "odooDatabaseUuid", "odooCompanyId", "odooJobId", "name",
                "bossAccountId", "bossJobKeyword", "ownerId",
                "collaboratorIds", "active", "rule", "contactPolicy",
            },
        )
        self.assertEqual(
            set(config_event.payload["contactPolicy"]),
            {
                "policyVersionId", "autoContactAfterReview", "dailyLimit",
                "allowedStartMinute", "allowedEndMinute",
                "crossPositionCooldownHours", "authorizationTtlHours",
                "stopOnUncertain",
            },
        )
        self.assertEqual(
            config_event.payload["contactPolicy"]["allowedStartMinute"],
            540,
        )
        run = self.env["boss.forge.screening.run"].request_for_job(self.job)
        self.assertEqual(run.state, "queued")
        self.assertEqual(run.outbox_event_id.event_type, "screening.run.requested.v1")
        self.assertEqual(run.outbox_event_id.payload["requestId"], run.run_uuid)
        self.assertEqual(
            run.outbox_event_id.payload["execution"]["source"], "recommend"
        )

    def test_empty_job_keyword_is_contract_json_null_not_false(self):
        self.job.bf_job_keyword = False
        self.job.action_bf_publish_config()
        event = self.env["boss.forge.integration.outbox"].search(
            [("event_type", "=", "job.config.published.v1")],
            order="id desc",
            limit=1,
        )
        self.assertIsNone(event.payload["bossJobKeyword"])
        serialized = json.dumps(event._envelope(), sort_keys=True)
        self.assertIn('"bossJobKeyword": null', serialized)
        self.assertNotIn('"bossJobKeyword": false', serialized)

    def test_review_and_contact_is_atomic_fake_authorization(self):
        applicant = self.env["hr.applicant"].create(
            {
                "partner_name": "Candidate A",
                "job_id": self.job.id,
                "bf_state_id": str(uuid.uuid4()),
                "bf_external_candidate_id": "candidate-a",
            }
        )
        applicant.action_bf_review_and_contact()
        authorization = applicant.bf_contact_authorization_ids
        self.assertEqual(len(authorization), 1)
        self.assertEqual(authorization.transport_mode, "fake")
        self.assertEqual(applicant.bf_review_status, "passed")
        self.assertEqual(applicant.bf_contact_status, "queued")
        self.assertEqual(authorization.outbox_event_id.event_type, "candidate.contact.authorized.v1")
        self.assertIn("odooDatabaseUuid", authorization.outbox_event_id.payload)
        self.assertEqual(
            authorization.outbox_event_id.payload["contactPolicyVersionId"],
            authorization.policy_version_ref,
        )
        review_event = authorization.outbox_event_id.predecessor_event_id
        self.assertEqual(review_event.event_type, "candidate.review.completed.v1")
        self.assertEqual(review_event.aggregate_type, "candidate_state")
        self.assertEqual(review_event.aggregate_id, applicant.bf_state_id)
        self.assertEqual(review_event.aggregate_version, applicant.bf_review_version)
        self.assertEqual(
            set(review_event.payload),
            {
                "candidateStateId", "odooDatabaseUuid", "odooApplicantId",
                "odooJobId", "decision", "reviewerId", "reviewedAt",
                "reviewVersion",
            },
        )
        self.assertEqual(review_event.payload["decision"], "approved")
        with self.assertRaises(UserError):
            authorization.write({"rendered_message": "changed"})

    def test_all_terminal_reviews_emit_events_but_needs_review_does_not(self):
        without_contact = self.env["hr.applicant"].create(
            {
                "partner_name": "Approved without contact",
                "job_id": self.job.id,
                "bf_state_id": str(uuid.uuid4()),
            }
        )
        without_contact.action_bf_review_without_contact()
        approved = self.env["boss.forge.integration.outbox"].search(
            [
                ("event_type", "=", "candidate.review.completed.v1"),
                ("aggregate_id", "=", without_contact.bf_state_id),
            ],
            limit=1,
        )
        self.assertEqual(approved.payload["decision"], "approved")
        self.assertEqual(approved.aggregate_version, 1)

        rejected = self.env["hr.applicant"].create(
            {
                "partner_name": "Rejected candidate",
                "job_id": self.job.id,
                "bf_state_id": str(uuid.uuid4()),
                "bf_rejection_reason": "Does not meet the reviewed rule.",
            }
        )
        rejected.action_bf_reject()
        rejected_event = self.env["boss.forge.integration.outbox"].search(
            [
                ("event_type", "=", "candidate.review.completed.v1"),
                ("aggregate_id", "=", rejected.bf_state_id),
            ],
            limit=1,
        )
        self.assertEqual(rejected_event.payload["decision"], "rejected")

        needs_review = self.env["hr.applicant"].create(
            {
                "partner_name": "Needs another reviewer",
                "job_id": self.job.id,
                "bf_state_id": str(uuid.uuid4()),
            }
        )
        needs_review.action_bf_needs_review()
        self.assertFalse(
            self.env["boss.forge.integration.outbox"].search(
                [
                    ("event_type", "=", "candidate.review.completed.v1"),
                    ("aggregate_id", "=", needs_review.bf_state_id),
                ],
                limit=1,
            )
        )

    def test_job_switch_blocks_contact_authorization(self):
        applicant = self.env["hr.applicant"].create(
            {
                "partner_name": "Candidate B",
                "job_id": self.job.id,
                "bf_state_id": str(uuid.uuid4()),
            }
        )
        self.job.bf_auto_contact_after_review = False
        with self.assertRaises(ValidationError):
            applicant.action_bf_review_and_contact()

    def test_delivered_run_cancellation_round_trip_stays_cancelled(self):
        run = self.env["boss.forge.screening.run"].request_for_job(self.job)
        run.outbox_event_id.write({"state": "delivered"})
        run.action_cancel()
        cancel_event = run.cancel_outbox_event_id
        self.assertEqual(cancel_event.event_type, "screening.run.cancelled.v1")
        self.assertEqual(cancel_event.aggregate_id, run.run_uuid)
        self.assertEqual(
            set(cancel_event.payload),
            {
                "requestId", "odooDatabaseUuid", "odooJobId",
                "cancelledById", "cancelledAt",
            },
        )
        self.assertEqual(run.state, "cancel_requested")

        envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "screening.run.completed.v1",
            "aggregateType": "screening_run",
            "aggregateId": run.run_uuid,
            "aggregateVersion": 2,
            "occurredAt": "2026-08-31T08:00:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {
                "taskId": str(uuid.uuid4()),
                "screeningRunId": run.run_uuid,
                "odooDatabaseUuid": database_uuid(self.env),
                "odooJobId": self.job.id,
                "status": "cancelled",
                "collectedCount": 0,
                "matchedCount": 0,
                "failedCount": 0,
                "pendingReviewCount": 0,
            },
        }
        self.env["boss.forge.integration.inbox"].ingest(envelope)
        self.assertEqual(run.state, "cancelled")

        stale_started = {
            "eventId": str(uuid.uuid4()),
            "eventType": "screening.run.started.v1",
            "aggregateType": "screening_run",
            "aggregateId": run.run_uuid,
            "aggregateVersion": 1,
            "occurredAt": "2026-08-31T07:59:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {
                "taskId": str(uuid.uuid4()),
                "screeningRunId": run.run_uuid,
                "odooDatabaseUuid": database_uuid(self.env),
                "odooJobId": self.job.id,
                "workerId": "worker-1",
            },
        }
        stale_record, _duplicate = self.env[
            "boss.forge.integration.inbox"
        ].ingest(stale_started)
        self.assertEqual(run.state, "cancelled")
        self.assertTrue(stale_record.handler_result["ignored"])

    def test_failed_run_completion_is_terminal(self):
        run = self.env["boss.forge.screening.run"].request_for_job(self.job)
        envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "screening.run.completed.v1",
            "aggregateType": "screening_run",
            "aggregateId": run.run_uuid,
            "aggregateVersion": 2,
            "occurredAt": "2026-08-31T08:00:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {
                "taskId": str(uuid.uuid4()),
                "screeningRunId": run.run_uuid,
                "odooDatabaseUuid": database_uuid(self.env),
                "odooJobId": self.job.id,
                "status": "failed",
                "errorMessage": "collection failed",
                "collectedCount": 0,
                "matchedCount": 0,
                "failedCount": 0,
                "pendingReviewCount": 0,
            },
        }
        self.env["boss.forge.integration.inbox"].ingest(envelope)
        self.assertEqual(run.state, "failed")
        self.assertEqual(run.error_summary, "collection failed")

    def test_candidate_collected_external_mapping_is_idempotent_and_strict(self):
        run = self.env["boss.forge.screening.run"].request_for_job(self.job)

        def collected_envelope(state_id, external_candidate_id, version=1):
            return {
                "eventId": str(uuid.uuid4()),
                "eventType": "candidate.collected.v1",
                "aggregateType": "candidate_state",
                "aggregateId": state_id,
                "aggregateVersion": version,
                "occurredAt": "2026-08-31T08:00:00Z",
                "correlationId": str(uuid.uuid4()),
                "payload": {
                    "taskId": str(uuid.uuid4()),
                    "screeningRunId": run.run_uuid,
                    "odooDatabaseUuid": database_uuid(self.env),
                    "odooJobId": self.job.id,
                    "candidateStateId": state_id,
                    "externalCandidateId": external_candidate_id,
                    "identityKey": "identity-" + external_candidate_id,
                    "candidateName": "Mapped Candidate",
                    "source": "recommend",
                    "screeningStatus": "queued",
                    "fields": {"经验": "5年"},
                },
            }

        state_id = str(uuid.uuid4())
        first, duplicate = self.env["boss.forge.integration.inbox"].ingest(
            collected_envelope(state_id, "candidate-map-1")
        )
        self.assertFalse(duplicate)
        self.assertEqual(first.state, "completed")
        applicant = self.env["hr.applicant"].browse(
            first.handler_result["id"]
        )
        mapping = self.env["boss.forge.external.map"].search(
            [
                ("external_type", "=", "candidate_state"),
                ("external_id", "=", state_id),
            ]
        )
        self.assertEqual(len(mapping), 1)
        self.assertEqual(mapping.odoo_model, "hr.applicant")
        self.assertEqual(mapping.odoo_res_id, applicant.id)

        replay, duplicate = self.env["boss.forge.integration.inbox"].ingest(
            collected_envelope(state_id, "candidate-map-1")
        )
        self.assertFalse(duplicate)
        self.assertEqual(replay.state, "completed")
        self.assertEqual(
            self.env["boss.forge.external.map"].search_count(
                [
                    ("external_type", "=", "candidate_state"),
                    ("external_id", "=", state_id),
                ]
            ),
            1,
        )

        conflict_state_id = str(uuid.uuid4())
        mapped_elsewhere = self.env["hr.applicant"].create(
            {"partner_name": "Mapped Elsewhere", "job_id": self.job.id}
        )
        self.env["boss.forge.external.map"].ensure_mapping(
            mapped_elsewhere,
            external_type="candidate_state",
            external_id=conflict_state_id,
        )
        intended = self.env["hr.applicant"].create(
            {
                "partner_name": "Intended Applicant",
                "job_id": self.job.id,
                "bf_external_candidate_id": "candidate-map-conflict",
            }
        )
        failed, duplicate = self.env["boss.forge.integration.inbox"].ingest(
            collected_envelope(
                conflict_state_id,
                "candidate-map-conflict",
                version=2,
            )
        )
        self.assertFalse(duplicate)
        self.assertEqual(failed.state, "failed")
        self.assertIn("different Odoo record", failed.error_summary)
        intended.invalidate_recordset()
        self.assertFalse(intended.bf_state_id)

    def test_screened_event_keeps_exact_evidence_and_english_level(self):
        run = self.env["boss.forge.screening.run"].request_for_job(self.job)
        candidate_state_id = str(uuid.uuid4())
        applicant = self.env["hr.applicant"].create(
            {
                "partner_name": "Candidate Evidence",
                "job_id": self.job.id,
                "bf_state_id": candidate_state_id,
                "bf_screening_run_id": run.id,
            }
        )
        envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "candidate.screened.v1",
            "aggregateType": "candidate_state",
            "aggregateId": candidate_state_id,
            "aggregateVersion": 2,
            "occurredAt": "2026-08-31T08:00:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {
                "taskId": str(uuid.uuid4()),
                "screeningRunId": run.run_uuid,
                "odooDatabaseUuid": database_uuid(self.env),
                "odooJobId": self.job.id,
                "candidateStateId": candidate_state_id,
                "decision": "not_matched",
                "confidence": 0.98,
                "reviewStatus": "pending",
                "currentEnglishLevel": "TEM-4（英语专业四级）",
                "reasonCodes": ["no_evidence"],
                "evidence": [
                    {
                        "sourceText": "英语专业四级",
                        "normalizedAlias": "TEM-4",
                        "status": "negative",
                        "confidence": 0.98,
                        "reasonCodes": ["no_evidence"],
                        "capabilityId": "language.english.tem8",
                        "canonicalLabel": "TEM-8（英语专业八级）",
                        "dictionaryVersion": "tem8-1.0",
                    }
                ],
            },
        }
        self.env["boss.forge.integration.inbox"].ingest(envelope)
        self.assertEqual(applicant.bf_rule_decision, "not_matched")
        self.assertEqual(
            applicant.bf_current_english_level,
            "TEM-4（英语专业四级）",
        )
        self.assertEqual(applicant.bf_reason_codes, ["no_evidence"])
        self.assertEqual(applicant.bf_evidence_ids.evidence_text, "英语专业四级")
        self.assertEqual(applicant.bf_evidence_ids.normalized_label, "TEM-4")
        self.assertEqual(applicant.bf_evidence_ids.decision, "not_matched")

    def test_fake_contact_callback_is_simulated_not_sent(self):
        candidate_state_id = str(uuid.uuid4())
        applicant = self.env["hr.applicant"].create(
            {
                "partner_name": "Candidate Simulation",
                "job_id": self.job.id,
                "bf_state_id": candidate_state_id,
            }
        )
        applicant.action_bf_review_and_contact()
        authorization = applicant.bf_contact_authorization_ids
        contact_intent_id = str(uuid.uuid4())
        envelope = {
            "eventId": str(uuid.uuid4()),
            "eventType": "contact.simulated.v1",
            "aggregateType": "contact_intent",
            "aggregateId": contact_intent_id,
            "aggregateVersion": 2,
            "occurredAt": "2026-08-31T08:00:00Z",
            "correlationId": str(uuid.uuid4()),
            "payload": {
                "contactIntentId": contact_intent_id,
                "authorizationId": authorization.authorization_uuid,
                "candidateStateId": candidate_state_id,
                "odooDatabaseUuid": database_uuid(self.env),
                "odooApplicantId": applicant.id,
                "odooJobId": self.job.id,
                "bossAccountId": self.account.external_id,
                "contactPolicyVersionId": authorization.policy_version_ref,
                "transportMode": "fake",
                "status": "simulated",
                "attemptNo": 1,
                "externalMessage": None,
                "errorMessage": None,
            },
        }
        self.env["boss.forge.integration.inbox"].ingest(envelope)
        self.assertEqual(applicant.bf_contact_status, "simulated")
        self.assertFalse(applicant.bf_last_contact_at)
        self.assertEqual(authorization.state, "simulated")

    def test_contact_callback_rejects_every_mismatched_route(self):
        candidate_state_id = str(uuid.uuid4())
        applicant = self.env["hr.applicant"].create(
            {
                "partner_name": "Candidate Route Guard",
                "job_id": self.job.id,
                "bf_state_id": candidate_state_id,
            }
        )
        applicant.action_bf_review_and_contact()
        authorization = applicant.bf_contact_authorization_ids
        base_payload = {
            "authorizationId": authorization.authorization_uuid,
            "candidateStateId": candidate_state_id,
            "odooDatabaseUuid": database_uuid(self.env),
            "odooApplicantId": applicant.id,
            "odooJobId": self.job.id,
            "bossAccountId": self.account.external_id,
            "contactPolicyVersionId": authorization.policy_version_ref,
            "transportMode": "fake",
            "status": "simulated",
            "attemptNo": 1,
            "externalMessage": None,
            "errorMessage": None,
        }
        mismatches = {
            "authorizationId": str(uuid.uuid4()),
            "candidateStateId": str(uuid.uuid4()),
            "odooDatabaseUuid": str(uuid.uuid4()),
            "odooApplicantId": applicant.id + 100000,
            "odooJobId": self.job.id + 100000,
            "bossAccountId": "wrong-account",
            "contactPolicyVersionId": "wrong-policy",
            "transportMode": "real",
        }
        for field_name, wrong_value in mismatches.items():
            with self.subTest(field_name=field_name):
                contact_intent_id = str(uuid.uuid4())
                payload = {
                    **base_payload,
                    "contactIntentId": contact_intent_id,
                    field_name: wrong_value,
                }
                envelope = {
                    "eventId": str(uuid.uuid4()),
                    "eventType": "contact.simulated.v1",
                    "aggregateType": "contact_intent",
                    "aggregateId": contact_intent_id,
                    "aggregateVersion": 1,
                    "occurredAt": "2026-08-31T08:00:00Z",
                    "correlationId": str(uuid.uuid4()),
                    "payload": payload,
                }
                record, duplicate = self.env[
                    "boss.forge.integration.inbox"
                ].ingest(envelope)
                self.assertFalse(duplicate)
                self.assertEqual(record.state, "failed")
                applicant.invalidate_recordset(["bf_contact_status"])
                authorization.invalidate_recordset(["state"])
                self.assertEqual(applicant.bf_contact_status, "queued")
                self.assertEqual(authorization.state, "queued")

        missing_intent = str(uuid.uuid4())
        missing_payload = {
            **base_payload,
            "contactIntentId": missing_intent,
        }
        missing_payload.pop("contactPolicyVersionId")
        missing, _duplicate = self.env["boss.forge.integration.inbox"].ingest(
            {
                "eventId": str(uuid.uuid4()),
                "eventType": "contact.simulated.v1",
                "aggregateType": "contact_intent",
                "aggregateId": missing_intent,
                "aggregateVersion": 1,
                "occurredAt": "2026-08-31T08:00:00Z",
                "correlationId": str(uuid.uuid4()),
                "payload": missing_payload,
            }
        )
        self.assertEqual(missing.state, "failed")
        self.assertIn("contactPolicyVersionId", missing.error_summary)
