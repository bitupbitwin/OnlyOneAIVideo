import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";

export function Projects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<any[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", topic: "", audience: "", sellingPoints: "", references: "", requirements: "", extra: "" });
  const [error, setError] = useState("");

  const load = () => api.get<any[]>("/api/projects").then(setProjects).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    try {
      setError("");
      const project = await api.post<any>("/api/projects", {
        title: form.title || form.topic,
        brief: {
          topic: form.topic,
          audience: form.audience,
          sellingPoints: form.sellingPoints,
          references: form.references,
          requirements: form.requirements,
          extra: form.extra,
        },
      });
      setShowForm(false);
      setForm({ title: "", topic: "", audience: "", sellingPoints: "", references: "", requirements: "", extra: "" });
      // 进入项目页：在那里上传素材（图片/视频）并选择平台生成
      navigate(`/project/${project.id}`);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h2>选题项目</h2>
        <button onClick={() => setShowForm(!showForm)}>{showForm ? "收起" : "＋ 新建选题"}</button>
      </div>
      {error && <div className="error-text">{error}</div>}

      {showForm && (
        <div className="card">
          <label>项目名称（留空则使用主题）</label>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <label>主题 *</label>
          <input
            placeholder="例如：新手如何 30 天养成跑步习惯"
            value={form.topic}
            onChange={(e) => setForm({ ...form, topic: e.target.value })}
          />
          <label>目标人群</label>
          <input value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
          <label>核心卖点 / 观点</label>
          <textarea rows={2} value={form.sellingPoints} onChange={(e) => setForm({ ...form, sellingPoints: e.target.value })} />
          <label>📝 我的具体要求（希望生成成什么样、风格、必须包含/避免的内容——AI 会严格按此创作）</label>
          <textarea
            rows={3}
            placeholder="例如：风格活泼一点，正文里一定要提到「实战」，不要写得太营销；面向新手，多举例子"
            value={form.requirements}
            onChange={(e) => setForm({ ...form, requirements: e.target.value })}
          />
          <label>参考素材 / 链接（也可在创建后上传图片、视频、粘贴长文）</label>
          <textarea rows={2} value={form.references} onChange={(e) => setForm({ ...form, references: e.target.value })} />
          <label>补充说明</label>
          <textarea rows={2} value={form.extra} onChange={(e) => setForm({ ...form, extra: e.target.value })} />
          <div style={{ marginTop: 12 }}>
            <button disabled={!form.topic.trim()} onClick={create}>
              创建项目并上传素材 →
            </button>
          </div>
        </div>
      )}

      <div className="grid">
        {projects.map((p) => (
          <Link to={`/project/${p.id}`} key={p.id}>
            <div className="card">
              <h3>{p.title}</h3>
              <p className="muted" style={{ marginTop: 6 }}>
                {p.brief.topic}
              </p>
              <p className="muted" style={{ marginTop: 6 }}>
                {p.created_at}
              </p>
            </div>
          </Link>
        ))}
        {projects.length === 0 && <p className="muted">还没有项目，点击右上角「新建选题」开始。</p>}
      </div>
    </div>
  );
}
