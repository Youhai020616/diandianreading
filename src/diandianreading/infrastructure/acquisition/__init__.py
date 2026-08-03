"""Document acquisition adapters."""

from diandianreading.infrastructure.acquisition.local import LocalFileAcquirer
from diandianreading.infrastructure.acquisition.zlibrary import (
    BoundedZLibraryDownloader,
    PlaywrightZLibraryBrowser,
    ZLibraryAcquirer,
    ZLibraryAdapterConfig,
    ZLibraryCredentialResolver,
    ZLibraryLegacyProfileMigrator,
    ZLibraryNetworkPolicy,
    ZLibrarySessionManager,
)

__all__ = [
    "BoundedZLibraryDownloader",
    "LocalFileAcquirer",
    "PlaywrightZLibraryBrowser",
    "ZLibraryAcquirer",
    "ZLibraryAdapterConfig",
    "ZLibraryCredentialResolver",
    "ZLibraryLegacyProfileMigrator",
    "ZLibraryNetworkPolicy",
    "ZLibrarySessionManager",
]
