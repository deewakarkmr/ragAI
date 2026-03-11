import { useState } from 'react';

export default function App() {
  const [history, setHistory] = useState([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function sendMessage(event) {
    event.preventDefault();
    const text = message.trim();
    if (!text || loading) return;

    const nextMessages = [...history, { role: 'user', content: text, meta: 'You' }];
    setHistory(nextMessages);
    setMessage('');
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: history
            .filter((item) => item.role === 'user' || item.role === 'assistant')
            .map((item) => ({ role: item.role, content: item.content })),
        }),
      });

      const raw = await response.text();
      let data = {};
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch (_error) {
          throw new Error(
            `Server returned non-JSON response (status ${response.status}). Check API deployment logs.`
          );
        }
      }

      if (!response.ok) {
        throw new Error(data?.error || `Request failed with status ${response.status}`);
      }

      const sourceLabel = (data.sources || [])
        .map((source) => {
          const page = source.page === null || source.page === undefined ? '' : `, p.${Number(source.page) + 1}`;
          return `${source.source}${page}`;
        })
        .join(' | ');

      setHistory((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: data.answer || 'No response generated.',
          meta: sourceLabel || 'Assistant',
        },
      ]);
    } catch (error) {
      setHistory((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${error.message}`, meta: 'System' },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <p className="tag">Resume Project</p>
        <h1>DSA RAG Chat</h1>
        <p className="sub">Ask questions from your indexed DSA document.</p>
      </section>

      <section className="chatCard">
        <div className="chatWindow">
          {history.length === 0 ? (
            <article className="bubble assistant">
              <p className="meta">Assistant</p>
              <p className="text">Ask a question like: Explain BFS vs DFS with time complexity.</p>
            </article>
          ) : (
            history.map((item, index) => (
              <article key={`${item.role}-${index}`} className={`bubble ${item.role}`}>
                <p className="meta">{item.meta || (item.role === 'user' ? 'You' : 'Assistant')}</p>
                <p className="text">{item.content}</p>
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Ask about arrays, trees, DP, graphs..."
            rows={3}
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Thinking...' : 'Send'}
          </button>
        </form>
      </section>
    </main>
  );
}
