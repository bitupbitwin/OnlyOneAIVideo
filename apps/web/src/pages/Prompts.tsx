import { useEffect, useState } from "react";
import { api } from "../api";

export function Prompts() {
  const [list, setList] = useState<Array<{ path: string; overridden: boolean }>>([]);
  const [current, setCurrent] = useState<string>("");
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");

  const load = () => api.get<any[]>("/api/prompts").then(setList).catch((e) => setMessage(e.message));
  useEffect(() => {
    load();
  }, []);

  const open = async (path: string) => {
    setMessage("");
    setCurrent(path);
    const data = await api.get<{ content: string }>(`/api/prompts/content?path=${encodeURIComponent(path)}`);
    setContent(data.content);
  };

  const save = async () => {
    await api.put("/api/prompts/content", { path: current, content });
    setMessage("✅ 已保存（覆盖内置模板）");
    load();
  };

  const reset = async () => {
    await api.del(`/api/prompts/content?path=${encodeURIComponent(current)}`);
    setMessage("已恢复内置默认模板");
    await open(current);
    load();
  };

  return (
    <div className="page">
      <h2>Prompt 模板管理</h2>
      <p className="muted" style={{ margin: "6px 0 14px" }}>
        模板按「平台/模式/步骤」组织。修改后立即生效；标⭐的表示已被你覆盖，可随时恢复默认。
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
        <div className="card" style={{ maxHeight: "70vh", overflow: "auto" }}>
          {list.map((p) => (
            <div
              key={p.path}
              onClick={() => open(p.path)}
              style={{
                padding: "7px 8px",
                cursor: "pointer",
                borderRadius: 6,
                background: current === p.path ? "var(--panel2)" : "transparent",
              }}
            >
              {p.overridden ? "⭐ " : ""}
              {p.path}
            </div>
          ))}
        </div>
        <div className="card">
          {current ? (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                <h3>{current}</h3>
                <div className="row">
                  <button onClick={save}>保存</button>
                  <button className="ghost" onClick={reset}>
                    恢复默认
                  </button>
                </div>
              </div>
              <textarea rows={24} value={content} onChange={(e) => setContent(e.target.value)} />
              {message && <p style={{ marginTop: 8, color: "var(--green)" }}>{message}</p>}
            </>
          ) : (
            <p className="muted">从左侧选择一个模板进行编辑。可用变量：{"{{brief.topic}} {{brief.audience}} {{steps.title.selected}} {{steps.content.selected}} {{platform}} {{mode}}"}</p>
          )}
        </div>
      </div>
    </div>
  );
}
