"""Optional, governed Z-Library acquisition infrastructure."""

from diandianreading.infrastructure.acquisition.zlibrary.acquirer import ZLibraryAcquirer
from diandianreading.infrastructure.acquisition.zlibrary.browser import (
    ZLibraryBrowserPort,
    ZLibraryDownloadTicket,
)
from diandianreading.infrastructure.acquisition.zlibrary.config import (
    ZLibraryAdapterConfig,
    ZLibraryArchiveLimits,
    ZLibraryDownloadLimits,
)
from diandianreading.infrastructure.acquisition.zlibrary.credentials import (
    ZLibraryCredentialResolver,
    ZLibraryProfilePaths,
)
from diandianreading.infrastructure.acquisition.zlibrary.downloader import (
    BoundedZLibraryDownloader,
    DownloadedFile,
    HttpResponseStream,
    PinnedHttpsTransport,
    StdlibPinnedHttpsTransport,
)
from diandianreading.infrastructure.acquisition.zlibrary.migration import (
    LegacyMigrationResult,
    LegacyProfileInspection,
    ZLibraryLegacyProfileMigrator,
)
from diandianreading.infrastructure.acquisition.zlibrary.network import (
    BrowserCookie,
    DnsResolver,
    PinnedDestination,
    SystemDnsResolver,
    ValidatedUrl,
    ZLibraryNetworkPolicy,
    cookie_header,
)
from diandianreading.infrastructure.acquisition.zlibrary.playwright_browser import (
    PlaywrightZLibraryBrowser,
)
from diandianreading.infrastructure.acquisition.zlibrary.selectors import (
    ZLIBRARY_SELECTORS_V1,
    ZLibrarySelectorSet,
)
from diandianreading.infrastructure.acquisition.zlibrary.session import (
    ZLibrarySessionManager,
    ZLibrarySessionState,
    ZLibrarySessionStatus,
)
from diandianreading.infrastructure.acquisition.zlibrary.validation import (
    ValidatedDocument,
    validate_downloaded_document,
)

__all__ = [
    "ZLIBRARY_SELECTORS_V1",
    "BoundedZLibraryDownloader",
    "BrowserCookie",
    "DnsResolver",
    "DownloadedFile",
    "HttpResponseStream",
    "LegacyMigrationResult",
    "LegacyProfileInspection",
    "PinnedDestination",
    "PinnedHttpsTransport",
    "PlaywrightZLibraryBrowser",
    "StdlibPinnedHttpsTransport",
    "SystemDnsResolver",
    "ValidatedDocument",
    "ValidatedUrl",
    "ZLibraryAcquirer",
    "ZLibraryAdapterConfig",
    "ZLibraryArchiveLimits",
    "ZLibraryBrowserPort",
    "ZLibraryCredentialResolver",
    "ZLibraryDownloadLimits",
    "ZLibraryDownloadTicket",
    "ZLibraryLegacyProfileMigrator",
    "ZLibraryNetworkPolicy",
    "ZLibraryProfilePaths",
    "ZLibrarySelectorSet",
    "ZLibrarySessionManager",
    "ZLibrarySessionState",
    "ZLibrarySessionStatus",
    "cookie_header",
    "validate_downloaded_document",
]
