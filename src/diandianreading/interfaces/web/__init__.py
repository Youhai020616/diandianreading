"""Single-origin local Web/API interface."""

from diandianreading.interfaces.web.app import create_web_app
from diandianreading.interfaces.web.http_security import LocalHttpConfig

__all__ = ["LocalHttpConfig", "create_web_app"]
