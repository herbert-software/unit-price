CREATE TABLE `category_closure` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_id` text NOT NULL,
	`ancestor_tag_id` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ancestor_tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_closure_tag_id_ancestor_tag_id_unique` ON `category_closure` (`tag_id`,`ancestor_tag_id`);--> statement-breakpoint
CREATE TABLE `product_tag` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_tag_product_id_tag_id_unique` ON `product_tag` (`product_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `store_category_map` (
	`id` text PRIMARY KEY NOT NULL,
	`store` text NOT NULL,
	`native_category_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `store_category_map_store_native_category_id_unique` ON `store_category_map` (`store`,`native_category_id`);--> statement-breakpoint
CREATE TABLE `tag` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`comparable_unit` text,
	FOREIGN KEY (`parent_id`) REFERENCES `tag`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tag_slug_unique` ON `tag` (`slug`);--> statement-breakpoint
ALTER TABLE `product` ADD `pending_category_tag_id` text REFERENCES tag(id);--> statement-breakpoint
ALTER TABLE `product` ADD `rankable` integer DEFAULT 0 NOT NULL;