-- =========================================================
-- ERP MAQUILA TEXTIL - ESQUEMA MYSQL CONSTRUIDO DESDE EL CÓDIGO REAL
-- MySQL 8.0+
--
-- Este esquema fue derivado leyendo src/db/queries.ts, server.ts,
-- src/db/db.ts y src/types.ts línea por línea -- NO del archivo
-- database_schema.sql incluido en el zip, que está desalineado del
-- código (nombres de tabla en plural que el código nunca usa,
-- triggers que dependen de una variable de sesión que el backend
-- jamás setea, y una capa de "capacity_adjustments" que ningún
-- query toca). Ver las notas al final para el detalle de cada
-- decisión y las preguntas abiertas para el equipo.
--
-- Ejecutar: mysql -u tu_usuario -p < erp_maquila_schema.sql
-- ADVERTENCIA: hace DROP DATABASE IF EXISTS. Quita esa línea si
-- ya tienes datos reales en erp_maquila_db.
-- =========================================================

DROP DATABASE IF EXISTS `erp_maquila_db`;
CREATE DATABASE `erp_maquila_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `erp_maquila_db`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- =========================================================
-- 1. ACCESO Y ROLES
-- =========================================================

-- IDs fijos: el backend los usa literalmente (getRoleName() en server.ts
-- mapea 1=admin, 2=tienda, 3=taller, 4=cliente, 5=operario).
CREATE TABLE `roles` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(50) NOT NULL UNIQUE,
    `description` TEXT,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `users` (
    `id` INT AUTO_INCREMENT,
    `full_name` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL UNIQUE,
    `phone` VARCHAR(50),
    `password_hash` VARCHAR(255) NOT NULL,
    `role_id` INT NOT NULL,
    `is_active` TINYINT(1) NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- getRolePermissions()/updateRolePermission() en queries.ts crean esta
-- tabla en runtime vía CREATE TABLE IF NOT EXISTS con VARCHAR(50) para
-- permission_key -- la predefino aquí con esa misma anchura para que
-- ese código sea un no-op inofensivo en vez de chocar con el CREATE.
CREATE TABLE `role_permissions` (
    `role_id` INT NOT NULL,
    `permission_key` VARCHAR(50) NOT NULL,
    `is_enabled` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (`role_id`, `permission_key`)
) ENGINE=InnoDB;

-- =========================================================
-- 2. CATÁLOGOS DE PRODUCCIÓN (IDs fijos, referenciados literalmente
--    en queries.ts y server.ts -- ver notas finales)
-- =========================================================

CREATE TABLE `product_types` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL UNIQUE,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `attribute_types` (
    `id` INT AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL UNIQUE,
    `name` VARCHAR(100) NOT NULL,
    `input_component` VARCHAR(100) NOT NULL,
    `requires_catalog_value` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- Nombre SINGULAR -- el código real hace "JOIN order_status" en ningún
-- lado explícitamente (los labels de order status viven hardcodeados
-- en arrays JS), pero mantengo la tabla por integridad referencial de
-- orders.status_id y por si se agrega ese JOIN a futuro. is_terminal
-- se usa para lógica de negocio conceptual (5=entregado, 6=cancelado).
CREATE TABLE `order_status` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL UNIQUE,
    `is_terminal` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- Nombre SINGULAR -- confirmado por 3 JOINs literales en getProductionTasks()
-- y getProductionTasksPendingReview() en queries.ts: "JOIN production_status pst".
CREATE TABLE `production_status` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL UNIQUE,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- EXACTAMENTE 10 etapas fijas -- createOrder() genera una tarea por
-- cada etapa (SELECT id FROM production_stages ORDER BY sequence_order),
-- y el código usa stage_id=10 ("Despachado") como condición de cierre
-- de pedido, y stage_id=1 como default de reproceso.
CREATE TABLE `production_stages` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL UNIQUE,
    `sequence_order` INT NOT NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `sizes` (
    `id` INT AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL UNIQUE,
    `name` VARCHAR(100) NOT NULL,
    `sort_order` INT NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- =========================================================
-- 3. CATÁLOGO DE PRODUCTOS Y PERSONALIZACIÓN
-- =========================================================

CREATE TABLE `products` (
    `id` INT AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `base_price` DECIMAL(10,2) NOT NULL,
    `active` TINYINT(1) NOT NULL DEFAULT 1,
    `product_type_id` INT NOT NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `product_attributes` (
    `id` INT AUTO_INCREMENT,
    `product_id` INT NOT NULL,
    `attribute_name` VARCHAR(255) NOT NULL,
    `attribute_type_id` INT NOT NULL,
    `is_required` TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `product_attribute_values` (
    `id` INT AUTO_INCREMENT,
    `attribute_id` INT NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `price_modifier` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `active` TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `product_sizes` (
    `id` INT AUTO_INCREMENT,
    `product_id` INT NOT NULL,
    `size_id` INT NOT NULL,
    `price_modifier` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `active` TINYINT(1) NOT NULL DEFAULT 1,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_product_size` (`product_id`, `size_id`)
) ENGINE=InnoDB;

-- =========================================================
-- 4. PEDIDOS
-- =========================================================

-- priority se queda como ENUM (no catálogo) porque queries.ts hace
-- "CASE o.priority WHEN 'urgent' THEN 1 ..." en SQL crudo, y el mock/
-- frontend comparan contra estos mismos literales en JS. Un FK a
-- catálogo habría roto esas comparaciones.
CREATE TABLE `orders` (
    `id` INT AUTO_INCREMENT,
    `client_id` INT,
    `client_name` VARCHAR(255) NOT NULL,
    `created_by` INT NOT NULL,
    `status_id` INT NOT NULL,
    `priority` ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
    `total_price` DECIMAL(10,2) NOT NULL DEFAULT 0.00,  -- mantenido por trigger, nunca escribir directo
    `notes` TEXT,
    `client_confirmed` TINYINT(1) NOT NULL DEFAULT 0,
    `client_confirmed_at` TIMESTAMP NULL,
    `delivered_at` TIMESTAMP NULL,
    `estimated_delivery_date` DATE NOT NULL,
    `production_start_date` DATE NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- quantity y subtotal arrancan en 0 e INSERT los deja así
-- explícitamente (createOrder: "VALUES (?, ?, 0, ?, 0)") -- los
-- recalculan los triggers de order_item_sizes/order_item_attributes.
CREATE TABLE `order_items` (
    `id` INT AUTO_INCREMENT,
    `order_id` INT NOT NULL,
    `product_id` INT NOT NULL,
    `quantity` INT NOT NULL DEFAULT 0,
    `unit_price` DECIMAL(10,2) NOT NULL,
    `subtotal` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `custom_notes` JSON NULL,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- El INSERT real solo manda (order_item_id, product_size_id, quantity);
-- size_label y price_modifier_snapshot los llena un trigger.
CREATE TABLE `order_item_sizes` (
    `id` INT AUTO_INCREMENT,
    `order_item_id` INT NOT NULL,
    `product_size_id` INT NOT NULL,
    `size_label` VARCHAR(100) NOT NULL,
    `price_modifier_snapshot` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `quantity` INT NOT NULL,
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_ois_quantity` CHECK (`quantity` > 0)
) ENGINE=InnoDB;

-- El INSERT real solo manda (order_item_id, attribute_id,
-- attribute_value_id, custom_value); value_label y
-- price_modifier_snapshot los llena un trigger.
CREATE TABLE `order_item_attributes` (
    `id` INT AUTO_INCREMENT,
    `order_item_id` INT NOT NULL,
    `attribute_id` INT NOT NULL,
    `attribute_value_id` INT NULL,
    `custom_value` TEXT NULL,
    `value_label` VARCHAR(255) NOT NULL,
    `price_modifier_snapshot` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `order_item_files` (
    `id` INT AUTO_INCREMENT,
    `order_item_id` INT NOT NULL,
    `file_url` VARCHAR(2048) NOT NULL,
    `file_type` VARCHAR(100),
    `uploaded_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- Poblada EXCLUSIVAMENTE por la aplicación (updateOrderStatus en
-- queries.ts ya hace el INSERT manual con comentario descriptivo) --
-- por eso NO hay trigger automático aquí (duplicaría filas).
CREATE TABLE `order_status_history` (
    `id` INT AUTO_INCREMENT,
    `order_id` INT NOT NULL,
    `status_id` INT NOT NULL,
    `changed_by` INT NOT NULL,
    `comment` TEXT,
    `changed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- =========================================================
-- 5. PRODUCCIÓN
-- =========================================================

CREATE TABLE `production_tasks` (
    `id` INT AUTO_INCREMENT,
    `order_id` INT NOT NULL,
    `order_item_id` INT NOT NULL,
    `stage_id` INT NOT NULL,
    `assigned_to` INT NULL,
    `status_id` INT NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date_estimated` DATE NULL,
    `end_date_actual` DATE NULL,
    `workload_points` INT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_workload_nonneg` CHECK (`workload_points` >= 0)
) ENGINE=InnoDB;

-- Igual que order_status_history: la aplicación ya inserta aquí
-- manualmente en updateTaskStatus/advanceTaskStage/createReworkEvent
-- con comentarios ricos en contexto. Sin trigger automático.
CREATE TABLE `production_task_history` (
    `id` INT AUTO_INCREMENT,
    `production_task_id` INT NOT NULL,
    `status_id` INT NOT NULL,
    `changed_by` INT NULL,
    `comment` TEXT,
    `changed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- Sin capacity_adjustments ni effective_capacity: código muerto en el
-- database_schema.sql original, ningún query.ts los usa.
CREATE TABLE `work_calendar` (
    `id` INT AUTO_INCREMENT,
    `work_date` DATE NOT NULL,
    `stage_id` INT NOT NULL,
    `max_capacity_points` INT NOT NULL DEFAULT 100,
    `is_working_day` TINYINT(1) NOT NULL DEFAULT 1,
    `notes` TEXT,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_calendar_date_stage` (`work_date`, `stage_id`)
) ENGINE=InnoDB;

-- rework_type se queda como ENUM: JS compara literal contra
-- 'arreglo' | 'hacer_de_nuevo' en varios puntos de queries.ts.
CREATE TABLE `rework_events` (
    `id` INT AUTO_INCREMENT,
    `production_task_id` INT NOT NULL,
    `order_id` INT NOT NULL,
    `rework_type` ENUM('arreglo','hacer_de_nuevo') NOT NULL,
    `description` TEXT NOT NULL,
    `created_by` INT NOT NULL,
    `stage_id` INT NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- =========================================================
-- 6. FINANZAS
-- =========================================================

-- payment_method acepta AMBOS conjuntos de valores (inglés del
-- validador en server.ts + español de types.ts/mock) porque hoy
-- coexisten en el código -- ver nota de bug en la respuesta.
CREATE TABLE `payments` (
    `id` INT AUTO_INCREMENT,
    `order_id` INT NOT NULL,
    `amount` DECIMAL(10,2) NOT NULL,
    `payment_method` VARCHAR(50) NOT NULL,
    `notes` TEXT,
    `registered_by` INT NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_payment_amount_positive` CHECK (`amount` > 0),
    CONSTRAINT `chk_payment_method` CHECK (
        `payment_method` IN ('efectivo','tarjeta','transferencia','cash','card','transfer')
    )
) ENGINE=InnoDB;

CREATE TABLE `invoices` (
    `id` INT AUTO_INCREMENT,
    `order_id` INT NOT NULL,
    `invoice_number` VARCHAR(100) NOT NULL UNIQUE,
    `subtotal` DECIMAL(10,2) NOT NULL,
    `tax` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `discount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    `total` DECIMAL(10,2) NOT NULL,
    `invoice_type` ENUM('consumidor_final','credito_fiscal') NOT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE `audit_logs` (
    `id` INT AUTO_INCREMENT,
    `user_name` VARCHAR(255) NOT NULL,
    `action` TEXT NOT NULL,
    `old_value` TEXT,
    `new_value` TEXT,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;

-- =========================================================
-- 7. FOREIGN KEYS
-- =========================================================

ALTER TABLE `users`
    ADD CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT;

ALTER TABLE `role_permissions`
    ADD CONSTRAINT `fk_rp_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE;

ALTER TABLE `products`
    ADD CONSTRAINT `fk_products_type` FOREIGN KEY (`product_type_id`) REFERENCES `product_types`(`id`) ON DELETE RESTRICT;

ALTER TABLE `product_attributes`
    ADD CONSTRAINT `fk_pa_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_pa_type` FOREIGN KEY (`attribute_type_id`) REFERENCES `attribute_types`(`id`) ON DELETE RESTRICT;

ALTER TABLE `product_attribute_values`
    ADD CONSTRAINT `fk_pav_attribute` FOREIGN KEY (`attribute_id`) REFERENCES `product_attributes`(`id`) ON DELETE CASCADE;

ALTER TABLE `product_sizes`
    ADD CONSTRAINT `fk_ps_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_ps_size` FOREIGN KEY (`size_id`) REFERENCES `sizes`(`id`) ON DELETE RESTRICT;

ALTER TABLE `orders`
    ADD CONSTRAINT `fk_orders_client` FOREIGN KEY (`client_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
    ADD CONSTRAINT `fk_orders_created_by` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_orders_status` FOREIGN KEY (`status_id`) REFERENCES `order_status`(`id`) ON DELETE RESTRICT;

ALTER TABLE `order_items`
    ADD CONSTRAINT `fk_oi_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_oi_product` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE RESTRICT;

ALTER TABLE `order_item_sizes`
    ADD CONSTRAINT `fk_ois_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_ois_product_size` FOREIGN KEY (`product_size_id`) REFERENCES `product_sizes`(`id`) ON DELETE RESTRICT;

ALTER TABLE `order_item_attributes`
    ADD CONSTRAINT `fk_oia_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_oia_attribute` FOREIGN KEY (`attribute_id`) REFERENCES `product_attributes`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_oia_value` FOREIGN KEY (`attribute_value_id`) REFERENCES `product_attribute_values`(`id`) ON DELETE SET NULL;

ALTER TABLE `order_item_files`
    ADD CONSTRAINT `fk_oif_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE CASCADE;

ALTER TABLE `order_status_history`
    ADD CONSTRAINT `fk_osh_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_osh_status` FOREIGN KEY (`status_id`) REFERENCES `order_status`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_osh_user` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT;

ALTER TABLE `production_tasks`
    ADD CONSTRAINT `fk_pt_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_pt_item` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_pt_stage` FOREIGN KEY (`stage_id`) REFERENCES `production_stages`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_pt_user` FOREIGN KEY (`assigned_to`) REFERENCES `users`(`id`) ON DELETE SET NULL,
    ADD CONSTRAINT `fk_pt_status` FOREIGN KEY (`status_id`) REFERENCES `production_status`(`id`) ON DELETE RESTRICT;

ALTER TABLE `production_task_history`
    ADD CONSTRAINT `fk_pth_task` FOREIGN KEY (`production_task_id`) REFERENCES `production_tasks`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_pth_status` FOREIGN KEY (`status_id`) REFERENCES `production_status`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_pth_user` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE SET NULL;

ALTER TABLE `work_calendar`
    ADD CONSTRAINT `fk_wc_stage` FOREIGN KEY (`stage_id`) REFERENCES `production_stages`(`id`) ON DELETE CASCADE;

ALTER TABLE `rework_events`
    ADD CONSTRAINT `fk_re_task` FOREIGN KEY (`production_task_id`) REFERENCES `production_tasks`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_re_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_re_user` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT,
    ADD CONSTRAINT `fk_re_stage` FOREIGN KEY (`stage_id`) REFERENCES `production_stages`(`id`) ON DELETE RESTRICT;

ALTER TABLE `payments`
    ADD CONSTRAINT `fk_payments_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE,
    ADD CONSTRAINT `fk_payments_user` FOREIGN KEY (`registered_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT;

ALTER TABLE `invoices`
    ADD CONSTRAINT `fk_invoices_order` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE;

SET FOREIGN_KEY_CHECKS = 1;

-- =========================================================
-- 8. ÍNDICES
-- =========================================================

CREATE INDEX `idx_orders_client` ON `orders`(`client_id`);
CREATE INDEX `idx_orders_status` ON `orders`(`status_id`);
CREATE INDEX `idx_orders_delivery` ON `orders`(`estimated_delivery_date`);
CREATE INDEX `idx_oi_order` ON `order_items`(`order_id`);
CREATE INDEX `idx_ois_item` ON `order_item_sizes`(`order_item_id`);
CREATE INDEX `idx_oia_item` ON `order_item_attributes`(`order_item_id`);
CREATE INDEX `idx_pt_stage_date` ON `production_tasks`(`stage_id`, `start_date`);
CREATE INDEX `idx_pt_order` ON `production_tasks`(`order_id`);
CREATE INDEX `idx_pt_status` ON `production_tasks`(`status_id`);
CREATE INDEX `idx_payments_order` ON `payments`(`order_id`);
CREATE INDEX `idx_invoices_order` ON `invoices`(`order_id`);

-- =========================================================
-- 9. PROCEDIMIENTOS: RECÁLCULO FINANCIERO
-- Replican exactamente sp_recalc_order_item_subtotal / sp_recalc_order_total
-- del MockDatabase en src/db/db.ts, para que el comportamiento entre modo
-- sandbox (sin MySQL) y modo real sea idéntico.
-- =========================================================

DELIMITER $$

CREATE PROCEDURE `sp_recalc_order_item_subtotal`(IN p_item_id INT)
BEGIN
    DECLARE v_unit DECIMAL(10,2);
    DECLARE v_attr_extra DECIMAL(10,2);
    DECLARE v_total_qty INT;
    DECLARE v_subtotal DECIMAL(10,2);

    SELECT `unit_price` INTO v_unit FROM `order_items` WHERE `id` = p_item_id;

    -- price_modifier_snapshot ya incluye el ajuste de +2.50 por bordado
    -- personalizado (aplicado al momento del INSERT, ver trigger abajo)
    SELECT COALESCE(SUM(`price_modifier_snapshot`), 0) INTO v_attr_extra
    FROM `order_item_attributes` WHERE `order_item_id` = p_item_id;

    SELECT
        COALESCE(SUM(`quantity`), 0),
        COALESCE(SUM(`quantity` * (v_unit + v_attr_extra + `price_modifier_snapshot`)), 0)
    INTO v_total_qty, v_subtotal
    FROM `order_item_sizes`
    WHERE `order_item_id` = p_item_id;

    UPDATE `order_items`
    SET `quantity` = v_total_qty, `subtotal` = v_subtotal
    WHERE `id` = p_item_id;
END$$

CREATE PROCEDURE `sp_recalc_order_total`(IN p_order_id INT)
BEGIN
    UPDATE `orders`
    SET `total_price` = (
        SELECT COALESCE(SUM(`subtotal`), 0) FROM `order_items` WHERE `order_id` = p_order_id
    )
    WHERE `id` = p_order_id;
END$$

DELIMITER ;

-- =========================================================
-- 10. TRIGGERS: order_items
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_order_items_before_insert`
BEFORE INSERT ON `order_items`
FOR EACH ROW
BEGIN
    -- El INSERT real siempre manda 0/0 explícito; esto es un respaldo
    -- por si algún día alguien inserta sin pasarlos.
    IF NEW.`quantity` IS NULL THEN SET NEW.`quantity` = 0; END IF;
    IF NEW.`subtotal` IS NULL THEN SET NEW.`subtotal` = 0; END IF;
END$$

-- Directiva 3 del servidor ("Inyección de datos financieros... denegada")
-- ya bloquea esto en la capa HTTP. Este trigger es la última línea de
-- defensa si algo llega a golpear la BD directamente sin pasar por la API.
CREATE TRIGGER `trg_order_items_before_update`
BEFORE UPDATE ON `order_items`
FOR EACH ROW
BEGIN
    DECLARE v_extra DECIMAL(10,2);
    DECLARE v_derived_qty INT;

    SELECT COALESCE(SUM(`quantity`), 0)
    INTO v_derived_qty
    FROM `order_item_sizes`
    WHERE `order_item_id` = NEW.`id`;

    IF NEW.`quantity` <> OLD.`quantity` THEN
        IF NEW.`quantity` = v_derived_qty THEN
            -- Permitir el recalculo legítimo que viene de order_item_sizes.
            SET NEW.`quantity` = v_derived_qty;
        ELSE
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'ERR_INVALID_QUANTITY_WRITE|quantity es derivado de order_item_sizes; no debe escribirse directamente';
        END IF;
    END IF;

    SELECT COALESCE(SUM(`price_modifier_snapshot`), 0) INTO v_extra
    FROM `order_item_attributes` WHERE `order_item_id` = NEW.`id`;

    IF NEW.`quantity` = v_derived_qty THEN
        -- Preservar el subtotal ya calculado por sp_recalc_order_item_subtotal.
        SET NEW.`subtotal` = COALESCE(NEW.`subtotal`, OLD.`subtotal`);
    ELSE
        SET NEW.`subtotal` = (NEW.`unit_price` + v_extra) * NEW.`quantity`;
    END IF;
END$$

CREATE TRIGGER `trg_order_items_after_insert`
AFTER INSERT ON `order_items`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_total`(NEW.`order_id`);
END$$

CREATE TRIGGER `trg_order_items_after_update`
AFTER UPDATE ON `order_items`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_total`(NEW.`order_id`);
END$$

CREATE TRIGGER `trg_order_items_after_delete`
AFTER DELETE ON `order_items`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_total`(OLD.`order_id`);
END$$

DELIMITER ;

-- =========================================================
-- 11. TRIGGERS: order_item_sizes
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_ois_before_insert`
BEFORE INSERT ON `order_item_sizes`
FOR EACH ROW
BEGIN
    DECLARE v_product_item INT;
    DECLARE v_product_size INT;
    DECLARE v_size_name VARCHAR(100);
    DECLARE v_price_mod DECIMAL(10,2);
    DECLARE v_active TINYINT(1);

    SELECT `product_id` INTO v_product_item FROM `order_items` WHERE `id` = NEW.`order_item_id`;

    SELECT `ps`.`product_id`, `s`.`name`, `ps`.`price_modifier`, `ps`.`active`
    INTO v_product_size, v_size_name, v_price_mod, v_active
    FROM `product_sizes` `ps`
    JOIN `sizes` `s` ON `s`.`id` = `ps`.`size_id`
    WHERE `ps`.`id` = NEW.`product_size_id`;

    IF v_product_size IS NULL OR v_product_size <> v_product_item THEN
        SIGNAL SQLSTATE '45007'
        SET MESSAGE_TEXT = 'ERR_SIZE_PRODUCT_MISMATCH|La talla seleccionada no pertenece al producto de este ítem';
    END IF;

    IF v_active = 0 THEN
        SIGNAL SQLSTATE '45007'
        SET MESSAGE_TEXT = 'ERR_SIZE_PRODUCT_MISMATCH|La talla seleccionada está desactivada para este producto';
    END IF;

    SET NEW.`size_label` = v_size_name;
    SET NEW.`price_modifier_snapshot` = v_price_mod;
END$$

CREATE TRIGGER `trg_ois_after_insert`
AFTER INSERT ON `order_item_sizes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(NEW.`order_item_id`);
END$$

CREATE TRIGGER `trg_ois_after_update`
AFTER UPDATE ON `order_item_sizes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(NEW.`order_item_id`);
END$$

CREATE TRIGGER `trg_ois_after_delete`
AFTER DELETE ON `order_item_sizes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(OLD.`order_item_id`);
END$$

DELIMITER ;

-- =========================================================
-- 12. TRIGGERS: order_item_attributes
-- Replica la regla de "bordado" de sp_recalc_order_item_subtotal en
-- MockDatabase (db.ts línea ~652): si el atributo es de texto libre,
-- price_modifier es 0, el valor no está vacío, y el NOMBRE del
-- atributo contiene "bordado", se aplica un extra de $2.50.
--
-- MEJORA deliberada respecto al mock: el mock recalcula esto leyendo
-- el nombre ACTUAL del atributo cada vez que se llama
-- sp_recalc_order_item_subtotal, así que si un admin renombra el
-- atributo después, el total de pedidos históricos cambiaría solo.
-- Aquí el ajuste se congela en price_modifier_snapshot al momento del
-- INSERT, consistente con el resto del diseño de snapshots inmutables.
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_oia_before_insert`
BEFORE INSERT ON `order_item_attributes`
FOR EACH ROW
BEGIN
    DECLARE v_requires_catalog TINYINT(1);
    DECLARE v_attr_name VARCHAR(255);
    DECLARE v_value VARCHAR(255);
    DECLARE v_price DECIMAL(10,2);

    SELECT `pa`.`attribute_name`, `at`.`requires_catalog_value`
    INTO v_attr_name, v_requires_catalog
    FROM `product_attributes` `pa`
    JOIN `attribute_types` `at` ON `at`.`id` = `pa`.`attribute_type_id`
    WHERE `pa`.`id` = NEW.`attribute_id`;

    IF v_requires_catalog THEN
        IF NEW.`attribute_value_id` IS NULL THEN
            SIGNAL SQLSTATE '45004'
            SET MESSAGE_TEXT = 'ERR_ATTRIBUTE_VALUE_REQUIRED|Este atributo requiere un valor de catálogo (attribute_value_id)';
        END IF;
        SELECT `value`, `price_modifier` INTO v_value, v_price
        FROM `product_attribute_values` WHERE `id` = NEW.`attribute_value_id`;
        SET NEW.`value_label` = v_value;
        SET NEW.`price_modifier_snapshot` = v_price;
    ELSE
        IF NEW.`custom_value` IS NULL OR TRIM(NEW.`custom_value`) = '' THEN
            SIGNAL SQLSTATE '45005'
            SET MESSAGE_TEXT = 'ERR_CUSTOM_VALUE_REQUIRED|Este atributo requiere un valor de texto libre (custom_value)';
        END IF;
        SET NEW.`value_label` = NEW.`custom_value`;
        IF LOWER(v_attr_name) LIKE '%ordado%' THEN
            SET NEW.`price_modifier_snapshot` = 2.50;
        ELSE
            SET NEW.`price_modifier_snapshot` = 0;
        END IF;
    END IF;
END$$

CREATE TRIGGER `trg_oia_after_insert`
AFTER INSERT ON `order_item_attributes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(NEW.`order_item_id`);
END$$

CREATE TRIGGER `trg_oia_after_update`
AFTER UPDATE ON `order_item_attributes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(NEW.`order_item_id`);
END$$

CREATE TRIGGER `trg_oia_after_delete`
AFTER DELETE ON `order_item_attributes`
FOR EACH ROW
BEGIN
    CALL `sp_recalc_order_item_subtotal`(OLD.`order_item_id`);
END$$

DELIMITER ;

-- =========================================================
-- 13. TRIGGER: inmutabilidad de client_name
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_orders_client_name_immutable`
BEFORE UPDATE ON `orders`
FOR EACH ROW
BEGIN
    IF NOT (NEW.`client_name` <=> OLD.`client_name`) THEN
        SIGNAL SQLSTATE '45006'
        SET MESSAGE_TEXT = 'ERR_IMMUTABLE_FIELD|client_name es un snapshot inmutable; actualizar datos del cliente vía users/client_id';
    END IF;
END$$

DELIMITER ;

-- =========================================================
-- 14. TRIGGERS: CONTROL DE CAPACIDAD DE TALLER
-- Nombre EXACTO trg_production_tasks_capacity_insert -- referenciado
-- textualmente en el comentario de createOrder() en queries.ts:
--   "// Triggers (trg_production_tasks_capacity_insert) will run here!"
--
-- Replica validate_capacity() del MockDatabase, incluyendo la
-- exclusión de pedidos cancelados (status_id = 6) de la suma de
-- comprometido, tal como getCapacityCommitted() hace en SQL real
-- ("AND o.status_id != 6").
--
-- MEJORA sobre el mock: usa SELECT ... FOR UPDATE para serializar
-- por (fecha, etapa) y evitar condiciones de carrera entre vendedores
-- concurrentes -- el mock JS es de un solo hilo y no lo necesita, pero
-- MySQL con el pool de conexiones sí.
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_production_tasks_capacity_insert`
BEFORE INSERT ON `production_tasks`
FOR EACH ROW
BEGIN
    DECLARE v_max INT;
    DECLARE v_working TINYINT(1);
    DECLARE v_committed INT;

    SELECT `max_capacity_points`, `is_working_day` INTO v_max, v_working
    FROM `work_calendar`
    WHERE `work_date` = NEW.`start_date` AND `stage_id` = NEW.`stage_id`
    FOR UPDATE;

    IF v_max IS NULL THEN
        SIGNAL SQLSTATE '45003'
        SET MESSAGE_TEXT = 'ERR_MISSING_CAPACITY_DEFINITION|No hay capacidad definida en work_calendar para esta fecha y etapa';
    END IF;

    IF v_working = 0 THEN
        SIGNAL SQLSTATE '45002'
        SET MESSAGE_TEXT = 'ERR_NON_WORKING_DAY|La fecha seleccionada no es día laborable para esta etapa';
    END IF;

    SELECT COALESCE(SUM(`pt`.`workload_points`), 0) INTO v_committed
    FROM `production_tasks` `pt`
    JOIN `orders` `o` ON `o`.`id` = `pt`.`order_id`
    WHERE `pt`.`stage_id` = NEW.`stage_id`
      AND `pt`.`start_date` = NEW.`start_date`
      AND `o`.`status_id` <> 6;

    IF (v_committed + NEW.`workload_points`) > v_max THEN
        SIGNAL SQLSTATE '45001'
        SET MESSAGE_TEXT = 'ERR_CAPACITY_EXCEEDED|Capacidad de taller excedida para esta fecha y etapa';
    END IF;
END$$

-- advanceTaskStage() adelanta start_date de la siguiente tarea a "hoy",
-- y createReworkEvent() con 'hacer_de_nuevo' reasigna start_date al
-- reiniciar etapas -- NINGUNO de los dos valida capacidad hoy en el
-- código JS. Este trigger SÍ la valida en UPDATE. Es un cambio de
-- comportamiento real (ver pregunta abierta #3 al final).
CREATE TRIGGER `trg_production_tasks_capacity_update`
BEFORE UPDATE ON `production_tasks`
FOR EACH ROW
BEGIN
    DECLARE v_max INT;
    DECLARE v_working TINYINT(1);
    DECLARE v_committed INT;

    IF NEW.`start_date` <> OLD.`start_date`
       OR NEW.`stage_id` <> OLD.`stage_id`
       OR NEW.`workload_points` <> OLD.`workload_points` THEN

        SELECT `max_capacity_points`, `is_working_day` INTO v_max, v_working
        FROM `work_calendar`
        WHERE `work_date` = NEW.`start_date` AND `stage_id` = NEW.`stage_id`
        FOR UPDATE;

        IF v_max IS NULL THEN
            SIGNAL SQLSTATE '45003'
            SET MESSAGE_TEXT = 'ERR_MISSING_CAPACITY_DEFINITION|No hay capacidad definida en work_calendar para esta fecha y etapa';
        END IF;

        IF v_working = 0 THEN
            SIGNAL SQLSTATE '45002'
            SET MESSAGE_TEXT = 'ERR_NON_WORKING_DAY|La fecha seleccionada no es día laborable para esta etapa';
        END IF;

        SELECT COALESCE(SUM(`pt`.`workload_points`), 0) INTO v_committed
        FROM `production_tasks` `pt`
        JOIN `orders` `o` ON `o`.`id` = `pt`.`order_id`
        WHERE `pt`.`stage_id` = NEW.`stage_id`
          AND `pt`.`start_date` = NEW.`start_date`
          AND `pt`.`id` <> NEW.`id`
          AND `o`.`status_id` <> 6;

        IF (v_committed + NEW.`workload_points`) > v_max THEN
            SIGNAL SQLSTATE '45001'
            SET MESSAGE_TEXT = 'ERR_CAPACITY_EXCEEDED|Capacidad de taller excedida para esta fecha y etapa';
        END IF;
    END IF;
END$$

DELIMITER ;

-- =========================================================
-- 15. TRIGGER: control de sobrepago (payments)
-- Replica la validación de createPayment() en queries.ts a nivel de
-- BD como última línea de defensa (la app ya lo valida antes de
-- llegar aquí).
-- =========================================================

DELIMITER $$

CREATE TRIGGER `trg_payments_before_insert`
BEFORE INSERT ON `payments`
FOR EACH ROW
BEGIN
    DECLARE v_order_total DECIMAL(10,2);
    DECLARE v_paid_so_far DECIMAL(10,2);

    SELECT `total_price` INTO v_order_total FROM `orders` WHERE `id` = NEW.`order_id` FOR UPDATE;

    SELECT COALESCE(SUM(`amount`), 0) INTO v_paid_so_far
    FROM `payments` WHERE `order_id` = NEW.`order_id`
    FOR UPDATE;

    IF (v_paid_so_far + NEW.`amount`) > (v_order_total + 0.01) THEN
        SIGNAL SQLSTATE '45009'
        SET MESSAGE_TEXT = 'ERR_OVERPAYMENT|El pago excede el saldo pendiente del pedido';
    END IF;
END$$

DELIMITER ;

-- =========================================================
-- 16. SEED DATA (IDs fijos -- coinciden con initSeedData() en db.ts)
-- =========================================================

INSERT INTO `roles` (`id`, `name`, `description`) VALUES
(1, 'admin', 'Administración general'),
(2, 'tienda', 'Personal de tienda / ventas'),
(3, 'taller', 'Personal de producción / Supervisor'),
(4, 'cliente', 'Cliente con cuenta'),
(5, 'operario', 'Operario de taller / producción');

INSERT INTO `role_permissions` (`role_id`, `permission_key`, `is_enabled`) VALUES
(1,'dashboard',1),(1,'calendar',1),(1,'create_order',1),(1,'kanban',1),(1,'admin_panel',1),(1,'my_orders',0),
(2,'dashboard',1),(2,'calendar',1),(2,'create_order',1),(2,'kanban',0),(2,'admin_panel',0),(2,'my_orders',0),
(3,'dashboard',0),(3,'calendar',0),(3,'create_order',0),(3,'kanban',1),(3,'admin_panel',0),(3,'my_orders',0),
(4,'dashboard',0),(4,'calendar',0),(4,'create_order',0),(4,'kanban',0),(4,'admin_panel',0),(4,'my_orders',1),
(5,'dashboard',0),(5,'calendar',0),(5,'create_order',0),(5,'kanban',1),(5,'admin_panel',0),(5,'my_orders',0);

INSERT INTO `attribute_types` (`id`, `code`, `name`, `input_component`, `requires_catalog_value`) VALUES
(1,'select','Selección única','select_dropdown',1),
(2,'color','Selector de color','color_picker',1),
(3,'text','Texto libre','text_input',0),
(4,'number','Número','number_input',0);

INSERT INTO `order_status` (`id`, `name`, `is_terminal`) VALUES
(1,'pendiente_confirmacion',0),
(2,'confirmado',0),
(3,'en_produccion',0),
(4,'listo_entrega',0),
(5,'entregado',1),
(6,'cancelado',1);

INSERT INTO `production_status` (`id`, `name`) VALUES
(1,'pendiente'),(2,'en_proceso'),(3,'completado'),(4,'bloqueado'),(5,'listo_revision');

INSERT INTO `production_stages` (`id`, `name`, `sequence_order`) VALUES
(1,'Corte',1),(2,'Estampado',2),(3,'Confeccionado',3),(4,'Acabado',4),(5,'Revisado',5),
(6,'Bordado',6),(7,'Planchado',7),(8,'Empaquetado',8),(9,'Recibido en Tienda',9),(10,'Despachado',10);

INSERT INTO `sizes` (`id`, `code`, `name`, `sort_order`) VALUES
(1,'XS','Extra Small',1),(2,'S','Small',2),(3,'M','Medium',3),
(4,'L','Large',4),(5,'XL','Extra Large',5),(6,'XXL','Extra Extra Large',6);

INSERT INTO `product_types` (`id`, `name`) VALUES
(1,'Camisa'),(2,'Chumpa'),(3,'Pantalón');

INSERT INTO `products` (`id`, `name`, `base_price`, `active`, `product_type_id`) VALUES
(1,'Camisa Oxford Premium',15.00,1,1),
(2,'Chumpa Impermeable Polar',35.00,1,2),
(3,'Pantalón Gabardina Oficial',22.00,1,3);

INSERT INTO `product_attributes` (`id`, `product_id`, `attribute_name`, `attribute_type_id`, `is_required`) VALUES
(1,1,'Tipo de Cuello',1,1),
(2,1,'Color de Tela',2,1),
(3,1,'Texto de Bordado Personalizado',3,0),
(4,2,'Tipo de Forro',1,1),
(5,2,'Instrucción Especial de Logo',3,1);

INSERT INTO `product_attribute_values` (`id`, `attribute_id`, `value`, `price_modifier`, `active`) VALUES
(1,1,'Cuello Italiano',0.00,1),
(2,1,'Cuello Inglés',0.50,1),
(3,1,'Cuello Mao',1.00,1),
(4,2,'Blanco',0.00,1),
(5,2,'Celeste',0.00,1),
(6,2,'Rojo Corporativo',0.75,1),
(7,4,'Forro Térmico Polar',3.50,1),
(8,4,'Forro Sencillo Seda',0.00,1);

INSERT INTO `product_sizes` (`id`, `product_id`, `size_id`, `price_modifier`, `active`) VALUES
(1,1,2,0.00,1),(2,1,3,0.00,1),(3,1,4,0.50,1),(4,1,5,1.50,1),
(5,2,3,0.00,1),(6,2,4,1.50,1),(7,2,5,3.00,1),(8,2,6,5.00,1),
(9,3,2,0.00,1),(10,3,3,0.00,1),(11,3,4,0.00,1);

-- Calendario base: próximos 30 días + 5 hacia atrás, 10 etapas,
-- domingo cerrado, capacidad reducida en Estampado(2) y Bordado(6) --
-- replica initSeedData() en db.ts línea ~530.
INSERT INTO `work_calendar` (`work_date`, `stage_id`, `max_capacity_points`, `is_working_day`, `notes`)
SELECT
    d.work_date,
    stg.id,
    IF(stg.id IN (2,6), 200, 500),
    IF(DAYOFWEEK(d.work_date) = 1, 0, 1),  -- DAYOFWEEK: 1=domingo
    IF(DAYOFWEEK(d.work_date) = 1, 'Domingo - Cerrado', NULL)
FROM (
    SELECT DATE_ADD(CURDATE(), INTERVAL (n - 5) DAY) AS work_date
    FROM (
        SELECT a.N + b.N * 10 AS n
        FROM (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
              UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a
        CROSS JOIN (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3) b
    ) seq
    WHERE n < 35
) d
CROSS JOIN `production_stages` stg;

-- Usuario admin de arranque (password: admin123, hash bcrypt de ejemplo
-- del proyecto original -- CAMBIAR en producción)
INSERT INTO `users` (`id`, `full_name`, `email`, `password_hash`, `role_id`, `is_active`) VALUES
(1,'Admin Maquila','admin@maquila.com','$2a$10$fG6T5R8V0v.M1pD.W6uHDe8n09Rj7P.A3l0E3gY5m1BqEshVMy1f2',1,1),
(2,'Tienda Ventas','tienda@maquila.com','$2a$10$fG6T5R8V0v.M1pD.W6uHDe8n09Rj7P.A3l0E3gY5m1BqEshVMy1f2',2,1),
(3,'Supervisor Taller','taller@maquila.com','$2a$10$fG6T5R8V0v.M1pD.W6uHDe8n09Rj7P.A3l0E3gY5m1BqEshVMy1f2',3,1),
(4,'Cliente Ejemplo','cliente@maquila.com','$2a$10$fG6T5R8V0v.M1pD.W6uHDe8n09Rj7P.A3l0E3gY5m1BqEshVMy1f2',4,1),
(5,'Operario Juan','operario@maquila.com','$2a$10$fG6T5R8V0v.M1pD.W6uHDe8n09Rj7P.A3l0E3gY5m1BqEshVMy1f2',5,1);