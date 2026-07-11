import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, connectWs, STATUS_LABEL } from "../api";

export function TopicWorkbench() {
  const { id } = useParams();
  const [topic, setTopic] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [uploading, setUploading] = useState(false);
  const [composeProgress, setComposeProgress] = useState<{ pct: number; message?: string } | null>(null);

  const load = () => {
    api.get<any>(`/api/topics/${id}`).then(setTopic).catch((e) => setError(e.message));
    api.get<any[]>("/api/providers").then(setProviders).catch(() => undefined);
  };
  useEffect(() => {
    load();
    return connectWs((event) => {
      if (String(event.topicId) !== String(id)) return;
      if (event.type === "compose-progress") {
        setComposeProgress(event.data.pct >= 100 ? null : { pct: event.data.pct, message: event.data.message });
        return; // 进度事件高频，不触发整页刷新
      }
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

  const uploadMaterials = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError("");
    try {
      await api.upload(`/api/topics/${id}/materials/upload`, files);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const removeMaterial = async (materialId: number) => {
    setError("");
    try {
      await api.del(`/api/materials/${materialId}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!topic) return <div className="page">{error || "加载中..."}</div>;

  const materials = topic.materials ?? [];
  const requiredKind = topic.source_type === "image" ? "image" : topic.source_type === "footage" ? "video" : null;
  const hasRequiredMaterial = !requiredKind || materials.some((material: any) => material.kind === requiredKind);

  return (
    <div className="page">
      <Link to="/">返回选题</Link>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
        <div>
          <h2 style={{ margin: "8px 0" }}>{topic.title}</h2>
          <p className="muted">
            {topic.source_type} · {STATUS_LABEL[topic.status] ?? topic.status}
          </p>
          <p className="muted">路径：{mediaModeLabel(topic.brief?.mediaMode)}</p>
        </div>
        <div className="row">
          <button disabled={!hasRequiredMaterial} onClick={() => act(() => api.post(`/api/topics/${id}/run`, { auto: false }), "run")}>手动运行下一步</button>
          <button disabled={!hasRequiredMaterial} className="ghost" onClick={() => act(() => api.post(`/api/topics/${id}/run`, { auto: true }), "auto")}>
            全自动
          </button>
        </div>
      </div>
      {busy && <div className="muted">正在处理...</div>}
      {error && <div className="error-text">{error}</div>}

      {requiredKind && (
        <div className={`card source-upload ${hasRequiredMaterial ? "ready" : "required"}`}>
          <h3>{requiredKind === "image" ? "上传参考图" : "上传实拍视频"}</h3>
          <p className="muted" style={{ marginTop: 6 }}>
            {requiredKind === "image"
              ? "素材理解会把这里上传的图片直接发送给视觉模型。支持上传多张参考图。"
              : "请先上传视频原片，后续分镜和合成会使用这份素材。"}
          </p>
          <label className="upload-button">
            {uploading ? "上传中..." : hasRequiredMaterial ? "继续添加素材" : requiredKind === "image" ? "选择参考图片" : "选择视频文件"}
            <input
              type="file"
              multiple={requiredKind === "image"}
              accept={requiredKind === "image" ? "image/*" : "video/*"}
              disabled={uploading}
              onChange={(event) => uploadMaterials(event.target.files)}
            />
          </label>
          {!hasRequiredMaterial && <div className="upload-hint">上传素材后才能运行，避免素材理解空跑。</div>}
          {materials.filter((material: any) => material.kind === requiredKind).length > 0 && (
            <div className="material-previews">
              {materials
                .filter((material: any) => material.kind === requiredKind)
                .map((material: any) => (
                  <div className="material-preview" key={material.id}>
                    <button
                      className="material-remove"
                      title="删除这张素材"
                      aria-label={`删除 ${material.original_name ?? "素材"}`}
                      onClick={() => removeMaterial(material.id)}
                    >
                      ×
                    </button>
                    {material.kind === "image" ? (
                      <img src={`/api/materials/${material.id}/thumbnail`} alt={material.original_name ?? "参考图"} />
                    ) : (
                      <video src={`/api/materials/${material.id}/file`} preload="metadata" />
                    )}
                    <span>{material.original_name ?? "已上传素材"}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>主线步骤</h3>
        <div className="steps">
          {topic.steps.map((s: any, stepIndex: number) => {
            const previousDone = topic.steps
              .slice(0, stepIndex)
              .every((previous: any) => previous.status === "succeeded" || previous.status === "skipped");
            const canRunStep = s.status === "pending" && previousDone;
            return (
            <div className="step-card" key={s.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{s.name}</strong>
                {canRunStep ? (
                  <button className="small" onClick={() => act(() => api.post(`/api/steps/${s.id}/run`), `run-${s.step_id}`)}>
                    运行
                  </button>
                ) : (
                  <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                )}
              </div>
              <p className="muted">
                {s.step_id}
                {s.provider_id ? ` · ${s.provider_id}` : ""}
              </p>
              {s.error && <div className="error-text">{s.error}</div>}
              {s.step_id === "compose" && s.status === "running" && composeProgress && (
                <div className="muted">
                  合成中 {composeProgress.pct}%{composeProgress.message ? ` · ${composeProgress.message}` : ""}
                  <div style={{ height: 6, background: "#333", borderRadius: 3, marginTop: 4 }}>
                    <div
                      style={{
                        height: 6,
                        width: `${composeProgress.pct}%`,
                        background: "#4f8cff",
                        borderRadius: 3,
                        transition: "width .3s",
                      }}
                    />
                  </div>
                </div>
              )}
              <div className="row">
                <select
                  value={s.provider_id ?? ""}
                  disabled={s.step_id === "compose"}
                  onChange={(e) =>
                    act(() => api.post(`/api/steps/${s.id}/provider`, { providerId: e.target.value }), "provider")
                  }
                >
                  <option value="">未绑定</option>
                  {providers.filter((provider) => providerMatchesStep(provider, s.step_id)).map((p) => (
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

              {(s.artifacts ?? []).length > 0 && s.step_id === "title" && (
                <TitleCandidates
                  artifacts={s.artifacts}
                  onSelect={(artifactId) => act(() => api.post(`/api/artifacts/${artifactId}/select`), "select")}
                />
              )}
              {(s.artifacts ?? []).length > 0 && s.step_id !== "title" && (
                <div className={`artifacts ${["frames", "video", "tts", "compose"].includes(s.step_id) ? "artifacts-grid" : ""}`}>
                  {s.artifacts.map((a: any) => (
                    <div className={`artifact ${["frames", "video", "tts", "compose"].includes(s.step_id) ? "artifact-media" : ""}`} key={a.id}>
                      <div className="artifact-label">{a.label ?? a.role ?? a.kind}</div>
                      {a.content && <pre>{a.content}</pre>}
                      {a.kind === "video" && a.file_path && (
                        <video
                          className="artifact-video"
                          controls
                          preload="metadata"
                          src={`/api/artifacts/${a.id}/file`}
                        />
                      )}
                      {a.kind === "audio" && a.file_path && (
                        <audio className="artifact-audio" controls preload="none" src={`/api/artifacts/${a.id}/file`} />
                      )}
                      {a.kind === "image" && a.file_path && (
                        <img
                          className="artifact-image"
                          src={`/api/artifacts/${a.id}/file`}
                          alt={a.label ?? ""}
                        />
                      )}
                      {a.file_path && <a href={`/api/artifacts/${a.id}/file`}>打开文件</a>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TitleCandidates({ artifacts, onSelect }: { artifacts: any[]; onSelect: (artifactId: number) => void }) {
  const latestVersion = Math.max(...artifacts.map((artifact) => artifact.version));
  const candidates = artifacts.filter((artifact) => artifact.version === latestVersion).slice(0, 3);
  return (
    <fieldset className="title-candidates">
      <legend>标题候选</legend>
      {candidates.map((candidate) => (
        <label className={`title-option ${candidate.selected ? "selected" : ""}`} key={candidate.id}>
          <input type="radio" name={`title-version-${latestVersion}`} checked={candidate.selected} onChange={() => onSelect(candidate.id)} />
          <span>{candidate.content}</span>
        </label>
      ))}
    </fieldset>
  );
}

function mediaModeLabel(mode?: string) {
  if (mode === "image-video") return "图片 → 图生视频 → 拼接";
  if (mode === "text-video") return "分镜 → 直接生成视频 → 拼接";
  return "图片 + 独立配音 → 合成";
}

function providerMatchesStep(provider: any, stepId: string) {
  if (stepId === "frames") return provider.kind === "api-image";
  if (stepId === "video") return provider.kind === "api-video";
  if (stepId === "tts") return provider.kind === "tts";
  if (stepId === "compose") return false;
  return provider.kind === "cli" || provider.kind === "api-text";
}
