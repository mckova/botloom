import { useEffect, useState } from "react";
import { api, type Agent } from "../api";

interface Doc {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export default function Knowledge({ agent }: { agent: Agent }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const load = () => api<Doc[]>(`/api/agents/${agent.id}/docs`).then(setDocs);
  useEffect(() => {
    load();
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (f: File) => {
    setTitle(f.name.replace(/\.[^.]+$/, ""));
    setContent(await f.text());
  };

  return (
    <div className="pad narrow">
      <p className="muted">
        Documents the AI agent can search (prices, hours, policies, FAQ). Retrieval is local BM25 with Hebrew-aware tokenization, so it works with no vector database. Paragraphs become chunks.
      </p>
      <div className="card">
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" />
        <textarea rows={8} placeholder="Paste text, or load a .txt / .md file" value={content} onChange={(e) => setContent(e.target.value)} dir="auto" />
        <div className="row">
          <input type="file" accept=".txt,.md,.csv,.json" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <span className="spacer" />
          <button
            className="primary"
            disabled={!title || !content}
            onClick={async () => {
              await api(`/api/agents/${agent.id}/docs`, { method: "POST", json: { title, content } });
              setTitle("");
              setContent("");
              load();
            }}
          >
            Add document
          </button>
        </div>
      </div>
      {docs.map((d) => (
        <div key={d.id} className="card">
          <div className="row">
            <b dir="auto">{d.title}</b>
            <span className="muted small">{d.content.length.toLocaleString()} chars</span>
            <span className="spacer" />
            <button className="danger" onClick={() => api(`/api/docs/${d.id}`, { method: "DELETE" }).then(load)}>
              Delete
            </button>
          </div>
          <pre className="doc-preview" dir="auto">
            {d.content.slice(0, 600)}
          </pre>
        </div>
      ))}
    </div>
  );
}
