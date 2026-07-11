import { useEffect, useRef, useState } from "react";
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
  const [coverPrompt, setCoverPrompt] = useState("");
  const coverPromptDirty = useRef(false);
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [chosenPlatforms, setChosenPlatforms] = useState<string[]>([]);

  const load = () => {
    api.get<any>(`/api/topics/${id}`).then(setTopic).catch((e) => setError(e.message));
    api.get<any[]>("/api/providers").then(setProviders).catch(() => undefined);
    api.get<any[]>("/api/platforms").then((list) => {
      setPlatforms(list);
      setChosenPlatforms((prev) => (prev.length ? prev : list.map((p) => p.id)));
    }).catch(() => undefined);
    api.get<{ prompt: string }>(`/api/topics/${id}/cover-prompt`).then((r) => {
      // 用户正在润色时不要覆盖输入框
      if (!coverPromptDirty.current) setCoverPrompt(r.prompt);
    }).catch(() => undefined);
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

  const executeStep = async (step: any, rerun = false) => {
    if (step.step_id === "cover") {
      if (!coverPrompt.trim()) throw new Error("请先填写封面提示词");
      await api.put(`/api/topics/${id}/cover-prompt`, { prompt: coverPrompt });
      coverPromptDirty.current = false;
    }
    return api.post(`/api/steps/${step.id}/${rerun ? "rerun" : "run"}`);
  };

  const updateProductionSettings = async (patch: Record<string, any>) => {
    const previous = topic;
    const nextBrief = { ...topic.brief, ...patch };
    setTopic({ ...topic, brief: nextBrief });
    setError("");
    try {
      const updated = await api.put<any>(`/api/topics/${id}/brief`, { brief: nextBrief });
      setTopic(updated);
    } catch (e: any) {
      setTopic(previous);
      setError(`制作参数保存失败：${e.message}`);
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
      {busy && <div className="busy-toast">正在处理...</div>}
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
            const isDone = (step: any) => step?.status === "succeeded" || step?.status === "skipped";
            const previousDone =
              s.step_id === "review"
                ? isDone(topic.steps.find((step: any) => step.step_id === "title")) &&
                  isDone(topic.steps.find((step: any) => step.step_id === "script"))
                : topic.steps.slice(0, stepIndex).every(isDone);
            const canRunStep = s.status === "pending" && previousDone && s.step_id !== "adapt";
            return (
            <div className="step-card" key={s.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{s.name}</strong>
                <div className="step-header-controls">
                  {s.step_id === "storyboard" && (
                    <>
                      <label className="inline-setting">
                        比例
                        <select value={topic.brief?.aspectRatio ?? "9:16"} onChange={(e) => updateProductionSettings({ aspectRatio: e.target.value })}>
                          {ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </label>
                      <label className="inline-setting">
                        分辨率
                        <select value={topic.brief?.resolution ?? "1080p"} onChange={(e) => updateProductionSettings({ resolution: e.target.value })}>
                          {RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                  {s.step_id === "video" && (
                    <label className="inline-setting">
                      单镜时长
                      <select value={topic.brief?.videoDurationSec ?? 5} onChange={(e) => updateProductionSettings({ videoDurationSec: Number(e.target.value) })}>
                        {[5, 10, 15].map((value) => <option key={value} value={value}>{value} 秒</option>)}
                      </select>
                    </label>
                  )}
                  {canRunStep ? (
                    <button className="small" onClick={() => act(() => executeStep(s), `run-${s.step_id}`)}>
                      运行
                    </button>
                  ) : (
                    <span className={`badge ${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  )}
                </div>
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
                {s.step_id !== "adapt" && (
                  <button className="ghost small" onClick={() => act(() => executeStep(s, true), "rerun")}>
                    重跑
                  </button>
                )}
                {s.status === "waiting_human" && (
                  <button className="small" onClick={() => act(() => api.post(`/api/steps/${s.id}/confirm`), "confirm")}>
                    确认
                  </button>
                )}
              </div>

              {s.step_id === "cover" && (
                <div className="cover-prompt" style={{ marginTop: 8 }}>
                  <div className="muted" style={{ marginBottom: 4 }}>
                    封面提示词（分镜表 index0 自动填入，可手动润色后再运行/重跑；重跑分镜表会刷新为新初稿）
                  </div>
                  <textarea
                    value={coverPrompt}
                    rows={4}
                    style={{ width: "100%", boxSizing: "border-box" }}
                    placeholder="先生成分镜表，或直接在此填写封面出图提示词"
                    onChange={(e) => {
                      coverPromptDirty.current = true;
                      setCoverPrompt(e.target.value);
                    }}
                  />
                  <button
                    className="small"
                    disabled={!coverPrompt.trim()}
                    onClick={() =>
                      act(async () => {
                        await api.put(`/api/topics/${id}/cover-prompt`, { prompt: coverPrompt });
                        coverPromptDirty.current = false;
                      }, "cover-prompt")
                    }
                  >
                    保存提示词
                  </button>
                </div>
              )}

              {s.step_id === "review" && (s.artifacts ?? []).length > 0 && (
                <ReviewPanel
                  artifacts={s.artifacts}
                  onRerunWith={(target: string, feedback: string) => {
                    const targetStep = topic.steps.find((candidate: any) => candidate.step_id === target);
                    if (targetStep) act(() => api.post(`/api/steps/${targetStep.id}/rerun`, { feedback }), "rerun-with-feedback");
                  }}
                />
              )}

              {s.step_id === "adapt" && (
                <div className="adapt-panel" style={{ marginTop: 8 }}>
                  <div className="muted" style={{ marginBottom: 4 }}>选择要分发的平台（同一条母版派生，不重新生成内容）：</div>
                  <div className="platform-options">
                    {platforms.map((p) => (
                      <label key={p.id} className="platform-option">
                        <input
                          type="checkbox"
                          checked={chosenPlatforms.includes(p.id)}
                          onChange={(e) =>
                            setChosenPlatforms((prev) =>
                              e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)
                            )
                          }
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="small"
                      disabled={chosenPlatforms.length === 0 || s.status === "running"}
                      onClick={() => act(() => api.post(`/api/topics/${id}/adapt`, { platforms: chosenPlatforms }), "adapt")}
                    >
                      {s.status === "running" ? "生成中..." : "生成发布包"}
                    </button>
                    {(topic.packages ?? []).length > 0 && (
                      <a href={`/api/topics/${id}/export`} download>
                        📦 导出全部发布包 ZIP
                      </a>
                    )}
                  </div>
                </div>
              )}

              {(s.artifacts ?? []).length > 0 && s.step_id === "title" && (
                <TitleCandidates
                  artifacts={s.artifacts}
                  onSelect={(artifactId) => act(() => api.post(`/api/artifacts/${artifactId}/select`), "select")}
                />
              )}
              {(s.artifacts ?? []).length > 0 && s.step_id === "adapt" && (
                <AdaptArtifacts artifacts={s.artifacts} platforms={platforms} />
              )}
              {(s.artifacts ?? []).length > 0 && s.step_id !== "title" && s.step_id !== "review" && s.step_id !== "adapt" && (
                <div className={`artifacts ${["cover", "frames", "video", "tts", "compose", "adapt"].includes(s.step_id) ? "artifacts-grid" : ""}`}>
                  {s.artifacts.map((a: any) => (
                    <div className={`artifact ${["cover", "frames", "video", "tts", "compose", "adapt"].includes(s.step_id) ? "artifact-media" : ""}`} key={a.id}>
                      <div className="artifact-label">
                        {s.step_id === "cover" && (
                          <input
                            type="radio"
                            name="cover-select"
                            checked={a.selected}
                            onChange={() => act(() => api.post(`/api/artifacts/${a.id}/select`), "select-cover")}
                            title="选为最终封面（发布包会用它派生各平台尺寸）"
                          />
                        )}
                        {a.label ?? a.role ?? a.kind}
                      </div>
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

function AdaptArtifacts({ artifacts, platforms }: { artifacts: any[]; platforms: any[] }) {
  const platformName = new Map(platforms.map((platform) => [platform.id, platform.name]));
  const groups = new Map<string, any[]>();
  for (const artifact of artifacts) {
    const platform = String(artifact.meta?.platform ?? "other");
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform)!.push(artifact);
  }
  const roleOrder: Record<string, number> = { "package-cover": 1, "package-video": 2, "package-copy": 3 };
  return (
    <div className="adapt-artifacts">
      {[...groups.entries()].map(([platform, items]) => (
        <section className="adapt-platform-group" key={platform}>
          <div className="adapt-platform-title">{platformName.get(platform) ?? platform}发布包</div>
          <div className="adapt-platform-row">
            {[...items]
              .sort((a, b) => (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99))
              .map((artifact) => (
                <ArtifactCard artifact={artifact} key={artifact.id} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ArtifactCard({ artifact }: { artifact: any }) {
  return (
    <div className="artifact artifact-media">
      <div className="artifact-label">{artifact.label ?? artifact.role ?? artifact.kind}</div>
      {artifact.content && <pre>{artifact.content}</pre>}
      {artifact.kind === "video" && artifact.file_path && (
        <video className="artifact-video" controls preload="metadata" src={`/api/artifacts/${artifact.id}/file`} />
      )}
      {artifact.kind === "image" && artifact.file_path && (
        <img className="artifact-image" src={`/api/artifacts/${artifact.id}/file`} alt={artifact.label ?? ""} />
      )}
      {artifact.file_path && <a href={`/api/artifacts/${artifact.id}/file`}>打开文件</a>}
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

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "3:4", "4:3"];
const RESOLUTIONS = ["540p", "720p", "1080p", "1K", "2K", "4K"];

function providerMatchesStep(provider: any, stepId: string) {
  const capabilities: string[] = provider.capabilities ?? [];
  const has = (...required: string[]) => required.some((capability) => capabilities.includes(capability));
  const canReturnMedia = provider.realFileOutput || provider.config?.mock;
  if (stepId === "cover" || stepId === "frames") return has("image-generation") && canReturnMedia;
  if (stepId === "video") return has("text-to-video", "image-to-video") && canReturnMedia;
  if (stepId === "tts") return has("tts");
  if (stepId === "compose") return false;
  if (stepId === "analyze") return has("text-generation") && has("image-understanding", "video-understanding");
  return has("text-generation");
}

/** 评审报告：只报告不自动重跑；不合格时提供「按建议重跑」按钮由用户决定 */
function ReviewPanel({ artifacts, onRerunWith }: { artifacts: any[]; onRerunWith: (target: string, feedback: string) => void }) {
  const latest = [...artifacts].reverse().find((a) => a.role === "review" && a.content);
  if (!latest) return null;
  let report: any = null;
  try {
    report = JSON.parse(latest.content);
  } catch {
    return <pre>{latest.content}</pre>;
  }
  const items: any[] = Array.isArray(report?.items) ? report.items : Array.isArray(report) ? report : [];
  const ruleIssues: string[] = report?.ruleIssues ?? [];
  const targetName = (t: string) => (t === "script" ? "口播稿" : "标题");
  return (
    <div className="review-panel" style={{ marginTop: 8 }}>
      {report?.note && <div className="muted">⚠ {report.note}</div>}
      {ruleIssues.length > 0 && (
        <div className="error-text" style={{ margin: "6px 0" }}>
          规则预检命中：
          <ul style={{ margin: "4px 0 0 18px" }}>
            {ruleIssues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      {ruleIssues.length === 0 && items.length > 0 && <div className="muted">规则预检：未命中极限词/敏感词 ✓</div>}
      {items.map((item, i) => (
        <div key={i} style={{ border: "1px solid #333", borderRadius: 6, padding: 8, margin: "6px 0" }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{targetName(item.target)}</strong>
            <span className={`badge ${item.verdict === "pass" ? "succeeded" : "failed"}`}>
              {item.total} 分 · {item.verdict === "pass" ? "通过" : item.verdict === "reject" ? "不合格" : "建议修改"}
            </span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {Object.entries(item.scores ?? {})
              .map(([k, v]) => `${SCORE_LABEL[k] ?? k} ${v}`)
              .join(" · ")}
          </div>
          {(item.issues ?? []).length > 0 && (
            <div style={{ marginTop: 4 }}>
              问题：
              <ul style={{ margin: "2px 0 0 18px" }}>
                {item.issues.map((issue: string, j: number) => (
                  <li key={j}>{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {(item.suggestions ?? []).length > 0 && (
            <div style={{ marginTop: 4 }}>
              建议：
              <ul style={{ margin: "2px 0 0 18px" }}>
                {item.suggestions.map((sug: string, j: number) => (
                  <li key={j}>{sug}</li>
                ))}
              </ul>
            </div>
          )}
          {item.verdict !== "pass" && (item.suggestions ?? []).length > 0 && (
            <button
              className="ghost small"
              style={{ marginTop: 6 }}
              onClick={() => onRerunWith(item.target === "script" ? "script" : "title", item.suggestions.join("；"))}
            >
              按建议重跑{targetName(item.target)}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const SCORE_LABEL: Record<string, string> = {
  hook: "钩子",
  clarity: "清晰",
  platform_fit: "平台适配",
  compliance: "合规",
  seo: "SEO",
};
