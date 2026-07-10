import { useEffect, useState } from "react";
import { api } from "../api";

const KIND_LABEL: Record<string, string> = {
  cli: "CLI 命令行",
  "api-text": "文本 API",
  "api-image": "出图 API",
  "api-video": "视频 API",
  tts: "TTS 配音",
};

export function Providers() {
  const [providers, setProviders] = useState<any[]>([]);
  const [health, setHealth] = useState<Record<string, any>>({});
  const [editing, setEditing] = useState<any>(null);
  const [error, setError] = useState("");

  const load = () => api.get<any[]>("/api/providers").then(setProviders).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const checkHealth = async (id: string) => {
    setHealth((prev) => ({ ...prev, [id]: { detail: "检测中…" } }));
    const result = await api.post<any>(`/api/providers/${id}/health`).catch((e) => ({ ok: false, detail: e.message }));
    setHealth((prev) => ({ ...prev, [id]: result }));
  };

  const save = async () => {
    try {
      setError("");
      const config = JSON.parse(editing.configText);
      await api.put(`/api/providers/${editing.id}`, {
        id: editing.id,
        kind: editing.kind,
        name: editing.name,
        config,
        maxConcurrency: Number(editing.maxConcurrency) || 1,
        enabled: editing.enabled,
      });
      setEditing(null);
      load();
    } catch (e: any) {
      setError(`保存失败：${e.message}`);
    }
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h2>引擎管理</h2>
        <button
          onClick={() =>
            setEditing({ id: "", kind: "cli", name: "", configText: '{\n  "command": "mytool -p {PROMPT_FILE}"\n}', maxConcurrency: 1, enabled: true, isNew: true })
          }
        >
          ＋ 添加引擎
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>名称</th>
              <th>类型</th>
              <th>并发</th>
              <th>状态</th>
              <th>健康检查</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.name}</td>
                <td>{KIND_LABEL[p.kind] ?? p.kind}</td>
                <td>{p.maxConcurrency}</td>
                <td>{p.enabled ? "✅ 启用" : "⛔ 停用"}</td>
                <td>
                  <button className="ghost small" onClick={() => checkHealth(p.id)}>
                    检测
                  </button>
                  {health[p.id] && (
                    <span style={{ marginLeft: 8, color: health[p.id].ok ? "var(--green)" : "var(--red)" }}>
                      {health[p.id].detail}
                    </span>
                  )}
                </td>
                <td>
                  <button
                    className="ghost small"
                    onClick={() =>
                      setEditing({ ...p, configText: JSON.stringify(p.config, null, 2), isNew: false })
                    }
                  >
                    编辑
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card">
          <h3>{editing.isNew ? "添加引擎" : `编辑：${editing.id}`}</h3>
          <label>ID（唯一，保存后不可改）</label>
          <input value={editing.id} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, id: e.target.value })} />
          <label>名称</label>
          <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <label>类型</label>
          <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <label>
            配置 JSON（CLI: command/healthCommand，支持 {"{PROMPT} {PROMPT_FILE} {OUTPUT_FILE}"}；API: baseUrl/apiKey/model）
          </label>
          <textarea rows={6} value={editing.configText} onChange={(e) => setEditing({ ...editing, configText: e.target.value })} />
          <label>最大并发</label>
          <input
            type="number"
            min={1}
            value={editing.maxConcurrency}
            onChange={(e) => setEditing({ ...editing, maxConcurrency: e.target.value })}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            启用
          </label>
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={!editing.id || !editing.name} onClick={save}>
              保存
            </button>
            <button className="ghost" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
