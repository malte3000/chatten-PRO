import React from "react";

function safeSource(source) {
  if (typeof source?.url !== "string") return null;
  try {
    const url = new URL(source.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return { url: url.toString(), title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : url.hostname, kind: source.kind };
  } catch { return null; }
}

export default function NewsEvidence({ news }) {
  if (!news) return null;
  const sources = (Array.isArray(news.source_evidence?.sources) ? news.source_evidence.sources : []).map(safeSource).filter(Boolean);
  return <div className="text-xs text-amber-300 mt-2" aria-label="Nyhetskällor och aktualitet">
    <p>{sources.length
      ? "Källor från nyhetssökningen visas nedan. Publiceringsdatum, påståendenas stöd och kortsiktig effekt är inte automatiskt verifierade."
      : "Inga sökresultat eller citat finns för nyhetsanalysen. Nyhetsriktningen behandlas som oklar."}</p>
    {sources.length > 0 && <ul className="list-disc pl-5 mt-1">{sources.map((source) =>
      <li key={source.url}><a className="underline" href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> · {source.kind === "citation" ? "citerad källa" : "sökresultat"}</li>)}</ul>}
  </div>;
}
