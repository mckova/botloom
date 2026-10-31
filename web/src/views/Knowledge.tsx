import { useEffect, useState } from "react";
import { api, type Agent } from "../api";
import { useConfirm } from "../components/Confirm";
import { BookOpen } from "lucide-react";

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
  const { confirm, dialog } = useConfirm();
  const load = () => api<Doc[]>(`/api/agents/${agent.id}/docs`).then(setDocs);
  useEffect(() => {
    load();
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = async (f: File) => {
    setTitle(f.name.replace(/\.[^.]+$/, ""));
    setContent(await f.text());
  };

  return (
    <div className="page">
      {dialog}
      <section className="section">
        <header>
          <h2>
            <BookOpen size={16} /> Knowledge
          </h2>
          <p>Prices, hours, policies and FAQs the agent searches before it answers. Each paragraph becomes a searchable passage; Hebrew prefixes are handled.</p>
        </header>
        <div className="stack">
          <label className="field">
            <span>Title</span>
            <input placeholder="Opening hours and prices" value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" />
          </label>
          <label className="field">
            <span>Text</span>
            <textarea rows={8} placeholder="Paste text, or load a .txt, .md, .csv or .json file" value={content} onChange={(e) => setContent(e.target.value)} dir="auto" />
          </label>
          <div className="row">
            <input type="file" aria-label="Load a text file" accept=".txt,.md,.csv,.json" style={{ width: "auto", border: 0, padding: 0 }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
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
      </section>
      <section className="section">
        <header>
          <h2>Documents</h2>
          <p className="num">{docs.length === 1 ? "1 document" : `${docs.length} documents`}</p>
        </header>
        <div className="stack">
          {docs.length === 0 && <p className="soft small">No documents yet. Agents with knowledge search answer only from what is here.</p>}
          {docs.map((d) => (
            <article key={d.id} className="card">
              <div className="row">
                <b dir="auto">{d.title}</b>
                <span className="mono muted">{d.content.length.toLocaleString()} chars</span>
                <span className="spacer" />
                <button
                  className="ghost sm danger"
                  onClick={async () => {
                    if (await confirm(`Delete “${d.title}”?`, { body: "The agent will stop using this document to answer." })) api(`/api/docs/${d.id}`, { method: "DELETE" }).then(load);
                  }}
                >
                  Delete
                </button>
              </div>
              <pre className="doc-preview" dir="auto">
                {d.content.slice(0, 600)}
              </pre>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
