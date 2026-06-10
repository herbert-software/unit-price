CREATE TABLE `corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`raw_id` text NOT NULL,
	`corrected_spec` text NOT NULL,
	`parse_source` text DEFAULT 'manual_corrected' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_id`) REFERENCES `product_raw`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `product` (
	`id` text PRIMARY KEY NOT NULL,
	`raw_id` text NOT NULL,
	`unit_size_value` real,
	`unit_size_unit` text,
	`quantity` real,
	`multipliers` text NOT NULL,
	`total_amount_value` real,
	`total_amount_unit` text,
	`package_unit` text,
	`category` text NOT NULL,
	`confidence` real NOT NULL,
	FOREIGN KEY (`raw_id`) REFERENCES `product_raw`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `product_raw` (
	`id` text PRIMARY KEY NOT NULL,
	`store` text NOT NULL,
	`store_sku` text NOT NULL,
	`title` text NOT NULL,
	`price` integer NOT NULL,
	`category_hint` text,
	`source` text,
	`source_url` text,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_raw_store_store_sku_unique` ON `product_raw` (`store`,`store_sku`);--> statement-breakpoint
CREATE TABLE `unit_price` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`per100ml` real,
	`formula` text,
	`confidence` real NOT NULL,
	`warnings` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `unit_price_per100ml_idx` ON `unit_price` (`per100ml`);--> statement-breakpoint
CREATE UNIQUE INDEX `unit_price_product_id_unique` ON `unit_price` (`product_id`);