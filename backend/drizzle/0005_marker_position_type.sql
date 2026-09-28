-- 标号不再分 box / pin：它现在一律是「点」，取而代之的分类是「框内 / 框外」。
--
-- 三件事必须按这个顺序做：
--   1. 先加列并给出默认值，存量行立刻就有值，不存在中间态；
--   2. 再把旧的矩形几何**折算成中心点**并存进 x/y，然后清掉 w/h。
--      不折算的话，旧框的标记会跑到原来的左上角去 —— 视觉上是「标号集体左移上移」；
--   3. 最后才丢掉 kind。反过来先丢，就没法知道哪些行是矩形了。
--
-- w/h 折算前可能让中心越界（框本来就越过图片右边界），所以夹进 [0,1]。
ALTER TABLE "sources" ADD COLUMN "position_type" text DEFAULT 'in' NOT NULL;--> statement-breakpoint
UPDATE "sources" SET
  "x" = LEAST(1, GREATEST(0, "x" + "w" / 2)),
  "y" = LEAST(1, GREATEST(0, "y" + "h" / 2)),
  "w" = 0,
  "h" = 0
WHERE "w" <> 0 OR "h" <> 0;--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN "kind";
