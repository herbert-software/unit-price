ALTER TABLE `product` ADD `dedupe_key` text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_dedupe_key_unique` ON `product` (`dedupe_key`);