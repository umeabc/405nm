/**
 * 第四步：标号与译文。
 *
 * 这两张是最大的表，所以**边读边写**：按批次生成、按批次插入，内存里只有一批。
 * 生成的判定（哪些标号要迁、哪份译文被选中）与计划阶段是同一套函数，
 * 计划里报出的有损点因此覆盖得住这里实际写下去的行。
 */
import { db } from '../db/client.js';
import { sources, translations } from '../db/schema.js';
import type { Ctx } from './plan.js';
import { sourceBatches, translationBatches } from './plan-content.js';
import { Report } from './report.js';
import type { Derived } from './rows.js';
import { insertById } from './util.js';

const CONTENT_CHUNK = 1000;

export async function stepContent(ctx: Ctx, _d: Derived): Promise<void> {
  const { exp, plan, report, content } = ctx;
  const sink = new Report(true);

  let sourceInserted = 0;
  for await (const batch of sourceBatches(exp, plan, CONTENT_CHUNK)) {
    sourceInserted += await insertById(db, sources as never, batch, sink, 'sources');
  }
  report.count('sources', content.sourceCount, sourceInserted, content.sourceCount - sourceInserted);

  let translationInserted = 0;
  for await (const batch of translationBatches(exp, plan, CONTENT_CHUNK)) {
    translationInserted += await insertById(db, translations as never, batch, sink, 'translations');
  }
  report.count('translations', content.translationCount, translationInserted, content.translationCount - translationInserted);
}
