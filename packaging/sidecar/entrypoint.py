"""PyInstaller entry point for the fixed desktop-sidecar executable."""

from diandianreading.interfaces.desktop_sidecar import main

if __name__ == "__main__":
    raise SystemExit(main())
