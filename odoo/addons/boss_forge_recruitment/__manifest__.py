{
    "name": "Boss Forge Recruitment",
    "summary": "Odoo recruitment control plane for Boss-Forge",
    "version": "19.0.1.0.0",
    "category": "Human Resources/Recruitment",
    "license": "LGPL-3",
    "author": "Boss-Forge",
    "depends": [
        "hr_recruitment",
        "boss_forge_rules",
        "boss_forge_connector",
    ],
    "data": [
        "security/ir.model.access.csv",
        "data/recruitment_seed_data.xml",
        "data/ir_cron.xml",
        "views/hr_job_views.xml",
        "views/hr_applicant_views.xml",
        "views/operations_core_views.xml",
        "views/operations_contact_views.xml",
    ],
    "application": True,
    "installable": True,
}
