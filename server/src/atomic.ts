import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';

/**
 * 原子写入（借鉴 iLab atomic_files.py）：
 * 写临时文件 → rename 到目标。进程崩溃不会留下半截文件；
 * 旧版 iLab 还 fsync 目录，Node 侧以 rename 原子性为主（同一文件系统）。
 */
export async function atomicWriteFile(targetPath: string, data: Buffer): Promise<void> {
  const tmpPath = join(dirname(targetPath), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, targetPath);
  } catch (e) {
    // 清理残留临时文件
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
}
