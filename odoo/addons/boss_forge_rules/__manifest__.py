{
    "name": "Boss Forge Rules",
    "summary": "Versioned recruitment rules, capabilities, and institution catalogs",
    "version": "19.0.1.0.0",
    "category": "Human Resources/Recruitment",
    "license": "LGPL-3",
    "author": "Boss-Forge",
    "depends": ["hr_recruitment"],
    "data": [
        "security/ir.model.access.csv",
        "data/rule_seed_data.xml",
        "views/rule_views.xml",
        "views/institution_views.xml",
    ],
    "application": False,
    "installable": True,
}
