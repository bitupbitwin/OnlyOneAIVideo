import fs from "node:fs";
import sharp from "sharp";

/** 为工作台生成轻量预览图；自动旋转手机照片，不放大原图。 */
export async function ensureImageThumbnail(source: string, destination: string): Promise<void> {
  const sourceStat = fs.statSync(source);
  if (fs.existsSync(destination) && fs.statSync(destination).mtimeMs >= sourceStat.mtimeMs) return;
  await sharp(source)
    .rotate()
    .resize({ width: 360, height: 240, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 62, progressive: true })
    .toFile(destination);
}

/**
 * 生成供多模态模型读取的标准副本：最长边不超过 2048，JPEG，目标不超过约 4MB。
 * 原图始终保留，分析与上传只使用这个副本。
 */
export async function ensureAnalysisImage(source: string, destination: string): Promise<void> {
  const sourceStat = fs.statSync(source);
  if (fs.existsSync(destination) && fs.statSync(destination).mtimeMs >= sourceStat.mtimeMs) return;
  const pipeline = sharp(source)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  let output = await pipeline.clone().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  if (output.length > 4 * 1024 * 1024) output = await pipeline.clone().jpeg({ quality: 70, mozjpeg: true }).toBuffer();
  if (output.length > 4 * 1024 * 1024) output = await pipeline.clone().jpeg({ quality: 58, mozjpeg: true }).toBuffer();
  fs.writeFileSync(destination, output);
}
