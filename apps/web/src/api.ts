async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body: unknown) => request<T>(url, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
  async upload<T>(url: string, files: FileList | File[], note?: string): Promise<T> {
    const fd = new FormData();
    if (note) fd.append("note", note);
    for (const f of Array.from(files)) fd.append("file", f);
    const res = await fetch(url, { method: "POST", body: fd });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as any).error || `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  },
};

export function connectWs(onEvent: (event: any) => void): () => void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data));
      } catch {
        // 忽略坏帧
      }
    };
    ws.onclose = () => {
      if (!closed) setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    closed = true;
    ws?.close();
  };
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "待执行",
  running: "运行中",
  waiting_human: "等待人工",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
