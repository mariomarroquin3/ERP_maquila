-- =========================================================================
-- SCRIPT UNIFICADO: REPARACIÓN DE PAGOS Y FECHAS DE ENTREGA (ENHANCED)
-- =========================================================================

-- 1. LIMPIEZA DE TRIGGERS ANTIGUOS Y NUEVOS
DROP TRIGGER IF EXISTS `trg_payments_before_insert`;
DROP TRIGGER IF EXISTS `trg_payments_before_insert_v2`;
DROP TRIGGER IF EXISTS `trg_payments_after_insert`;
DROP TRIGGER IF EXISTS `trg_payments_after_delete`;
DROP TRIGGER IF EXISTS `trg_payments_before_update`;
DROP TRIGGER IF EXISTS `trg_payments_after_update`;
DROP TRIGGER IF EXISTS `trg_orders_set_delivered_at`;

-- 2. ASEGURAR COLUMNA 'total_paid'
-- Si esto da error "Duplicate column name", IGNOREN el error y continúen.
ALTER TABLE `orders` ADD COLUMN `total_paid` DECIMAL(10,2) NOT NULL DEFAULT 0.00;

-- 3. SINCRONIZACIÓN INICIAL DE SALDOS
SET SQL_SAFE_UPDATES = 0;
UPDATE `orders` o
SET o.`total_paid` = COALESCE((SELECT SUM(amount) FROM `payments` WHERE order_id = o.id), 0);
SET SQL_SAFE_UPDATES = 1;

-- =========================================================================
-- 4. CREACIÓN DE NUEVOS CANDADOS Y AUTOMATISMOS
-- =========================================================================
DELIMITER $$

-- A. CANDADO ANTI-SOBREPAGOS (INSERT)
CREATE TRIGGER `trg_payments_before_insert_v2`
BEFORE INSERT ON `payments`
FOR EACH ROW
BEGIN
    DECLARE v_order_total DECIMAL(10,2);
    DECLARE v_paid_so_far DECIMAL(10,2);
    SELECT `total_price`, `total_paid` INTO v_order_total, v_paid_so_far
    FROM `orders` WHERE `id` = NEW.`order_id`;
    
    IF (v_paid_so_far + NEW.`amount`) > (v_order_total + 0.01) THEN
        SIGNAL SQLSTATE '45009'
        SET MESSAGE_TEXT = 'ERR_OVERPAYMENT|El pago excede el saldo pendiente del pedido';
    END IF;
END$$

-- B. CANDADO ANTI-SOBREPAGOS (UPDATE) - **EL PLUS**
CREATE TRIGGER `trg_payments_before_update`
BEFORE UPDATE ON `payments`
FOR EACH ROW
BEGIN
    DECLARE v_order_total DECIMAL(10,2);
    DECLARE v_paid_so_far DECIMAL(10,2);
    
    -- Solo validamos si el monto realmente cambió
    IF NEW.amount <> OLD.amount THEN
        SELECT `total_price`, `total_paid` INTO v_order_total, v_paid_so_far
        FROM `orders` WHERE `id` = NEW.`order_id`;
        
        -- Calculamos el saldo proyectado restando el pago viejo y sumando el nuevo
        IF (v_paid_so_far - OLD.amount + NEW.amount) > (v_order_total + 0.01) THEN
            SIGNAL SQLSTATE '45009'
            SET MESSAGE_TEXT = 'ERR_OVERPAYMENT|La edición del pago excede el saldo pendiente del pedido';
        END IF;
    END IF;
END$$

-- C. ACTUALIZACIÓN DE SALDO (INSERT)
CREATE TRIGGER `trg_payments_after_insert`
AFTER INSERT ON `payments`
FOR EACH ROW
BEGIN
    UPDATE `orders` SET `total_paid` = `total_paid` + NEW.`amount` WHERE `id` = NEW.`order_id`;
END$$

-- D. ACTUALIZACIÓN DE SALDO (UPDATE) - **EL PLUS**
CREATE TRIGGER `trg_payments_after_update`
AFTER UPDATE ON `payments`
FOR EACH ROW
BEGIN
    -- Ajustamos el total_paid restando el monto anterior y sumando el nuevo
    IF NEW.amount <> OLD.amount THEN
        UPDATE `orders` 
        SET `total_paid` = `total_paid` - OLD.amount + NEW.amount 
        WHERE `id` = NEW.`order_id`;
    END IF;
END$$

-- E. REVERSO DE SALDO (DELETE)
CREATE TRIGGER `trg_payments_after_delete`
AFTER DELETE ON `payments`
FOR EACH ROW
BEGIN
    UPDATE `orders` SET `total_paid` = `total_paid` - OLD.`amount` WHERE `id` = OLD.`order_id`;
END$$

-- F. AUTOMATIZACIÓN DE FECHA DE ENTREGA (delivered_at)
CREATE TRIGGER `trg_orders_set_delivered_at`
BEFORE UPDATE ON `orders`
FOR EACH ROW
BEGIN
    -- Si el estado cambia a 5 (Entregado), ponemos la fecha actual
    IF NEW.status_id = 5 AND OLD.status_id <> 5 THEN
        SET NEW.delivered_at = CURRENT_TIMESTAMP;
    END IF;

    -- Si se revierte el estado (deja de ser 5), limpiamos la fecha
    IF NEW.status_id <> 5 AND OLD.status_id = 5 THEN
        SET NEW.delivered_at = NULL;
    END IF;
END$$

DELIMITER ;

-- =========================================================================
-- 5. MEJORA FLUJO PRODUCCIÓN POR JORNADAS
-- =========================================================================


-- ---------------------------------------------------------
-- A. AGREGAR CONTROL DE ESTADO DE TRABAJO
-- ---------------------------------------------------------

SET @exist_work_status = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_tasks'
    AND COLUMN_NAME = 'work_status'
);

SET @sql_work_status = IF(
    @exist_work_status = 0,
    '
    ALTER TABLE production_tasks
    ADD COLUMN work_status INT NOT NULL DEFAULT 1
    AFTER status_id
    ',
    'SELECT "work_status ya existe"'
);

PREPARE stmt FROM @sql_work_status;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;



-- ---------------------------------------------------------
-- B. GUARDAR FECHA PROGRAMADA ORIGINAL
-- ---------------------------------------------------------

SET @exist_planned_date = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_tasks'
    AND COLUMN_NAME = 'planned_date'
);


SET @sql_planned_date = IF(
    @exist_planned_date = 0,
    '
    ALTER TABLE production_tasks
    ADD COLUMN planned_date DATE NULL
    AFTER start_date
    ',
    'SELECT "planned_date ya existe"'
);


PREPARE stmt FROM @sql_planned_date;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;



-- ---------------------------------------------------------
-- C. FECHA REAL DE FINALIZACIÓN
-- ---------------------------------------------------------

SET @exist_completed_at = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_tasks'
    AND COLUMN_NAME = 'completed_at'
);


SET @sql_completed_at = IF(
    @exist_completed_at = 0,
    '
    ALTER TABLE production_tasks
    ADD COLUMN completed_at DATETIME NULL
    AFTER end_date_actual
    ',
    'SELECT "completed_at ya existe"'
);


PREPARE stmt FROM @sql_completed_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;



-- ---------------------------------------------------------
-- D. MIGRAR FECHAS EXISTENTES
-- ---------------------------------------------------------

SET SQL_SAFE_UPDATES = 0;


UPDATE production_tasks
SET planned_date = start_date
WHERE planned_date IS NULL;


UPDATE production_tasks
SET work_status = 4
WHERE status_id = 3
AND work_status = 1;


UPDATE production_tasks
SET work_status = 2
WHERE status_id = 2
AND work_status = 1;


SET SQL_SAFE_UPDATES = 1;



-- ---------------------------------------------------------
-- E. INDICES PARA EL KANBAN
-- ---------------------------------------------------------

SET @exist_index_planned = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_tasks'
    AND INDEX_NAME = 'idx_tasks_planned_date'
);

SET @sql_index_planned = IF(
    @exist_index_planned = 0,
    '
    CREATE INDEX idx_tasks_planned_date
    ON production_tasks(planned_date)
    ',
    'SELECT "idx_tasks_planned_date ya existe"'
);

PREPARE stmt FROM @sql_index_planned;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;



SET @exist_index_status = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'production_tasks'
    AND INDEX_NAME = 'idx_tasks_work_status'
);


SET @sql_index_status = IF(
    @exist_index_status = 0,
    '
    CREATE INDEX idx_tasks_work_status
    ON production_tasks(work_status)
    ',
    'SELECT "idx_tasks_work_status ya existe"'
);

PREPARE stmt FROM @sql_index_status;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;