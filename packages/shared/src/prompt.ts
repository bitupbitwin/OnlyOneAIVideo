/**
 * 极简模板渲染：支持 {{a.b.c}} 路径取值，缺失值渲染为空串。
 */
export function renderTemplate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split(".").reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), vars);
    if (value == null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}
