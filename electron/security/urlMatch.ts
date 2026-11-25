export function matchesTrustedAppUrl(candidate: string, expected: string): boolean {
  try {
    const actual = new URL(candidate);
    const target = new URL(expected);
    actual.hash = "";
    target.hash = "";
    if (actual.href === target.href) return true;
    return (
      target.protocol !== "file:"
      && actual.origin === target.origin
      && actual.pathname === target.pathname
      && actual.search === target.search
    );
  } catch {
    return false;
  }
}
