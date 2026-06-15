-- Idempotent DML seed: adds the 乳品 (dairy) subtree + its category_closure
-- rows, and flips comparable_unit=per_100ml onto each 酒种 (alcohol) leaf. Applied
-- to production by `wrangler d1 migrations apply` (directory scan), like 0004. The
-- dairy node/leaf/closure rows use INSERT OR IGNORE (re-apply is a no-op). The 酒种
-- leaves already exist in prod (seeded by 0004 with comparable_unit=NULL), and
-- INSERT OR IGNORE on an existing row is a no-op that does NOT flip the column —
-- so an explicit idempotent UPDATE is REQUIRED to converge NULL→per_100ml.
-- Equivalent to seed.ts `seedTaxonomy()` (asserted by a drift test). The 乳品
-- leaves (milk/yogurt/lactic-drink)
-- carry comparable_unit=NULL and inherit per_100ml from 乳品 (same pattern as the
-- soft-drink leaves). Deterministic ids (tag_<slug> / clo_<tagSlug>__<ancestorSlug>)
-- so a re-run targets the same rows. NOT registered in drizzle meta/_journal.json:
-- wrangler applies it by directory scan, and keeping it out of the journal stops
-- `drizzle-kit generate` from treating it as drift (same as 0004).
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_dairy', 'dairy', '乳品', 'category', 'tag_beverage', 'per_100ml');
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_milk', 'milk', '牛奶', 'category', 'tag_dairy', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_yogurt', 'yogurt', '酸奶', 'category', 'tag_dairy', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_lactic-drink', 'lactic-drink', '乳酸菌饮料', 'category', 'tag_dairy', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_dairy__dairy', 'tag_dairy', 'tag_dairy');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_dairy__beverage', 'tag_dairy', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_milk__milk', 'tag_milk', 'tag_milk');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_milk__dairy', 'tag_milk', 'tag_dairy');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_milk__beverage', 'tag_milk', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_yogurt__yogurt', 'tag_yogurt', 'tag_yogurt');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_yogurt__dairy', 'tag_yogurt', 'tag_dairy');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_yogurt__beverage', 'tag_yogurt', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_lactic-drink__lactic-drink', 'tag_lactic-drink', 'tag_lactic-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_lactic-drink__dairy', 'tag_lactic-drink', 'tag_dairy');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_lactic-drink__beverage', 'tag_lactic-drink', 'tag_beverage');
--> statement-breakpoint
UPDATE `tag` SET `comparable_unit` = 'per_100ml' WHERE `slug` IN ('baijiu', 'wine', 'spirits', 'whisky', 'beer', 'sake-fruit-wine');
