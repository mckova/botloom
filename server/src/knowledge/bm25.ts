// Tiny BM25 retriever over chunked documents. Works for Hebrew and English (Unicode tokenization,
// light prefix stripping for Hebrew prepositions). Swap for embeddings behind the same interface.

export interface Chunk {
  docId: string;
  title: string;
  text: string;
}

export interface Hit extends Chunk {
  score: number;
  snippet: string;
}

const STOP = new Set(
  "the a an and or of to in on for is are was be it this that with what how do does can i you we our your my at by from את של על עם זה זו מה איך האם יש אני אתם אנחנו לא כן או גם".split(" "),
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => (/^[֐-׿]/.test(w) && w.length > 3 ? w.replace(/^[והבכלמש]/, "") : w))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function chunk(docId: string, title: string, content: string, size = 600): Chunk[] {
  const paras = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: Chunk[] = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length > size) {
      out.push({ docId, title, text: buf });
      buf = "";
    }
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) out.push({ docId, title, text: buf });
  return out;
}

export function search(chunks: Chunk[], query: string, k = 3): Hit[] {
  const q = tokens(query);
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => tokens(`${c.title} ${c.text}`));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.4;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return { ...chunks[i], score, snippet: chunks[i].text };
  });
  return scored.filter((h) => h.score > 0).sort((a, b2) => b2.score - a.score).slice(0, k);
}
