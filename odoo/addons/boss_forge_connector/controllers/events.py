import json
import logging

from odoo import http
from odoo.exceptions import AccessError, ValidationError
from odoo.http import request


_logger = logging.getLogger(__name__)


class BossForgeEventController(http.Controller):
    @http.route(
        "/boss_forge/api/v1/events",
        type="http",
        auth="bearer",
        methods=["POST"],
        csrf=False,
        save_session=False,
    )
    def ingest_event(self, **kwargs):
        if not request.env.user.has_group("base.group_system"):
            raise AccessError("The bearer service user is not a system operator.")
        try:
            envelope = request.httprequest.get_json(silent=False)
            correlation_id = request.httprequest.headers.get("X-Correlation-Id")
            record, duplicate = request.env["boss.forge.integration.inbox"].sudo().ingest(
                envelope, correlation_id=correlation_id
            )
            if record.state == "failed":
                return request.make_json_response(
                    {
                        "ok": False,
                        "duplicate": False,
                        "eventId": record.event_id,
                        "state": record.state,
                        "error": record.error_summary,
                    },
                    status=500,
                )
            return request.make_json_response(
                {
                    "ok": True,
                    "duplicate": duplicate,
                    "eventId": record.event_id,
                    "state": record.state,
                },
                status=200,
            )
        except (json.JSONDecodeError, TypeError, ValueError, ValidationError) as exc:
            return request.make_json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception:
            _logger.exception("Boss-Forge inbound event processing failed")
            return request.make_json_response(
                {"ok": False, "error": "Inbound event processing failed."}, status=500
            )
