import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, connectWs, STATUS_LABEL } from "../api";

export function PipelineBoard() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [streams, setStreams] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval>>();

  const load = useCallback(() => {
    api.get<any>(`/api/pipelines/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
    api.get<any[]>("/api/providers").then(setProviders).catch(() => undefined);
    timer.current = setInterval(load, 2500);
    const close = connectWs((event) => {
      if (String(event.pipelineId) !== String(id)) return;
      if (event.type === "step-stream") {
        setStreams((prev) => ({
          ...prev,
          [event.stepId]: ((prev[event.stepId] ?? "") + event.data.chunk).slice(-4000),
        }));
      } else {
        load();
      }
    });
    return () => {
      clearInterval(timer.current);
      close();
    };
  }, [id, load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (!data) return <div className="page">{error || "加载中…"}</div>;

  const textProviders = providers.filter((p) => p.enabled && (p.kind === "cli" || p.kind === "api-text" || p.kind === "web"));
  const imageProviders = providers.filter((p) => p.enabled && p.kind === "api-image");

  return (
    <div className="page">
      <p className="muted">
        <Link to={`/project/${data.project_id}`}>← 返回项目</Link>
      </p>
      <div className="row" style={{ justifyContent: "space-between", margin: "10px 0 16px" }}>
        <h2>
          {data.name} <span className={`badge ${data.status}`}>{STATUS_LABEL[data.status] ?? data.status}</span>
        </h2>
        <div className="row">
          <a href={`/api/pipelines/${id}/export`} download>
            <button className="ghost">📦 导出产物包</button>
          </a>
          <button className="ghost" onClick={() => act(() => api.post(`/api/pipelines/${id}/run`, { auto: false }))}>
            ▶ 运行（标题人工挑选）
          </button>
          <button
            title="跳过人工卡点：标题自动采用推荐度第一的候选；评审不通过会自动按建议重生成一轮"
            onClick={() => act(() => api.post(`/api/pipelines/${id}/run`, { auto: true }))}
          >
            ⚡ 全自动运行
          </button>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}

      {data.steps.map((step: any) => (
        <StepCard
          key={step.id}
          step={step}
          stream={streams[step.id]}
          reviews={data.reviews.filter((r: any) => r.step_id === step.id)}
          providerOptions={step.type === "cover" ? imageProviders : textProviders}
          onSetProvider={(pid) => act(() => api.post(`/api/steps/${step.id}/provider`, { providerId: pid }))}
          onRerun={() => act(() => api.post(`/api/steps/${step.id}/rerun`))}
          onSelect={(aid) => act(() => api.post(`/api/artifacts/${aid}/select`))}
          onConfirm={() => act(() => api.post(`/api/steps/${step.id}/confirm`))}
          onRegenerate={(target, feedback) => {
            const targetStep = data.steps.find((s: any) => s.type === target);
            if (targetStep) act(() => api.post(`/api/steps/${targetStep.id}/rerun`, { feedback }));
          }}
          onManualDone={load}
        />
      ))}

      {data.notes?.length > 0 && (
        <div className="card">
          <h3>📋 发布注意事项（手动发布前逐条核对）</h3>
          <ul className="notes">
            {data.notes.map((note: string, i: number) => (
              <li key={i}>
                <label style={{ display: "inline", color: "inherit" }}>
                  <input type="checkbox" style={{ width: "auto", marginRight: 8 }} />
                  {note}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StepCard(props: {
  step: any;
  stream?: string;
  reviews: any[];
  providerOptions: any[];
  onSetProvider: (pid: string) => void;
  onRerun: () => void;
  onSelect: (aid: number) => void;
  onConfirm: () => void;
  onRegenerate: (target: string, feedback: string) => void;
  onManualDone: () => void;
}) {
  const { step, stream, reviews, providerOptions } = props;
  const [showPrompt, setShowPrompt] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPrompt, setManualPrompt] = useState("");
  const [manualText, setManualText] = useState("");
  const [manualErr, setManualErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const canManual = ["title", "content", "cover"].includes(step.type);

  const copyShownPrompt = async () => {
    try {
      await navigator.clipboard.writeText(step.prompt_rendered ?? "");
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    } catch {
      /* 复制失败时用户可手动选中下方文本复制 */
    }
  };

  const openManual = async () => {
    setManualOpen(!manualOpen);
    setManualErr("");
    if (!manualOpen && !manualPrompt) {
      const r = await api.post<any>(`/api/steps/${step.id}/render-prompt`).catch((e) => ({ error: e.message }));
      setManualPrompt(r.prompt ?? "");
      if (r.error) setManualErr(r.error);
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(manualPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setManualErr("复制失败，请手动选中下方文本复制");
    }
  };
  const submitText = async () => {
    setBusy(true);
    setManualErr("");
    try {
      await api.post(`/api/steps/${step.id}/manual-text`, { content: manualText });
      setManualOpen(false);
      setManualText("");
      props.onManualDone();
    } catch (e: any) {
      setManualErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submitImage = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setManualErr("");
    try {
      await api.upload(`/api/steps/${step.id}/manual-image`, files);
      setManualOpen(false);
      props.onManualDone();
    } catch (e: any) {
      setManualErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`step-card ${step.status}`} style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <h3>{step.name}</h3>
          <span className={`badge ${step.status}`}>{STATUS_LABEL[step.status] ?? step.status}</span>
          {step.needs.length > 0 && <span className="muted">依赖：{step.needs.join("、")}</span>}
        </div>
        <div className="row">
          <select
            style={{ width: 240 }}
            value={step.provider_id ?? ""}
            onChange={(e) => props.onSetProvider(e.target.value)}
          >
            <option value="" disabled>
              选择引擎…
            </option>
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="ghost small" onClick={props.onRerun} disabled={step.status === "running"}>
            {step.status === "pending" ? "等待依赖/运行" : "重跑"}
          </button>
          {step.prompt_rendered && (
            <button className="ghost small" onClick={() => setShowPrompt(!showPrompt)}>
              Prompt
            </button>
          )}
          {canManual && (
            <button className="ghost small" onClick={openManual} title="对自动结果不满意？拿提示词去 GPT/Gemini 手动生成，再粘贴回填">
              ✍️ 我自己做
            </button>
          )}
        </div>
      </div>

      {showPrompt && (
        <div className="artifact">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <strong className="muted">本步骤渲染后的提示词（含平台风格 / 字数等参数）</strong>
            <button className="ghost small" onClick={copyShownPrompt}>
              {promptCopied ? "已复制 ✓" : "📋 复制提示词"}
            </button>
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{step.prompt_rendered}</div>
        </div>
      )}

      {manualOpen && (
        <div className="artifact" style={{ borderColor: "var(--accent)" }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <strong>✍️ 人工接管 —— 复制提示词去 GPT / Gemini 手动生成，再把结果回填到下方</strong>
            <button className="ghost small" onClick={copyPrompt}>
              {copied ? "已复制 ✓" : "📋 复制提示词"}
            </button>
          </div>
          <textarea readOnly rows={6} value={manualPrompt} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
          {step.type === "cover" ? (
            <div style={{ marginTop: 10 }}>
              <p className="muted" style={{ marginBottom: 6 }}>
                把你在外部生成好的封面图上传回来（可多选，会自动派生各平台尺寸）：
              </p>
              <label
                className="ghost"
                style={{ display: "inline-block", padding: "8px 14px", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer" }}
              >
                {busy ? "上传中…" : "⬆ 上传我做好的封面图"}
                <input type="file" accept="image/*" multiple disabled={busy} style={{ display: "none" }} onChange={(e) => submitImage(e.target.files)} />
              </label>
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <p className="muted" style={{ marginBottom: 6 }}>
                把外部模型生成的{step.type === "title" ? "标题（一行一个，或直接粘贴 JSON 数组）" : "内容"}粘贴到这里：
              </p>
              <textarea rows={5} value={manualText} onChange={(e) => setManualText(e.target.value)} placeholder="粘贴你满意的结果…" />
              <div style={{ marginTop: 8 }}>
                <button disabled={busy || !manualText.trim()} onClick={submitText}>
                  {busy ? "回填中…" : "✓ 回填工作区并继续后续流程"}
                </button>
              </div>
            </div>
          )}
          {manualErr && <div className="error-text">{manualErr}</div>}
        </div>
      )}
      {step.error && <div className="error-text">❌ {step.error}</div>}
      {stream && step.status === "running" && <div className="stream">{stream}</div>}

      {step.status === "waiting_human" && (
        <p style={{ marginTop: 10, color: "var(--yellow)" }}>
          ⏸ 请在下方候选中点选一个，然后点击「确认选择，继续流程」
        </p>
      )}

      <Artifacts step={step} onSelect={props.onSelect} onChanged={props.onManualDone} />

      {step.status === "waiting_human" && (
        <div style={{ marginTop: 10 }}>
          <button onClick={props.onConfirm} disabled={!step.artifacts.some((a: any) => a.selected)}>
            确认选择，继续流程
          </button>
        </div>
      )}

      {reviews.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {reviews.map((review) => (
            <div className="artifact" key={review.id}>
              <strong>
                {review.target === "title" ? "标题" : review.target === "content" ? "内容" : review.target}评审
                {review.provider_id === "rule:keywords" ? "（规则预检）" : ""}：
                <span className={`badge ${review.verdict === "pass" ? "succeeded" : "failed"}`} style={{ marginLeft: 6 }}>
                  {review.verdict} {review.total ? `${review.total}分` : ""}
                </span>
              </strong>
              {Object.keys(review.scores).length > 0 && (
                <div className="score-bar">
                  {Object.entries(review.scores).map(([k, v]) => (
                    <span className="score-item" key={k}>
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
              )}
              {review.issues.map((issue: string, i: number) => (
                <p key={i} style={{ color: "var(--red)" }}>
                  ⚠ {issue}
                </p>
              ))}
              {review.suggestions.map((s: string, i: number) => (
                <p key={i} style={{ color: "var(--green)" }}>
                  💡 {s}
                </p>
              ))}
              {["title", "content", "cover"].includes(review.target) &&
                (review.issues.length > 0 || review.suggestions.length > 0) && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="ghost small"
                      onClick={() =>
                        props.onRegenerate(
                          review.target,
                          [...review.issues.map((x: string) => `问题：${x}`), ...review.suggestions.map((x: string) => `建议：${x}`)].join("\n")
                        )
                      }
                    >
                      🔄 按建议重新生成{review.target === "title" ? "标题" : review.target === "content" ? "内容" : "封面"}
                    </button>
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Artifacts({ step, onSelect, onChanged }: { step: any; onSelect: (aid: number) => void; onChanged?: () => void }) {
  const artifacts: any[] = step.artifacts ?? [];
  if (artifacts.length === 0) return null;
  const latestVersion = Math.max(...artifacts.map((a) => a.version));
  const visible = artifacts.filter((a) => a.version === latestVersion);
  const isBatch = step.type === "batch-images";
  const [busy, setBusy] = useState<number | null>(null);
  const cacheKey = (a: any) => encodeURIComponent(String(a.file_path ?? "").slice(-48));

  const reroll = async (aid: number) => {
    setBusy(aid);
    try {
      await api.post(`/api/artifacts/${aid}/reroll`);
      onChanged?.();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };
  const replace = async (aid: number, files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(aid);
    try {
      await api.upload(`/api/artifacts/${aid}/replace`, files);
      onChanged?.();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: 6 }}>
      <p className="muted" style={{ marginTop: 8 }}>
        产物（v{latestVersion}
        {isBatch ? `，共 ${visible.length} 张，可对单张重抽/替换` : "，点击文本/图片可设为选中"}）：
      </p>
      <div className={step.type === "cover" || isBatch ? "grid" : ""}>
        {visible.map((a) => (
          <div
            key={a.id}
            className={`artifact ${a.selected && !isBatch ? "selected" : ""}`}
            style={{ cursor: isBatch ? "default" : "pointer" }}
            onClick={() => !isBatch && onSelect(a.id)}
            title={isBatch ? a.label : a.selected ? "当前选中" : "点击选中"}
          >
            {a.label && <p className="muted">{a.label} {a.selected && !isBatch ? "✓ 已选" : ""}</p>}
            {!a.label && a.selected && <p className="muted">✓ 已选</p>}
            {a.kind === "image" && a.file_path && (
              <img src={`/api/artifacts/${a.id}/file?v=${cacheKey(a)}`} alt={a.label ?? ""} />
            )}
            {a.kind === "text" && a.content}
            {a.kind === "file" && <span>📁 {a.file_path}</span>}
            {isBatch && a.kind === "image" && (
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="ghost small" disabled={busy === a.id} onClick={() => reroll(a.id)}>
                  {busy === a.id ? "…" : "🎲 重抽"}
                </button>
                <label className="ghost small" style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border)", cursor: "pointer" }}>
                  ⬆ 替换
                  <input type="file" accept="image/*" style={{ display: "none" }} disabled={busy === a.id} onChange={(e) => replace(a.id, e.target.files)} />
                </label>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
