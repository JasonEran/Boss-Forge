{
    "name": "Boss Forge Connector",
    "summary": "Reliable intranet event bridge between Odoo and Boss-Forge",
    "version": "19.0.1.0.0",
    "category": "Human Resources/Recruitment",
    "license": "LGPL-3",
    "author": "Boss-Forge",
    "depends": ["base", "mail"],
    "data": [
        "security/ir.model.access.csv",
        "data/ir_cron.xml",
        "views/integration_views.xml",
        "views/res_config_settings_views.xml",
    ],
    "application": False,
    "installable": True,
}
