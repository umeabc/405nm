import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReadResult, StorageDriver, StorageUsage, StoredObject } from './index.js';

/**
 * 本地磁盘驱动。
 *
 * 两件事必须做对，否则是安全事故而不是 bug：
 *
 * 1. **二次路径穿越校验**。键来自数据库，而数据库里的键最终来自用户上传时的文件名
 *    或迁移脚本 —— 任何一处漏了校验，`../../etc/passwd` 就能读到系统文件。
 *    所以这里不信任调用方：先做字符串层面的拒绝，再在 `path.resolve` 之后
 *    校验结果仍在根目录内（字符串检查能被 `a/../../b` 这类形态绕过，
 *    最终必须落到 resolve 后的真实路径上判断）。
 * 2. **原子写入**。先写同目录下的临时文件再 rename。直接写目标路径的话，
 *    并发读可能读到只写了一半的图（表现为「图片下半截是灰的」），
 *    而 rename 在同一文件系统内是原子的。
 */
export class LocalStorage implements StorageDriver {
  readonly id = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** 把存储键解析成绝对路径；任何可疑形态一律拒绝。 */
  private resolveKey(key: string): string {
    if (!key || key.includes('\0')) {
      throw new Error(`非法的存储键：${JSON.stringify(key)}`);
    }

    // 统一分隔符后再判断：Windows 上 `\` 也是路径分隔符。
    const normalized = key.replace(/\\/g, '/');

    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error(`存储键不能是绝对路径：${key}`);
    }

    const segments = normalized.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`存储键含有非法路径段：${key}`);
    }

    const resolved = path.resolve(this.root, normalized);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`存储键越出根目录：${key}`);
    }
    return resolved;
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const target = this.resolveKey(key);
    await fs.mkdir(path.dirname(target), { recursive: true });

    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, target);
    } catch (err) {
      // 失败时清掉临时文件，别让磁盘上攒一堆半截文件。
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    return { key, size: data.byteLength };
  }

  async openRead(key: string): Promise<ReadResult | null> {
    const target = this.resolveKey(key);
    try {
      const info = await fs.stat(target);
      if (!info.isFile()) return null;
      return { stream: createReadStream(target), size: info.size };
    } catch {
      return null;
    }
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    const target = this.resolveKey(key);
    try {
      return await fs.readFile(target);
    } catch {
      return null;
    }
  }

  async stat(key: string): Promise<{ size: number } | null> {
    const target = this.resolveKey(key);
    try {
      const info = await fs.stat(target);
      return info.isFile() ? { size: info.size } : null;
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    // 键非法时**不抛**：删除路径上的调用多半发生在「数据已经不一致」的清理场景，
    // 让一个坏键把整批清理打断，比跳过它更糟。
    let target: string;
    try {
      target = this.resolveKey(key);
    } catch {
      return;
    }
    await fs.rm(target, { force: true }).catch(() => {});
  }

  async removeMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.remove(key);
  }

  async usage(): Promise<StorageUsage> {
    const started = Date.now();

    // 用 Node 自带的**递归 readdir** 一次拿到整棵目录树：比自己写 walk
    // 少一趟又一趟的系统调用往返。7 万文件的库实测在毫秒级完成这一步。
    //
    // 这里的类型断言是为了绕开 @types/node 的重载推断：`recursive + withFileTypes`
    // 会命中 Buffer 那一支的重载，于是 `parentPath` 被推成 Buffer。
    // 实际返回的是字符串（没传 encoding 就是 utf8），所以按字符串形状声明。
    type WalkEntry = { name: string; parentPath: string; isFile(): boolean };
    let entries: WalkEntry[] = [];
    try {
      entries = (await fs.readdir(this.root, {
        recursive: true,
        withFileTypes: true,
      })) as unknown as WalkEntry[];
    } catch {
      entries = [];
    }

    const filePaths: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // recursive 模式下 dirent 带 parentPath，用它拼回完整路径。
      filePaths.push(path.join(entry.parentPath ?? this.root, entry.name));
    }

    // stat 是逐文件的系统调用，这里用固定并发池压住开销：
    // 并发太多会把磁盘 IO 打满、拖慢邻居容器；太少则要等很久。
    let usedBytes = 0;
    let objectCount = 0;
    const POOL = 8;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= filePaths.length) return;
        try {
          const info = await fs.stat(filePaths[index]!);
          usedBytes += info.size;
          objectCount += 1;
        } catch {
          // 统计期间文件被删掉很正常，跳过即可。
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(POOL, filePaths.length) }, worker));

    const [totalBytes, availableBytes] = await this.diskSpace();

    return {
      usedBytes,
      totalBytes,
      availableBytes,
      objectCount,
      elapsedMs: Date.now() - started,
    };
  }

  /** 磁盘总量与余量。拿不到就返回 null —— 看板上少一行，好过整个接口 500。 */
  private async diskSpace(): Promise<[number | null, number | null]> {
    try {
      const stats = await fs.statfs(this.root);
      return [stats.blocks * stats.bsize, stats.bavail * stats.bsize];
    } catch {
      return [null, null];
    }
  }
}
