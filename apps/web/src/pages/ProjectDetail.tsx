import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, STATUS_LABEL } from "../api";

export function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<any>(null);
  const [templates, setTemplates] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [optionValues, setOptionValues] = useState<Record<string, Record<string, string>>>({});
  const [error, setError] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = () => {
    api.get<any>(`/api/projects/${id}`).then(setProject).catch((e) => setError(e.message));
    api.get<any[]>("/api/templates").then(setTemplates).catch(() => undefined);
  };
  useEffect(load, [id]);

  const addText = async () => {
    if (!pasteText.trim()) return;
    try {
      setError("");
      await api.post(`/api/projects/${id}/materials/text`, { content: pasteText, note: pasteNote });
      setPasteText("");
      setPasteNote("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    try {
      setError("");
      setUploading(true);
      await api.upload(`/api/projects/${id}/materials/upload`, files);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const delMaterial = async (mid: number) => {
    await api.del(`/api/materials/${mid}`).catch(() => undefined);
    load();
  };

  const KIND_ICON: Record<string, string> = { text: "📄", image: "🖼️", video: "🎬", file: "📎" };

  const toggle = (tid: string) =>
    setSelected((prev) => (prev.includes(tid) ? prev.filter((x) => x !== tid) : [...prev, tid]));

  // 各流程的运行选项选择值：{ templateId: { optionId: value } }
  const setOption = (tid: string, optId: string, value: string) =>
    setOptionValues((prev) => ({ ...prev, [tid]: { ...(prev[tid] ?? {}), [optId]: value } }));

  const createPipelines = async (autoRun: boolean) => {
    try {
      setError("");
      let firstId: number | null = null;
      for (const templateId of selected) {
        const pipeline = await api.post<any>(`/api/projects/${id}/pipelines`, {
          templateId,
          options: optionValues[templateId] ?? {},
        });
        if (firstId == null) firstId = pipeline.id;
        if (autoRun) await api.post(`/api/pipelines/${pipeline.id}/run`, { auto: true });
      }
      setSelected([]);
      if (selected.length === 1 && firstId != null) navigate(`/pipeline/${firstId}`);
      else load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!project) return <div className="page">{error || "加载中…"}</div>;

  return (
    <div className="page">
      <p className="muted">
        <Link to="/">← 返回项目列表</Link>
      </p>
      <h2 style={{ margin: "10px 0" }}>{project.title}</h2>
      <div className="card">
        <p>主题：{project.brief.topic}</p>
        {project.brief.audience && <p className="muted">人群：{project.brief.audience}</p>}
        {project.brief.sellingPoints && <p className="muted">卖点：{project.brief.sellingPoints}</p>}
        {project.brief.requirements && (
          <p style={{ marginTop: 6 }}>
            📝 我的要求：<span className="muted">{project.brief.requirements}</span>
          </p>
        )}
      </div>

      <div className="card">
        <h3>🗂 我的素材（AI 会基于这些内容来生产）</h3>
        <p className="muted" style={{ margin: "6px 0 12px" }}>
          粘贴文字/笔记、上传图片、上传未剪辑的视频原片。文字会写入提示词；图片会发给支持识图的引擎；视频会作为剪映草稿的源素材。
        </p>

        <div className="row" style={{ alignItems: "flex-end", gap: 10 }}>
          <label className="ghost" style={{ display: "inline-block", padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer" }}>
            {uploading ? "上传中…" : "＋ 上传图片 / 视频 / 文件"}
            <input
              type="file"
              multiple
              style={{ display: "none" }}
              disabled={uploading}
              onChange={(e) => uploadFiles(e.target.files)}
            />
          </label>
          <span className="muted">支持多选；视频单文件上限 2GB</span>
        </div>

        <label>或粘贴一段文字 / 技术笔记 / 文案草稿</label>
        <textarea rows={3} placeholder="把你的原始素材粘贴到这里…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
        <div className="row" style={{ marginTop: 6 }}>
          <input
            style={{ flex: 1 }}
            placeholder="给这段素材加个说明（可选，如：这是原始笔记 / 主打卖点）"
            value={pasteNote}
            onChange={(e) => setPasteNote(e.target.value)}
          />
          <button className="ghost" disabled={!pasteText.trim()} onClick={addText}>
            添加文字素材
          </button>
        </div>

        {(project.materials ?? []).length > 0 && (
          <div style={{ marginTop: 14 }}>
            {(project.materials ?? []).map((m: any) => (
              <div key={m.id} className="row" style={{ justifyContent: "space-between", padding: "8px 10px", background: "var(--panel2)", borderRadius: 8, marginBottom: 6 }}>
                <div className="row" style={{ gap: 10 }}>
                  <span>{KIND_ICON[m.kind] ?? "📎"}</span>
                  {m.kind === "image" && m.file_path ? (
                    <img src={`/api/materials/${m.id}/file`} alt="" style={{ height: 44, borderRadius: 6 }} />
                  ) : (
                    <div>
                      <div>{m.original_name || (m.kind === "text" ? "文字素材" : m.kind)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {m.note || (m.kind === "text" ? (m.content || "").slice(0, 40) + "…" : m.kind)}
                      </div>
                    </div>
                  )}
                </div>
                <button className="ghost small" onClick={() => delMaterial(m.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>选择平台流程（可多选，一稿多平台并行生成）</h3>
        <div className="row" style={{ marginTop: 10 }}>
          {templates.map((t) => (
            <button
              key={t.id}
              className={selected.includes(t.id) ? "" : "ghost"}
              onClick={() => toggle(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>

        {/* 选中的流程若有可选参数，渲染为可点击的选项 */}
        {templates
          .filter((t) => selected.includes(t.id) && (t.options ?? []).length > 0)
          .map((t) => (
            <div key={t.id} style={{ marginTop: 14, padding: "10px 12px", background: "var(--panel2)", borderRadius: 8 }}>
              <div className="muted" style={{ marginBottom: 8 }}>
                「{t.name}」选项
              </div>
              {(t.options as any[]).map((opt) => {
                const cur = optionValues[t.id]?.[opt.id] ?? opt.default;
                return (
                  <div key={opt.id} className="row" style={{ marginBottom: 8, gap: 8 }}>
                    <span style={{ width: 96, color: "var(--muted)", fontSize: 13 }}>{opt.label}</span>
                    {opt.type === "number" ? (
                      <>
                        <input
                          type="number"
                          style={{ width: 110 }}
                          min={opt.min}
                          max={opt.max}
                          step={opt.step ?? 1}
                          value={cur}
                          onChange={(e) => setOption(t.id, opt.id, e.target.value)}
                        />
                        {opt.hint && <span className="muted" style={{ fontSize: 12 }}>{opt.hint}</span>}
                      </>
                    ) : opt.type === "select" ? (
                      <select style={{ width: 240 }} value={cur} onChange={(e) => setOption(t.id, opt.id, e.target.value)}>
                        {(opt.choices ?? []).map((c: any) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    ) : (
                      (opt.choices ?? []).map((c: any) => (
                        <button
                          key={c.value}
                          className={cur === c.value ? "small" : "ghost small"}
                          onClick={() => setOption(t.id, opt.id, c.value)}
                        >
                          {c.label}
                        </button>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          ))}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" disabled={selected.length === 0} onClick={() => createPipelines(false)}>
            创建 {selected.length || ""} 条流程
          </button>
          <button
            disabled={selected.length === 0}
            title="创建后立即全自动并行生成：标题自动选优、评审不过自动重生成"
            onClick={() => createPipelines(true)}
          >
            ⚡ 创建并全自动生成
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      <h3 style={{ margin: "16px 0 10px" }}>已创建的流程</h3>
      <div className="grid">
        {(project.pipelines ?? []).map((p: any) => (
          <Link to={`/pipeline/${p.id}`} key={p.id}>
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>{p.name}</h3>
                <span className={`badge ${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
              </div>
              <p className="muted" style={{ marginTop: 6 }}>
                {p.created_at}
              </p>
            </div>
          </Link>
        ))}
        {(project.pipelines ?? []).length === 0 && <p className="muted">尚未创建流程。</p>}
      </div>
    </div>
  );
}
