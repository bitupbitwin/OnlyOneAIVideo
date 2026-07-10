import fs from "node:fs";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

export interface DocxSection {
  heading: string;
  body: string;
}

/**
 * 把若干「标题 + 正文」段落写成 .docx 提示词文档。
 * 正文按行拆分为段落，保留原始换行；返回写盘后的文件路径。
 */
export async function writePromptDocx(
  outDir: string,
  fileName: string,
  title: string,
  sections: DocxSection[]
): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: "" }),
  ];

  for (const sec of sections) {
    children.push(new Paragraph({ text: sec.heading, heading: HeadingLevel.HEADING_1 }));
    for (const line of (sec.body ?? "").split("\n")) {
      children.push(new Paragraph({ children: [new TextRun(line)] }));
    }
    children.push(new Paragraph({ text: "" }));
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  const file = path.join(outDir, fileName);
  fs.writeFileSync(file, buf);
  return file;
}

/** 写一个 .srt 文件（内容已是 SRT 文本），顺便做基础校验/规整 */
export function writeSrt(outDir: string, fileName: string, srtText: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, fileName);
  // 去掉可能的代码块围栏，统一换行
  const clean = srtText.replace(/```(?:srt)?/gi, "").replace(/\r\n/g, "\n").trim() + "\n";
  fs.writeFileSync(file, clean, "utf-8");
  return file;
}
