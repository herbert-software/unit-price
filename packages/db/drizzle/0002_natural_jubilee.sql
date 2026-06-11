ALTER TABLE `unit_price` ADD `per100g` real;--> statement-breakpoint
CREATE INDEX `unit_price_per100g_idx` ON `unit_price` (`per100g`);