from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    bf_api_base_url = fields.Char(
        string="Boss-Forge internal API URL",
        config_parameter="boss_forge_connector.base_url",
        default="http://boss-forge-api:3100",
    )
    bf_api_service_token = fields.Char(
        string="Boss-Forge service token",
        config_parameter="boss_forge_connector.service_token",
        groups="base.group_system",
    )
    bf_contact_transport_mode = fields.Selection(
        [("fake", "Fake (no external greeting)"), ("real", "Real")],
        string="Contact transport",
        config_parameter="boss_forge_connector.contact_transport_mode",
        default="fake",
        required=True,
    )
    bf_real_contact_enabled = fields.Boolean(
        string="Allow real contact",
        config_parameter="boss_forge_connector.real_contact_enabled",
        default=False,
        help="Global circuit breaker. Keep disabled until fake-transport acceptance is complete.",
    )
