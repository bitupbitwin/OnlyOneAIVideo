import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, STATUS_LABEL } from "../api";

export function Topics() {
  const navigate = useNavigate();
  const [topics, setTopics] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [sourceType, setSourceType] = useState("text");
  const [mediaMode, setMediaMode] = useState("image-tts");
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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
      brief: { topic: title, requirements, mediaMode },
    });
    // 图片/实拍信息源必须先进入工作台上传素材，不能创建后立即空跑。
    if (auto && sourceType === "text") await api.post(`/api/topics/${topic.id}/run`, { auto: true });
    navigate(`/topic/${topic.id}`);
  };

  const removeTopic = async (event: React.MouseEvent, topic: any) => {
    event.preventDefault();
    event.stopPropagation();
    if (!window.confirm(`确定删除选题“${topic.title}”吗？\n该选题的分镜、音频和成片文件也会一起删除。`)) return;
    setError("");
    try {
      await api.del(`/api/topics/${topic.id}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleTopic = (event: React.MouseEvent | React.ChangeEvent, topicId: number) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  const toggleSelecting = () => {
    setSelecting((current) => !current);
    setSelectedIds(new Set());
  };

  const removeSelected = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 个选题吗？\n对应的分镜、音频和成片文件也会一起删除。`)) return;
    setError("");
    try {
      await api.post("/api/topics/bulk-delete", { ids });
      setSelectedIds(new Set());
      setSelecting(false);
      load();
    } catch (e: any) {
      setError(e.message);
    }
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
        <label>媒体生成路径</label>
        <select value={mediaMode} onChange={(e) => setMediaMode(e.target.value)}>
          <option value="image-tts">图片 + 独立配音 → 合成（省费用）</option>
          <option value="image-video">先出图 → 图生视频 → 拼接（人物一致性更好）</option>
          <option value="text-video">分镜提示词 → 直接生成视频 → 拼接</option>
        </select>
        <p className="muted" style={{ marginTop: 6 }}>
          视频路径按每个分镜调用视频模型，费用明显高于图片路径；可在工作台为视频模块选择具体引擎。
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={!title.trim()} onClick={() => create(false)}>
            新建
          </button>
          <button className="ghost" disabled={!title.trim()} onClick={() => create(true)}>
            {sourceType === "text" ? "全自动运行" : "新建并上传素材"}
          </button>
        </div>
      </div>

      <div className="card topic-list-module">
        <div className="row topic-list-header">
          <div>
            <h3>已有选题</h3>
            <p className="muted">共 {topics.length} 个选题</p>
          </div>
          <div className="row">
            {selecting && (
              <button className="danger" disabled={selectedIds.size === 0} onClick={removeSelected}>
                删除所选（{selectedIds.size}）
              </button>
            )}
            <button className="ghost" onClick={toggleSelecting}>{selecting ? "取消选择" : "选择"}</button>
          </div>
        </div>
        <div className="grid topic-grid">
          {topics.map((t) => (
            <Link
              className={`topic-card ${selectedIds.has(t.id) ? "selected" : ""}`}
              to={`/topic/${t.id}`}
              key={t.id}
              onClick={(event) => selecting && t.status !== "running" && toggleTopic(event, t.id)}
            >
              {selecting && (
                <input
                  className="topic-checkbox"
                  type="checkbox"
                  checked={selectedIds.has(t.id)}
                  disabled={t.status === "running"}
                  onChange={(event) => toggleTopic(event, t.id)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`选择 ${t.title}`}
                />
              )}
              <strong className="topic-title" style={{ paddingRight: selecting ? 30 : 0 }}>{t.title}</strong>
              <div className="topic-actions">
                  <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
                  {!selecting && (
                    <button className="danger small" disabled={t.status === "running"} onClick={(event) => removeTopic(event, t)}>
                      删除
                    </button>
                  )}
              </div>
              <p className="muted">信息源：{t.source_type}</p>
              <p className="muted">创建：{t.created_at}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
