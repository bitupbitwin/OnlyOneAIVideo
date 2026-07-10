import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, STATUS_LABEL } from "../api";

export function Topics() {
  const navigate = useNavigate();
  const [topics, setTopics] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [sourceType, setSourceType] = useState("text");
  const [error, setError] = useState("");

  const load = () => api.get<any[]>("/api/topics").then(setTopics).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (auto: boolean) => {
    setError("");
    const topic = await api.post<any>("/api/topics", {
      title,
      sourceType,
      auto,
      brief: { topic: title, requirements },
    });
    if (auto) await api.post(`/api/topics/${topic.id}/run`, { auto: true });
    navigate(`/topic/${topic.id}`);
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h2>选题</h2>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <h3>新建一条产线</h3>
        <label>主题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：普通人如何开始做短视频自动化" />
        <label>信息源</label>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="text">A1 纯文本</option>
          <option value="image">A2 参考图</option>
          <option value="footage">B 实拍素材</option>
        </select>
        <label>具体要求</label>
        <textarea rows={4} value={requirements} onChange={(e) => setRequirements(e.target.value)} />
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={!title.trim()} onClick={() => create(false)}>
            新建
          </button>
          <button className="ghost" disabled={!title.trim()} onClick={() => create(true)}>
            全自动运行
          </button>
        </div>
      </div>

      <div className="grid">
        {topics.map((t) => (
          <Link className="card" to={`/topic/${t.id}`} key={t.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{t.title}</strong>
              <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
            </div>
            <p className="muted">信息源：{t.source_type}</p>
            <p className="muted">创建：{t.created_at}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
