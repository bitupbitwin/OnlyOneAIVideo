import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, STATUS_LABEL } from "../api";

export function Topics() {
  const MAX_IMPORT_FILES = 20;
  const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
  const MAX_MATERIAL_CHARS = 300_000;
  const navigate = useNavigate();
  const materialFileRef = useRef<HTMLInputElement>(null);
  const [topics, setTopics] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [requirements, setRequirements] = useState("");
  const [sourceType, setSourceType] = useState("text");
  const [mediaMode, setMediaMode] = useState("image-tts");
  const [materialMode, setMaterialMode] = useState<"text" | "url">("text");
  const [materialText, setMaterialText] = useState("");
  const [materialUrl, setMaterialUrl] = useState("");
  const [materialNote, setMaterialNote] = useState("");
  const [fetchingUrl, setFetchingUrl] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const load = () => api.get<any[]>("/api/topics").then(setTopics).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const create = async (auto: boolean) => {
    setError("");
    if (materialMode === "url" && materialUrl.trim()) {
      setError("请先点击“抓取网页正文为预览”，确认正文后再新建。");
      return;
    }
    setCreating(true);
    try {
      const topic = await api.post<any>("/api/topics", {
        title,
        sourceType,
        auto,
        brief: { topic: title, requirements, mediaMode },
        material: materialText.trim() ? {
          content: materialText.trim(),
          note: materialNote || "新建产线时导入的原始素材",
        } : undefined,
      });
      // Image and footage sources require uploads in the workbench before execution.
      if (auto && sourceType === "text") await api.post(`/api/topics/${topic.id}/run`, { auto: true });
      navigate(`/topic/${topic.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const importMaterialFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    try {
      const selected = Array.from(files);
      if (selected.length > MAX_IMPORT_FILES) throw new Error(`一次最多导入 ${MAX_IMPORT_FILES} 个文件`);
      const oversized = selected.find((file) => file.size > MAX_IMPORT_FILE_BYTES);
      if (oversized) throw new Error(`${oversized.name} 超过 2 MB，请拆分或精简后再导入`);
      const contents = await Promise.all(selected.map(async (file) => {
        const raw = await file.text();
        const content = /\.html?$/i.test(file.name) ? htmlToText(raw) : raw;
        return `【${file.name}】\n${content.trim()}`;
      }));
      const combined = [materialText.trim(), ...contents].filter(Boolean).join("\n\n");
      if (combined.length > MAX_MATERIAL_CHARS) throw new Error("素材总长度超过 30 万字，请拆成多个选题或精简素材");
      setMaterialText(combined);
      setMaterialNote((current) => [current, `导入文件：${selected.map((file) => file.name).join("、")}`].filter(Boolean).join("；"));
    } catch (e: any) {
      setError(`读取文件失败：${e.message}`);
    }
  };

  const fetchWebMaterial = async () => {
    if (!materialUrl.trim()) {
      setError("请先输入网页地址。");
      return;
    }
    setFetchingUrl(true);
    setError("");
    try {
      const result = await api.post<{ title: string; url: string; content: string }>("/api/materials/fetch-url", {
        url: materialUrl.trim(),
      });
      const section = `【网页：${result.title || result.url}】\n${result.content}`;
      const combined = [materialText.trim(), section].filter(Boolean).join("\n\n");
      if (combined.length > MAX_MATERIAL_CHARS) throw new Error("加入该网页后素材超过 30 万字，请先精简现有素材");
      setMaterialText(combined);
      setMaterialNote((current) => [current, `网页：${result.title || result.url} · ${result.url}`].filter(Boolean).join("；"));
      setMaterialMode("text");
    } catch (e: any) {
      setError(`网页抓取失败：${e.message}`);
    } finally {
      setFetchingUrl(false);
    }
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
        <label>信息源</label>
        <select value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="text">A1 纯文本</option>
          <option value="image">A2 参考图</option>
          <option value="footage">B 实拍素材</option>
        </select>
        <div className="material-input">
          <div className="material-input-header">
            <label>素材输入</label>
            <div className="material-mode-tabs">
              <button className={materialMode === "text" ? "" : "ghost"} onClick={() => setMaterialMode("text")}>粘贴文本</button>
              <button className={materialMode === "url" ? "" : "ghost"} onClick={() => setMaterialMode("url")}>粘贴网址</button>
            </div>
          </div>
          <textarea
            rows={7}
            value={materialMode === "text" ? materialText : materialUrl}
            onChange={(event) => materialMode === "text" ? setMaterialText(event.target.value) : setMaterialUrl(event.target.value)}
            placeholder={materialMode === "text" ? "粘贴原始文章、小说、脚本或其他完整素材" : "输入网址，例如 https://example.com/article"}
          />
          <div className="material-input-footer">
            <span className="muted">{(materialMode === "text" ? materialText : materialUrl).length} 字</span>
            {materialMode === "text" ? (
              <>
                <input
                  ref={materialFileRef}
                  className="material-file-input"
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html"
                  onChange={(event) => {
                    void importMaterialFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button className="ghost" onClick={() => materialFileRef.current?.click()}>导入文本文件</button>
              </>
            ) : (
              <button disabled={fetchingUrl || !materialUrl.trim()} onClick={fetchWebMaterial}>
                {fetchingUrl ? "正在抓取..." : "抓取网页正文为预览"}
              </button>
            )}
          </div>
          {materialNote && materialMode === "text" && <p className="muted material-source-note">{materialNote}</p>}
        </div>
        <label>主题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：普通人如何开始做短视频自动化" />
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
          <button disabled={!title.trim() || creating} onClick={() => create(false)}>
            新建
          </button>
          <button className="ghost" disabled={!title.trim() || creating} onClick={() => create(true)}>
            {creating ? "正在创建..." : sourceType === "text" ? "全自动运行" : "新建并上传素材"}
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

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, svg").forEach((node) => node.remove());
  doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  doc.querySelectorAll("p, div, section, article, h1, h2, h3, h4, h5, h6, li, blockquote, pre").forEach((node) => node.append("\n"));
  return (doc.body.textContent ?? "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
