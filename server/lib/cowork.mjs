export function parseCoworkSession(raw) {
  const folder = Array.isArray(raw.userSelectedFolders) && raw.userSelectedFolders.length > 0
    ? raw.userSelectedFolders[0]
    : raw.cwd;
  return {
    sessionId: raw.sessionId,
    title: raw.title ?? null,
    model: raw.model ?? null,
    folder,
    lastActivityAt: raw.lastActivityAt ?? raw.createdAt ?? null,
    archived: raw.isArchived === true
  };
}
