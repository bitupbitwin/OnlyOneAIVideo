import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, connectWs, STATUS_LABEL } from "../api";

export function TopicWorkbench() {
  const { id } = useParams();
  const [topic, setTopic] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = () => {
    api.get<any>(`/api/topics/${id}`).then(setTopic).catch((e) => setError(e.message));
    api.get<any[]>("/api/providers").then(setProviders).catch(() => undefined);
  };
  useEffect(() => {
    load();
    return connectWs((event) => {
      if (String(event.topicId) !== String(id)) return;
      load();
    });
  }, [id]);

  const act = async (fn: () => Promise<any>, label: string) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  if (!topic) return <div className="page">{error || "加载中..."}</div>;

  return (
    <div className="page">
      <Link to="/">返回选题</Link>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
        <div>
          <h2 style={{ margin: "8px 0" }}>{topic.title}</h2>
          <p className="muted">
            {topic.source_type} · {STATUS_LABEL[topic.status] ?? topic.status}
          </p>
        </div>
        <div className="row">
          <button onClick={() => act(() => api.post(`/api/topics/${id}/run`, { auto: false }), "run")}>运行</button>
          <button className="ghost" onClick={() => act(() => api.post(`/api/topics/${id}/run`, { auto: true }), "auto")}>
            全自动
          </button>
        </div>
      </div>
      {busy && <div className="muted">正在处理...</div>}
      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <h3>主线步骤</h3>
        <div className="steps">
          {topic.steps.map((s: any) => (
            <div className="step-card" key={s.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{s.name}</strong>
                <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
              </div>
              <p className="muted">
                {s.step_id}
                {s.provider_id ? ` · ${s.provider_id}` : ""}
              </p>
              {s.error && <div className="error-text">{s.error}</div>}
              <div className="row">
                <select
                  value={s.provider_id ?? ""}
                  disabled={s.step_id === "compose"}
                  onChange={(e) =>
                    act(() => api.post(`/api/steps/${s.id}/provider`, { providerId: e.target.value }), "provider")
                  }
                >
                  <option value="">未绑定</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="ghost small" onClick={() => act(() => api.post(`/api/steps/${s.id}/rerun`), "rerun")}>
                  重跑
                </button>
                {s.status === "waiting_human" && (
                  <button className="small" onClick={() => act(() => api.post(`/api/steps/${s.id}/confirm`), "confirm")}>
                    确认
                  </button>
                )}
              </div>

              {(s.artifacts ?? []).length > 0 && (
                <div className="artifacts">
                  {s.artifacts.map((a: any) => (
                    <div className="artifact" key={a.id}>
                      <label>
                        <input
                          type="radio"
                          checked={a.selected}
                          onChange={() => act(() => api.post(`/api/artifacts/${a.id}/select`), "select")}
                        />
                        {a.label ?? a.role ?? a.kind}
                      </label>
                      {a.content && <pre>{a.content}</pre>}
                      {a.file_path && <a href={`/api/artifacts/${a.id}/file`}>打开文件</a>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
