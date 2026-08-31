from odoo import models, _
from odoo.exceptions import AccessError


class HrJob(models.Model):
    _inherit = "hr.job"

    def write(self, values):
        if "bf_auto_contact_after_review" in values and not (
            self.env.is_superuser()
            or self.env.user.has_group("boss_forge_security.group_bf_contact_approver")
            or self.env.user.has_group("boss_forge_security.group_bf_team_lead")
            or self.env.user.has_group("hr_recruitment.group_hr_recruitment_manager")
        ):
            raise AccessError(_("Only a Contact Approver or HR Team Lead can change automatic contact."))
        return super().write(values)
