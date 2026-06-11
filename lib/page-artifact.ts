const PAGE_ARTIFACT_START = "<<<SYNAPSE_PAGE_HTML>>>";
const PAGE_ARTIFACT_RE =
  /<<<SYNAPSE_PAGE_HTML>>>\s*([\s\S]*?)\s*<<<END_SYNAPSE_PAGE_HTML>>>/i;

export interface ParsedPageArtifact {
  visibleText: string;
  html: string | null;
  hasArtifact: boolean;
}

export function parsePageArtifact(text: string): ParsedPageArtifact {
  const raw = String(text ?? "");
  const match = raw.match(PAGE_ARTIFACT_RE);
  if (!match) {
    const startIndex = raw.indexOf(PAGE_ARTIFACT_START);
    if (startIndex >= 0) {
      const visibleText = raw.slice(0, startIndex).replace(/\n{3,}/g, "\n\n").trim();
      const html = raw.slice(startIndex + PAGE_ARTIFACT_START.length).trim() || null;
      return {
        visibleText,
        html,
        hasArtifact: !!html,
      };
    }
    return {
      visibleText: raw.trim(),
      html: null,
      hasArtifact: false,
    };
  }

  const html = match[1]?.trim() || null;
  const visibleText = raw.replace(PAGE_ARTIFACT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    visibleText,
    html,
    hasArtifact: !!html,
  };
}

export function stripPageArtifact(text: string): string {
  return parsePageArtifact(text).visibleText;
}
