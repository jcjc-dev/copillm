import fs from "node:fs";
import path from "node:path";

export function ensureSecureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  applyModeIfSupported(dirPath, 0o700);
}

export function writeFileSecureAtomic(filePath: string, content: string, mode: number): void {
  ensureSecureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, { mode });
  applyModeIfSupported(tempPath, mode);
  replaceFile(tempPath, filePath);
  applyModeIfSupported(filePath, mode);
}

export function applyModeIfSupported(targetPath: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    fs.chmodSync(targetPath, mode);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
  }
}

function replaceFile(sourcePath: string, destinationPath: string): void {
  if (process.platform !== "win32") {
    fs.renameSync(sourcePath, destinationPath);
    return;
  }
  if (fs.existsSync(destinationPath)) {
    fs.unlinkSync(destinationPath);
  }
  fs.renameSync(sourcePath, destinationPath);
}
