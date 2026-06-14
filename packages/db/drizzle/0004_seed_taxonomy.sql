-- Idempotent DML seed for the canonical taxonomy (DDL lives in 0003). Applied to
-- production by `wrangler d1 migrations apply` (directory scan) so the category
-- tree, attributes, category_closure, and Sam store_category_map exist in prod —
-- without it the deployed DB has empty tables and the whole categorization feature
-- is inert. Equivalent to seed.ts `seedTaxonomy()` (asserted by a drift test);
-- INSERT OR IGNORE on each natural unique key makes a re-apply a no-op. Tags are
-- ordered root→child so `parent_id` self-references resolve with FK enforcement on.
-- Deterministic ids (tag_<slug> / clo_<tagSlug>__<ancestorSlug> / scm_sam_<nativeId>)
-- so a re-run targets the same rows. NOT registered in drizzle meta/_journal.json:
-- wrangler applies it by directory scan, and keeping it out of the journal stops
-- `drizzle-kit generate` from treating it as drift.
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_beverage', 'beverage', '饮料', 'category', NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_soft-drink', 'soft-drink', '软饮', 'category', 'tag_beverage', 'per_100ml');
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_carbonated', 'carbonated', '碳酸饮料', 'category', 'tag_soft-drink', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_juice-plant', 'juice-plant', '果汁·植物饮', 'category', 'tag_soft-drink', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_coffee-tea', 'coffee-tea', '咖啡·茶饮', 'category', 'tag_soft-drink', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_drinking-water', 'drinking-water', '饮用水', 'category', 'tag_soft-drink', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_alcohol', 'alcohol', '酒类', 'category', 'tag_beverage', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_baijiu', 'baijiu', '白酒', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_wine', 'wine', '葡萄酒', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_spirits', 'spirits', '洋酒', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_whisky', 'whisky', '威士忌', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_beer', 'beer', '啤酒', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_sake-fruit-wine', 'sake-fruit-wine', '清酒果酒', 'category', 'tag_alcohol', NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_sugar-free', 'sugar-free', '无糖', 'attribute', NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_sparkling', 'sparkling', '气泡', 'attribute', NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `tag` (`id`, `slug`, `name`, `kind`, `parent_id`, `comparable_unit`) VALUES ('tag_imported', 'imported', '进口', 'attribute', NULL, NULL);
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_beverage__beverage', 'tag_beverage', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_soft-drink__soft-drink', 'tag_soft-drink', 'tag_soft-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_soft-drink__beverage', 'tag_soft-drink', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_carbonated__carbonated', 'tag_carbonated', 'tag_carbonated');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_carbonated__soft-drink', 'tag_carbonated', 'tag_soft-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_carbonated__beverage', 'tag_carbonated', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_juice-plant__juice-plant', 'tag_juice-plant', 'tag_juice-plant');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_juice-plant__soft-drink', 'tag_juice-plant', 'tag_soft-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_juice-plant__beverage', 'tag_juice-plant', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_coffee-tea__coffee-tea', 'tag_coffee-tea', 'tag_coffee-tea');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_coffee-tea__soft-drink', 'tag_coffee-tea', 'tag_soft-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_coffee-tea__beverage', 'tag_coffee-tea', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_drinking-water__drinking-water', 'tag_drinking-water', 'tag_drinking-water');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_drinking-water__soft-drink', 'tag_drinking-water', 'tag_soft-drink');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_drinking-water__beverage', 'tag_drinking-water', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_alcohol__alcohol', 'tag_alcohol', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_alcohol__beverage', 'tag_alcohol', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_baijiu__baijiu', 'tag_baijiu', 'tag_baijiu');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_baijiu__alcohol', 'tag_baijiu', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_baijiu__beverage', 'tag_baijiu', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_wine__wine', 'tag_wine', 'tag_wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_wine__alcohol', 'tag_wine', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_wine__beverage', 'tag_wine', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_spirits__spirits', 'tag_spirits', 'tag_spirits');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_spirits__alcohol', 'tag_spirits', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_spirits__beverage', 'tag_spirits', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_whisky__whisky', 'tag_whisky', 'tag_whisky');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_whisky__alcohol', 'tag_whisky', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_whisky__beverage', 'tag_whisky', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_beer__beer', 'tag_beer', 'tag_beer');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_beer__alcohol', 'tag_beer', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_beer__beverage', 'tag_beer', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_sake-fruit-wine__sake-fruit-wine', 'tag_sake-fruit-wine', 'tag_sake-fruit-wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_sake-fruit-wine__alcohol', 'tag_sake-fruit-wine', 'tag_alcohol');
--> statement-breakpoint
INSERT OR IGNORE INTO `category_closure` (`id`, `tag_id`, `ancestor_tag_id`) VALUES ('clo_sake-fruit-wine__beverage', 'tag_sake-fruit-wine', 'tag_beverage');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10003380', 'sam', '10003380', 'tag_carbonated');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012082', 'sam', '10012082', 'tag_juice-plant');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012180', 'sam', '10012180', 'tag_wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012178', 'sam', '10012178', 'tag_wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012182', 'sam', '10012182', 'tag_wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10007844', 'sam', '10007844', 'tag_wine');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012164', 'sam', '10012164', 'tag_baijiu');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012165', 'sam', '10012165', 'tag_baijiu');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012166', 'sam', '10012166', 'tag_baijiu');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012187', 'sam', '10012187', 'tag_whisky');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012188', 'sam', '10012188', 'tag_whisky');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012172', 'sam', '10012172', 'tag_beer');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012170', 'sam', '10012170', 'tag_beer');
--> statement-breakpoint
INSERT OR IGNORE INTO `store_category_map` (`id`, `store`, `native_category_id`, `tag_id`) VALUES ('scm_sam_10012190', 'sam', '10012190', 'tag_spirits');
