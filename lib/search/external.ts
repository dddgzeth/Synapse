/**
 * External research search — Semantic Scholar + arXiv.
 * Used by Deep Research (user-initiated via ⚡ button).
 */

export interface SearchResult {
  title: string;
  abstract: string;
  authors: string[];
  year?: number;
  url?: string;
  source: "semantic_scholar" | "arxiv";
}

// ============================
// Semantic Scholar
// ============================

export async function searchSemanticScholar(query: string, limit = 5): Promise<SearchResult[]> {
  try {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("fields", "title,abstract,authors,year,externalIds,url");

    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "Synapse-Research-Tool/1.0" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return [];
    const json = await resp.json() as { data?: unknown[] };
    const items = json.data ?? [];

    return items.map((item: any) => ({
      title: item.title ?? "",
      abstract: item.abstract ?? "",
      authors: (item.authors ?? []).map((a: any) => a.name ?? "").filter(Boolean),
      year: item.year,
      url: item.url ?? (item.externalIds?.DOI ? `https://doi.org/${item.externalIds.DOI}` : undefined),
      source: "semantic_scholar" as const,
    })).filter((r) => r.title);
  } catch {
    return [];
  }
}

// ============================
// arXiv
// ============================

export async function searchArxiv(query: string, limit = 5): Promise<SearchResult[]> {
  try {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("max_results", String(limit));
    url.searchParams.set("sortBy", "relevance");

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return [];
    const text = await resp.text();

    const results: SearchResult[] = [];
    const entries = text.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];

    for (const entry of entries) {
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
      const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? "";
      const arxivUrl = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? "";
      const authorNames = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)]
        .map((m) => m[1]?.trim() ?? "")
        .filter(Boolean);
      const publishedStr = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? "";
      const year = publishedStr ? new Date(publishedStr).getFullYear() : undefined;

      if (title) {
        results.push({
          title,
          abstract: summary,
          authors: authorNames,
          year,
          url: arxivUrl,
          source: "arxiv" as const,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ============================
// Combined search
// ============================

export async function searchAll(query: string, limit = 5): Promise<SearchResult[]> {
  const [ss, ax] = await Promise.all([
    searchSemanticScholar(query, limit),
    searchArxiv(query, limit),
  ]);
  return [...ss, ...ax];
}
