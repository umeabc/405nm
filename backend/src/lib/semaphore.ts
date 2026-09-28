/**
 * 并发闸门。
 *
 * 单独成文件是因为它已经被两处用到，而两处的**理由完全不同**：
 *
 *  - 图片处理（`lib/image.ts`）：libvips 解码一张大图的峰值内存是
 *    「宽 × 高 × 通道数」，不设上限时十来张并发就能把 256MB 的容器打爆。
 *  - 图源抓取（`sourcing/http.ts`）：并发太高会被上游判定为爬虫，
 *    而且一次导入动辄上百张图，无节制地开连接会先把出口代理压垮。
 *
 * 两处的**实现**却一模一样，所以抽出来共用 —— 各写一份的话，
 * 「等待队列怎么唤醒」这种细节会在某一次修改后于两边产生不同的行为。
 *
 * 语义：先进先出。`run()` 在槽位满时排队，任务结束后唤醒队首。
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`并发上限必须是 >= 1 的整数，收到 ${limit}`);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}
