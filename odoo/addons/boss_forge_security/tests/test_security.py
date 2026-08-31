from odoo.exceptions import AccessError
from odoo.tests.common import TransactionCase


class TestBossForgeSecurity(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        recruiter_group = cls.env.ref("boss_forge_security.group_bf_recruiter")
        lead_group = cls.env.ref("boss_forge_security.group_bf_team_lead")
        cls.recruiter_a = cls.env["res.users"].create(
            {
                "name": "Recruiter A",
                "login": "bf-recruiter-a",
                "email": "bf-a@example.internal",
                "group_ids": [(6, 0, recruiter_group.ids)],
            }
        )
        cls.recruiter_b = cls.env["res.users"].create(
            {
                "name": "Recruiter B",
                "login": "bf-recruiter-b",
                "email": "bf-b@example.internal",
                "group_ids": [(6, 0, recruiter_group.ids)],
            }
        )
        cls.team_lead = cls.env["res.users"].create(
            {
                "name": "Recruitment Lead",
                "login": "bf-team-lead",
                "email": "bf-lead@example.internal",
                "group_ids": [(6, 0, lead_group.ids)],
            }
        )
        cls.job_a = cls.env["hr.job"].create(
            {"name": "Job A", "company_id": cls.env.company.id, "user_id": cls.recruiter_a.id}
        )
        cls.job_b = cls.env["hr.job"].create(
            {"name": "Job B", "company_id": cls.env.company.id, "user_id": cls.recruiter_b.id}
        )
        cls.applicant_a = cls.env["hr.applicant"].create(
            {"partner_name": "Applicant A", "job_id": cls.job_a.id}
        )
        cls.applicant_b = cls.env["hr.applicant"].create(
            {"partner_name": "Applicant B", "job_id": cls.job_b.id}
        )

    def test_recruiter_only_sees_assigned_job(self):
        jobs = self.env["hr.job"].with_user(self.recruiter_a).search(
            [("id", "in", (self.job_a.id, self.job_b.id))]
        )
        applicants = self.env["hr.applicant"].with_user(self.recruiter_a).search(
            [("id", "in", (self.applicant_a.id, self.applicant_b.id))]
        )
        self.assertEqual(jobs, self.job_a)
        self.assertEqual(applicants, self.applicant_a)

    def test_team_lead_sees_company_jobs(self):
        jobs = self.env["hr.job"].with_user(self.team_lead).search(
            [("id", "in", (self.job_a.id, self.job_b.id))]
        )
        self.assertEqual(set(jobs.ids), {self.job_a.id, self.job_b.id})

    def test_recruiter_cannot_enable_auto_contact(self):
        with self.assertRaises(AccessError):
            self.job_a.with_user(self.recruiter_a).write({"bf_auto_contact_after_review": True})
        self.job_a.with_user(self.team_lead).write({"bf_auto_contact_after_review": True})
        self.assertTrue(self.job_a.bf_auto_contact_after_review)
