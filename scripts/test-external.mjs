import { searchSemanticScholar, searchArxiv } from "../lib/search/external.ts";
const a = await searchSemanticScholar("FAIR data catalyst provenance", 2);
console.log("semscholar:", a.length, "results");
if (a[0]) console.log("  ex:", a[0].title.slice(0, 80));
const b = await searchArxiv("catalyst provenance metadata", 2);
console.log("arxiv:", b.length, "results");
if (b[0]) console.log("  ex:", b[0].title.slice(0, 80));
