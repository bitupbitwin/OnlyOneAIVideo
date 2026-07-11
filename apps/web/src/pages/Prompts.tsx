import { useEffect, useState } from "react";
import { api } from "../api";

export function Prompts() {
  const [list, setList] = useState<Array<{ path: string; overridden: boolean }>>([]);
  const [current, setCurrent] = useState<string>("");
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("all");

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

  const filtered = list.filter((item) => category === "all" || promptCategory(item.path) === category);

  const chooseCategory = (value: string) => {
    setCategory(value);
    if (current && value !== "all" && promptCategory(current) !== value) {
      setCurrent("");
      setContent("");
    }
  };

  return (
    <div className="page">
      <h2>平台模板管理</h2>
      <p className="muted" style={{ margin: "6px 0 14px" }}>
        模板按「平台/模式/步骤」组织。先选择平台快速定位；修改后立即生效，标⭐表示已被覆盖。
      </p>
      <div className="prompt-category-bar card">
        <label className="inline-setting">
          平台分类
          <select value={category} onChange={(event) => chooseCategory(event.target.value)}>
            {PROMPT_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <span className="muted">当前显示 {filtered.length} 个模板</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
        <div className="card" style={{ maxHeight: "70vh", overflow: "auto" }}>
          {filtered.map((p) => (
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

const PROMPT_CATEGORIES = [
  { id: "all", label: "全部平台" },
  { id: "common", label: "通用基础模板" },
  { id: "douyin", label: "抖音" },
  { id: "bilibili", label: "哔哩哔哩" },
  { id: "xiaohongshu", label: "小红书" },
  { id: "wechat-channels", label: "微信视频号" },
  { id: "wechat-mp", label: "微信公众号" },
  { id: "csdn", label: "CSDN" },
  { id: "mv", label: "MV" },
];

function promptCategory(path: string): string {
  const first = path.split("/")[0];
  return PROMPT_CATEGORIES.some((item) => item.id === first) ? first : "common";
}
